/** Linux collector: /proc + df. The reference implementation; the richest data set. */
import { readFile, readdir } from 'node:fs/promises'
import os from 'node:os'
import { parseStat, cpuPercent, parseMeminfo, parsePressure, parsePidStat, parseUsers, parseDf } from '../parsers.js'
import { run, pct, caps } from './shared.js'

let CLK_TCK = 100 // overwritten from `getconf CLK_TCK` (100 on every mainstream Linux)
let PAGE = 4096 // overwritten from `getconf PAGESIZE` (16 KB / 64 KB on some ARM64 kernels)
let users = null
let prevStat = null
let prevProcs = new Map()
let prevAt = 0

const readText = async (p) => {
  try {
    return await readFile(p, 'utf8')
  } catch {
    return null
  }
}

async function userName(uid) {
  if (!users) users = parseUsers((await readText('/etc/passwd')) ?? '')
  return users.get(uid) ?? String(uid)
}

async function readProcess(pid) {
  const base = `/proc/${pid}`
  const statText = await readText(`${base}/stat`)
  if (!statText) return null
  const st = parsePidStat(statText)
  if (!st) return null
  const [statm, status, cmdline] = await Promise.all([readText(`${base}/statm`), readText(`${base}/status`), readText(`${base}/cmdline`)])
  const rss = statm ? Number(statm.split(' ')[1]) * PAGE : 0
  const uidM = status ? /^Uid:\s+(\d+)/m.exec(status) : null
  const swapM = status ? /^VmSwap:\s+(\d+)/m.exec(status) : null
  const args = (cmdline ?? '').replace(/\0+$/, '').replace(/\0/g, ' ').trim()
  return {
    pid,
    comm: st.comm,
    ticks: st.ticks,
    start: st.start,
    rss: Number.isFinite(rss) ? rss : 0,
    swap: swapM ? Number(swapM[1]) * 1024 : 0,
    uid: uidM ? Number(uidM[1]) : -1,
    args: args || `[${st.comm}]`,
  }
}

async function sampleProcesses() {
  let names = []
  try {
    names = (await readdir('/proc')).filter((n) => /^\d+$/.test(n))
  } catch {
    return Object.assign([], { unreadable: 0 })
  }
  const out = []
  const CHUNK = 64
  for (let i = 0; i < names.length; i += CHUNK) {
    const part = await Promise.all(names.slice(i, i + CHUNK).map((n) => readProcess(Number(n))))
    for (const p of part) if (p) out.push(p)
  }
  out.unreadable = names.length - out.length // short-lived processes and hidepid; surfaced in the UI
  return out
}

export const linux = {
  id: 'linux',
  capabilities: caps({ ioWait: true, steal: true, pressure: true, swapPerProcess: true, cache: true }),

  async init() {
    const get = async (k) => Number((await run('getconf', [k], { timeoutMs: 2000 })).stdout.trim())
    const [tck, page] = await Promise.all([get('CLK_TCK'), get('PAGESIZE')])
    if (Number.isFinite(tck) && tck > 0) CLK_TCK = tck
    if (Number.isFinite(page) && page > 0) PAGE = page
  },

  /** One raw sample: { cpu, memory, uptime, pressure, disks, processes[] }. CPU % is a delta against the previous call. */
  async sample(now) {
    const [statText, memText, loadText, uptimeText, pCpu, pMem, pIo, procs, df] = await Promise.all([
      readText('/proc/stat'),
      readText('/proc/meminfo'),
      readText('/proc/loadavg'),
      readText('/proc/uptime'),
      readText('/proc/pressure/cpu'),
      readText('/proc/pressure/memory'),
      readText('/proc/pressure/io'),
      sampleProcesses(),
      run('df', ['-P', '-B1', '-T', '-x', 'tmpfs', '-x', 'devtmpfs', '-x', 'squashfs', '-x', 'overlay', '-x', 'efivarfs', '-x', 'nfs', '-x', 'nfs4', '-x', 'cifs', '-x', 'fuse.sshfs']),
    ])
    const stat = parseStat(statText ?? '')
    const dtSec = prevAt ? (now - prevAt) / 1000 : 0
    const dTotal = prevStat?.all && stat.all ? stat.all.total - prevStat.all.total : 0

    const cpu = {
      percent: cpuPercent(prevStat?.all, stat.all),
      cores: stat.cores.map((c, i) => cpuPercent(prevStat?.cores[i], c)),
      iowait: dTotal > 0 ? pct(stat.all.iowait - prevStat.all.iowait, dTotal) : 0,
      steal: dTotal > 0 ? pct(stat.all.steal - prevStat.all.steal, dTotal) : 0,
      count: stat.cores.length || os.cpus().length,
      load: (loadText ?? '0 0 0').split(' ').slice(0, 3).map(Number),
      model: os.cpus()[0]?.model ?? '',
    }

    const list = []
    for (const p of procs) {
      const before = prevProcs.get(p.pid)
      const same = before && before.start === p.start
      const cpuPct = same && dtSec > 0 ? Math.max(0, ((p.ticks - before.ticks) / CLK_TCK / dtSec) * 100) : 0
      list.push({ pid: p.pid, user: null, uid: p.uid, comm: p.comm, cpu: cpuPct, rss: p.rss, swap: p.swap, args: p.args })
    }
    prevProcs = new Map(procs.map((p) => [p.pid, { ticks: p.ticks, start: p.start }]))
    prevStat = stat
    prevAt = now
    for (const p of list) p.user = await userName(p.uid)

    return {
      cpu,
      memory: parseMeminfo(memText ?? ''),
      uptime: Number((uptimeText ?? '0').split(' ')[0]) || os.uptime(),
      pressure: { cpu: parsePressure(pCpu ?? ''), memory: parsePressure(pMem ?? ''), io: parsePressure(pIo ?? '') },
      disks: parseDf(df.stdout),
      processes: list,
      unreadable: procs.unreadable ?? 0,
    }
  },
}
