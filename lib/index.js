/**
 * dsh-server-resources — host half (Node).
 *
 * Read-only. Reads /proc and runs `df`, `du` and `find` (always argv, never a shell) and serves JSON at
 *   GET /api/dsh-server-resources/overview            CPU, RAM, swap, disks, process rankings
 *   GET /api/dsh-server-resources/disk/dirs?path=...  largest sub-folders of a path
 *   GET /api/dsh-server-resources/disk/files?path=... largest files under a path
 * Disk scans run under `ionice -c3 nice -n19`, one at a time, with a timeout and a cache.
 */
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import os from 'node:os'

export const name = 'dsh-server-resources'
export const inject = ['connection']

const BASE = '/api/dsh-server-resources'
const CLK_TCK = 100
const PAGE = 4096
const HISTORY_MAX = 90
const SCAN_TTL_MS = 5 * 60_000
const SCAN_TIMEOUT_MS = 150_000
const DENY_PREFIXES = ['/proc', '/sys', '/dev', '/run']

// ───────────────────────── pure parsers (unit-tested) ─────────────────────────

/** Jiffies of a `cpu`/`cpuN` line of /proc/stat → { busy, total, iowait, steal }. */
export function parseCpuLine(line) {
  const f = line.trim().split(/\s+/).slice(1).map(Number)
  if (f.length < 4 || f.some((n) => !Number.isFinite(n))) return null
  const [user, nice, system, idle, iowait = 0, irq = 0, softirq = 0, steal = 0] = f
  const idleAll = idle + iowait
  const total = user + nice + system + idle + iowait + irq + softirq + steal
  return { busy: total - idleAll, total, iowait, steal }
}

export function parseStat(text) {
  const out = { all: null, cores: [] }
  for (const line of text.split('\n')) {
    if (/^cpu\d+\s/.test(line)) {
      const c = parseCpuLine(line)
      if (c) out.cores.push(c)
    } else if (/^cpu\s/.test(line)) out.all = parseCpuLine(line)
  }
  return out
}

/** Percentage (0–100) between two parseCpuLine readings. */
export function cpuPercent(prev, cur) {
  if (!prev || !cur) return 0
  const dt = cur.total - prev.total
  if (dt <= 0) return 0
  return Math.max(0, Math.min(100, ((cur.busy - prev.busy) / dt) * 100))
}

export function parseMeminfo(text) {
  const m = {}
  for (const line of text.split('\n')) {
    const x = /^(\w+):\s+(\d+)/.exec(line)
    if (x) m[x[1]] = Number(x[2]) * 1024
  }
  const total = m.MemTotal ?? 0
  const available = m.MemAvailable ?? m.MemFree ?? 0
  const cache = (m.Cached ?? 0) + (m.Buffers ?? 0) + (m.SReclaimable ?? 0)
  const swapTotal = m.SwapTotal ?? 0
  const swapFree = m.SwapFree ?? 0
  return {
    total,
    available,
    used: Math.max(0, total - available),
    cache,
    free: m.MemFree ?? 0,
    shmem: m.Shmem ?? 0,
    swapTotal,
    swapUsed: Math.max(0, swapTotal - swapFree),
  }
}

/** /proc/pressure/{cpu,memory,io} → { some:{avg10,avg60,avg300}, full? } */
export function parsePressure(text) {
  const out = {}
  for (const line of text.trim().split('\n')) {
    const [kind, ...kv] = line.trim().split(/\s+/)
    if (!kind) continue
    const o = {}
    for (const p of kv) {
      const [k, v] = p.split('=')
      if (k.startsWith('avg')) o[k] = Number(v)
    }
    out[kind] = o
  }
  return out
}

/** /proc/<pid>/stat line → { comm, utime+stime (jiffies), starttime } or null. */
export function parsePidStat(text) {
  const open = text.indexOf('(')
  const close = text.lastIndexOf(')')
  if (open < 0 || close < open) return null
  const comm = text.slice(open + 1, close)
  const f = text.slice(close + 2).split(' ')
  const utime = Number(f[11])
  const stime = Number(f[12])
  const start = Number(f[19])
  if (![utime, stime, start].every(Number.isFinite)) return null
  return { comm, ticks: utime + stime, start }
}

export function parseUsers(passwd) {
  const map = new Map()
  for (const line of passwd.split('\n')) {
    const p = line.split(':')
    if (p.length > 2 && /^\d+$/.test(p[2])) map.set(Number(p[2]), p[0])
  }
  return map
}

/** Output of `df -P -B1 -T`. */
export function parseDf(text) {
  const rows = []
  const seen = new Set()
  for (const line of text.trim().split('\n').slice(1)) {
    const p = line.trim().split(/\s+/)
    if (p.length < 7) continue
    const [device, fstype, size, used, avail, , ...mount] = p
    const total = Number(size)
    if (!Number.isFinite(total) || total <= 0 || seen.has(device)) continue
    seen.add(device)
    const u = Number(used)
    rows.push({ device, fstype, mount: mount.join(' '), total, used: u, avail: Number(avail), percent: (u / total) * 100 })
  }
  return rows
}

