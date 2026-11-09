/** Helpers shared by the platform collectors. */
import { spawn } from 'node:child_process'
import os from 'node:os'

/**
 * Runs a command with a fixed argv (never a shell string) and collects stdout.
 * Never rejects: failures resolve with `failed: true` so one broken tool cannot take the panel down.
 */
export function run(cmd, args, { timeoutMs = 20_000, maxBytes = 16_000_000, env } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, env: env ? { ...process.env, ...env } : process.env })
    } catch {
      resolve({ stdout: '', timedOut: false, failed: true })
      return
    }
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
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ stdout: Buffer.concat(chunks).toString('utf8'), timedOut, failed: code !== 0 && !chunks.length })
    })
  })
}

export const pct = (a, b) => (b > 0 ? Math.max(0, Math.min(100, (a / b) * 100)) : 0)
export const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d

/** Capability flags the UI uses to hide panels a platform cannot fill. */
export const caps = (over = {}) => ({
  perCoreCpu: true,
  ioWait: false,
  steal: false,
  pressure: false,
  swapPerProcess: false,
  cache: false,
  commandLine: true,
  ...over,
})

/**
 * Per-core and overall CPU % from `os.cpus()` cumulative times (ms). Works on every OS Node supports and needs
 * no external command. Keep one instance per collector: each call returns the delta since the previous call.
 */
export function createCpuSampler() {
  let prev = null
  const read = () => os.cpus().map((c) => {
    const t = c.times
    const total = t.user + t.nice + t.sys + t.idle + t.irq
    return { busy: total - t.idle, total }
  })
  return () => {
    const cur = read()
    const before = prev
    prev = cur
    if (!before || before.length !== cur.length) return { percent: 0, cores: cur.map(() => 0), model: os.cpus()[0]?.model ?? '' }
    const cores = cur.map((c, i) => {
      const dt = c.total - before[i].total
      return dt > 0 ? Math.max(0, Math.min(100, ((c.busy - before[i].busy) / dt) * 100)) : 0
    })
    const dBusy = cur.reduce((a, c, i) => a + (c.busy - before[i].busy), 0)
    const dTotal = cur.reduce((a, c, i) => a + (c.total - before[i].total), 0)
    return { percent: dTotal > 0 ? Math.max(0, Math.min(100, (dBusy / dTotal) * 100)) : 0, cores, model: os.cpus()[0]?.model ?? '' }
  }
}