/** Output of `du -x -B1 --max-depth=1` → { total, rows[] } without the root itself, largest first. */
export function parseDu(text, root) {
  const rows = []
  let self = 0
  for (const line of text.split('\n')) {
    const m = /^(\d+)\t(.*)$/.exec(line)
    if (!m) continue
    const bytes = Number(m[1])
    if (m[2] === root) self = bytes
    else rows.push({ path: m[2], bytes })
  }
  rows.sort((a, b) => b.bytes - a.bytes)
  return { total: self, rows }
}

/** Output of `find -printf '%s\t%T@\t%p\n'`. */
export function parseFind(text) {
  const rows = []
  for (const line of text.split('\n')) {
    const m = /^(\d+)\t([\d.]+)\t(.*)$/.exec(line)
    if (m) rows.push({ bytes: Number(m[1]), mtime: Math.round(Number(m[2]) * 1000), path: m[3] })
  }
  rows.sort((a, b) => b.bytes - a.bytes)
  return rows
}

/** Groups processes by command name (e.g. 9 "claude" → 1 row). */
export function groupProcesses(list) {
  const g = new Map()
  for (const p of list) {
    const cur = g.get(p.comm) ?? { comm: p.comm, count: 0, cpu: 0, rss: 0, swap: 0 }
    cur.count += 1
    cur.cpu += p.cpu
    cur.rss += p.rss
    cur.swap += p.swap
    g.set(p.comm, cur)
  }
  return [...g.values()]
}

// ───────────────────────── system sampling ─────────────────────────

const readText = async (p) => {
  try {
    return await readFile(p, 'utf8')
  } catch {
    return null
  }
}

let prevStat = null
let prevProcs = new Map()
let prevAt = 0
let users = null
const history = []

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
  const [statm, status, cmdline] = await Promise.all([
    readText(`${base}/statm`),
    readText(`${base}/status`),
    readText(`${base}/cmdline`),
  ])
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
    return []
  }
  const out = []
  const CHUNK = 64
  for (let i = 0; i < names.length; i += CHUNK) {
    const part = await Promise.all(names.slice(i, i + CHUNK).map((n) => readProcess(Number(n))))
    for (const p of part) if (p) out.push(p)
  }
  return out
}

function run(cmd, args, { timeoutMs = 20_000, maxBytes = 8_000_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] })
    const chunks = []
    let bytes = 0
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.stdout.on('data', (d) => {
      bytes += d.length
      if (bytes <= maxBytes) chunks.push(d)
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolve({ stdout: '', timedOut, failed: true })
    })
    child.on('close', () => {
      clearTimeout(timer)
      resolve({ stdout: Buffer.concat(chunks).toString('utf8'), timedOut, failed: false })
    })
  })
}

export async function collectOverview(now = Date.now()) {
  const [statText, memText, loadText, uptimeText, pCpu, pMem, pIo, procs, df] = await Promise.all([
    readText('/proc/stat'),
    readText('/proc/meminfo'),
    readText('/proc/loadavg'),
    readText('/proc/uptime'),
    readText('/proc/pressure/cpu'),
    readText('/proc/pressure/memory'),
    readText('/proc/pressure/io'),
    sampleProcesses(),
    run('df', ['-P', '-B1', '-T', '-x', 'tmpfs', '-x', 'devtmpfs', '-x', 'squashfs', '-x', 'overlay', '-x', 'efivarfs']),
  ])

  const stat = parseStat(statText ?? '')
  const mem = parseMeminfo(memText ?? '')
  const dtSec = prevAt ? (now - prevAt) / 1000 : 0

  const cpu = {
    percent: cpuPercent(prevStat?.all, stat.all),
    cores: stat.cores.map((c, i) => cpuPercent(prevStat?.cores[i], c)),
    iowait: prevStat?.all && stat.all ? pct(stat.all.iowait - prevStat.all.iowait, stat.all.total - prevStat.all.total) : 0,
    steal: prevStat?.all && stat.all ? pct(stat.all.steal - prevStat.all.steal, stat.all.total - prevStat.all.total) : 0,
    count: stat.cores.length || os.cpus().length,
    load: (loadText ?? '0 0 0').split(' ').slice(0, 3).map(Number),
    model: os.cpus()[0]?.model ?? '',
  }

  const list = []
  for (const p of procs) {
    const before = prevProcs.get(p.pid)
    const same = before && before.start === p.start
    const cpuPct = same && dtSec > 0 ? Math.max(0, ((p.ticks - before.ticks) / CLK_TCK / dtSec) * 100) : 0
    list.push({ ...p, cpu: cpuPct })
  }
  prevProcs = new Map(procs.map((p) => [p.pid, { ticks: p.ticks, start: p.start }]))
  prevStat = stat
  prevAt = now

  const named = await Promise.all(
    list.map(async (p) => ({ pid: p.pid, user: await userName(p.uid), comm: p.comm, cpu: round(p.cpu, 1), rss: p.rss, swap: p.swap, args: p.args.slice(0, 240) })),
  )
  const top = (key, n) => [...named].sort((a, b) => b[key] - a[key]).slice(0, n)
  const topGroup = (key, n) => groupProcesses(named).sort((a, b) => b[key] - a[key]).slice(0, n).map((g) => ({ ...g, cpu: round(g.cpu, 1) }))

  const point = { t: now, cpu: round(cpu.percent, 1), mem: round(mem.total ? (mem.used / mem.total) * 100 : 0, 1) }
  history.push(point)
  if (history.length > HISTORY_MAX) history.shift()

  return {
    host: { name: os.hostname(), kernel: os.release(), uptime: Number((uptimeText ?? '0').split(' ')[0]) || os.uptime() },
    sampledAt: now,
    cpu,
    memory: mem,
    pressure: { cpu: parsePressure(pCpu ?? ''), memory: parsePressure(pMem ?? ''), io: parsePressure(pIo ?? '') },
    disks: parseDf(df.stdout),
    processes: {
      total: named.length,
      byCpu: top('cpu', 15),
      byMem: top('rss', 15),
      bySwap: top('swap', 8).filter((p) => p.swap > 0),
      groupsByCpu: topGroup('cpu', 10),
      groupsByMem: topGroup('rss', 10),
    },
    history: [...history],
  }
}

const pct = (a, b) => (b > 0 ? Math.max(0, Math.min(100, (a / b) * 100)) : 0)
const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d

// ───────────────────────── disk scans ─────────────────────────

const scanCache = new Map()
let scanChain = Promise.resolve()

export async function safePath(input) {
  if (typeof input !== 'string' || !input.startsWith('/') || input.includes('\0')) throw new Error('invalid path')
  const real = await realpath(input)
  const info = await stat(real)
  if (!info.isDirectory()) throw new Error('not a directory')
  if (real !== '/' && DENY_PREFIXES.some((d) => real === d || real.startsWith(d + '/'))) throw new Error('path not allowed')
  return real
}

function scan(kind, path, minBytes, fresh = false) {
  const key = `${kind}:${path}:${minBytes}`
  const hit = scanCache.get(key)
  if (hit?.promise) return hit.promise
  if (!fresh && hit && Date.now() - hit.at < SCAN_TTL_MS) return Promise.resolve({ ...hit.data, cached: true })
  const job = scanChain.then(async () => {
    const t0 = Date.now()
    const nice = ['-c3', 'nice', '-n19']
    let data
    if (kind === 'dirs') {
      const r = await run('ionice', [...nice, 'du', '-x', '-B1', '--max-depth=1', '--', path], { timeoutMs: SCAN_TIMEOUT_MS })
      const { total, rows } = parseDu(r.stdout, path)
      data = { path, total, rows: rows.slice(0, 40), partial: r.timedOut || r.failed, tookMs: Date.now() - t0 }
    } else {
      const r = await run(
        'ionice',
        [...nice, 'find', path, '-xdev', '-type', 'f', '-size', `+${Math.max(1, Math.round(minBytes / 1048576))}M`, '-printf', '%s\t%T@\t%p\n'],
        { timeoutMs: SCAN_TIMEOUT_MS },
      )
      const rows = parseFind(r.stdout)
      data = { path, minBytes, found: rows.length, rows: rows.slice(0, 40), partial: r.timedOut || r.failed, tookMs: Date.now() - t0 }
    }
    data.scannedAt = Date.now()
    return data
  })
  scanChain = job.catch(() => {})
  const promise = job.then((data) => {
    scanCache.set(key, { at: Date.now(), data })
    return { ...data, cached: false }
  })
  scanCache.set(key, { promise, at: Date.now() })
  promise.catch(() => scanCache.delete(key))
  return promise
}

// ───────────────────────── routes ─────────────────────────

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

export function apply(ctx) {
  const reg = (path, fetch) =>
    ctx.effect(
      () => ctx.connection.fetch.register({ path: `${BASE}${path}`, methods: ['GET'], requestBody: 'buffered', fetch }),
      `dsh-server-resources: ${path}`,
    )

  reg('/overview', async () => {
    try {
      return json({ ok: true, value: await collectOverview() })
    } catch (e) {
      return json({ ok: false, error: String(e?.message ?? e) }, 500)
    }
  })

  const scanRoute = (kind) => async (request) => {
    const url = new URL(request.url)
    try {
      const path = await safePath(url.searchParams.get('path') ?? '/')
      const mb = Number(url.searchParams.get('minMb') ?? 100)
      const minBytes = Math.min(Math.max(Number.isFinite(mb) ? mb : 100, 1), 10_000) * 1048576
      return json({ ok: true, value: await scan(kind, path, minBytes, url.searchParams.get('fresh') === '1') })
    } catch (e) {
      return json({ ok: false, error: String(e?.message ?? e) }, 400)
    }
  }
  reg('/disk/dirs', scanRoute('dirs'))
  reg('/disk/files', scanRoute('files'))
}
