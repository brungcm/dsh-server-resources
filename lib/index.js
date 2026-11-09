/**
 * dsh-server-resources — host half (Node).
 *
 * Read-only. Serves JSON at
 *   GET /api/dsh-server-resources/overview             CPU, RAM, swap, disks, process rankings, platform capabilities
 *   GET /api/dsh-server-resources/disk/dirs?path=...   largest sub-folders of a path
 *   GET /api/dsh-server-resources/disk/files?path=...  largest files under a path
 *
 * Platforms: Linux (/proc + df), macOS (sysctl/vm_stat/ps/df), Windows (one PowerShell CIM call).
 * Commands are always spawned with a fixed argv, never through a shell string. Disk scans run one at a time,
 * at low priority, with a deadline and a cache.
 */
import { realpath, stat } from 'node:fs/promises'
import os from 'node:os'
import { linux } from './platform/linux.js'
import { darwin } from './platform/darwin.js'
import { win32 } from './platform/win32.js'
import { run, round } from './platform/shared.js'
import { walk } from './walker.js'
import { groupProcesses, parseDu, parseFind } from './parsers.js'

// Re-exported so tests and downstream code keep importing parsers from the package entry point.
export * from './parsers.js'

export const name = 'dsh-server-resources'
export const inject = ['connection']

const BASE = '/api/dsh-server-resources'
const HISTORY_MAX = 90
const MIN_SAMPLE_MS = 1000 // requests closer than this (or than 2x the sample cost) reuse the last sample
const SCAN_TTL_MS = 5 * 60_000
const SCAN_TIMEOUT_MS = 150_000
const MAX_QUEUED_SCANS = 4

const PLATFORMS = { linux, darwin, win32 }
export const platform = PLATFORMS[process.platform] ?? null

// ───────────────────────── overview ─────────────────────────

const history = []
let lastOverview = null
let inflightOverview = null
let initDone = null

function ensureInit() {
  initDone ??= Promise.resolve(platform?.init?.()).catch(() => {})
  return initDone
}

/** Shared, rate-limited sampler: concurrent/near-simultaneous callers get the same snapshot. */
let sampleCostMs = 0 // how long the last real sample took; slow collectors (PowerShell) widen the reuse window

export function getOverview(now = Date.now()) {
  const window = Math.max(MIN_SAMPLE_MS, sampleCostMs * 2)
  if (lastOverview && now - lastOverview.sampledAt < window) return Promise.resolve(lastOverview)
  if (!inflightOverview) {
    const t0 = Date.now()
    inflightOverview = collectOverview(now)
      .then((v) => {
        sampleCostMs = Date.now() - t0
        return (lastOverview = v)
      })
      .finally(() => {
        inflightOverview = null
      })
  }
  return inflightOverview
}

export async function collectOverview(now = Date.now(), impl = platform) {
  if (!impl) throw new Error(`unsupported platform: ${process.platform} (supported: linux, darwin, win32)`)
  if (impl === platform) await ensureInit()
  const s = await impl.sample(now)

  const named = s.processes.map((p) => ({ pid: p.pid, user: p.user ?? '', comm: p.comm, cpu: round(p.cpu, 1), rss: p.rss, swap: p.swap, args: String(p.args ?? '').slice(0, 240) }))
  const top = (key, n) => [...named].sort((a, b) => b[key] - a[key]).slice(0, n)
  const topGroup = (key, n) => groupProcesses(named).sort((a, b) => b[key] - a[key]).slice(0, n).map((g) => ({ ...g, cpu: round(g.cpu, 1) }))

  const mem = s.memory
  history.push({ t: now, cpu: round(s.cpu.percent, 1), mem: round(mem.total ? (mem.used / mem.total) * 100 : 0, 1) })
  if (history.length > HISTORY_MAX) history.shift()

  return {
    platform: impl.id,
    capabilities: impl.capabilities,
    host: { name: os.hostname(), kernel: os.release(), uptime: s.uptime },
    sampledAt: now,
    cpu: s.cpu,
    memory: mem,
    pressure: s.pressure,
    disks: s.disks,
    processes: {
      total: named.length,
      unreadable: s.unreadable ?? 0,
      byCpu: top('cpu', 15),
      byMem: top('rss', 15),
      bySwap: top('swap', 8).filter((p) => p.swap > 0),
      groupsByCpu: topGroup('cpu', 10),
      groupsByMem: topGroup('rss', 10),
    },
    history: [...history],
  }
}

// ───────────────────────── disk scans ─────────────────────────

/** Never scanned: pseudo filesystems on Linux/macOS. Windows has none of these. */
const DENY_PREFIXES = process.platform === 'win32' ? [] : ['/proc', '/sys', '/dev', '/run']
const scanCache = new Map()
let scanChain = Promise.resolve()
let queuedScans = 0

/** Path comparison is case-insensitive on Windows and macOS (default APFS), case-sensitive on Linux. */
const norm = (p) => (process.platform === 'linux' ? p : p.toLowerCase())
const isAbs = (p) => (process.platform === 'win32' ? /^[A-Za-z]:[\\/]/.test(p) || /^\\\\/.test(p) : p.startsWith('/'))

export async function safePath(input) {
  if (typeof input !== 'string' || !input || !isAbs(input) || input.includes('\0')) throw new Error('invalid path')
  const real = await realpath(input)
  const info = await stat(real)
  if (!info.isDirectory()) throw new Error('not a directory')
  const n = norm(real)
  if (real !== '/' && DENY_PREFIXES.some((d) => n === d || n.startsWith(d + '/'))) throw new Error('path not allowed')
  return real
}

async function scanLinux(kind, path, minBytes) {
  const nice = ['-c3', 'nice', '-n19']
  const t0 = Date.now()
  if (kind === 'dirs') {
    const r = await run('ionice', [...nice, 'du', '-x', '-B1', '--max-depth=1', '--', path], { timeoutMs: SCAN_TIMEOUT_MS })
    const { total, rows } = parseDu(r.stdout, path)
    return { path, total, rows: rows.slice(0, 40), partial: r.timedOut || r.failed, tookMs: Date.now() - t0 }
  }
  const r = await run('ionice', [...nice, 'find', path, '-xdev', '-type', 'f', '-size', `+${Math.max(1, Math.round(minBytes / 1048576))}M`, '-printf', '%s\t%T@\t%p\n'], { timeoutMs: SCAN_TIMEOUT_MS })
  const rows = parseFind(r.stdout)
  return { path, minBytes, found: rows.length, rows: rows.slice(0, 40), partial: r.timedOut || r.failed, tookMs: Date.now() - t0 }
}

async function scanPortable(kind, path, minBytes) {
  const t0 = Date.now()
  const w = await walk(path, { mode: kind, minBytes, deadline: Date.now() + SCAN_TIMEOUT_MS, top: 40 })
  if (kind === 'dirs') return { path, total: w.total, rows: w.rows.slice(0, 40), partial: w.partial, tookMs: Date.now() - t0 }
  return { path, minBytes, found: w.found, rows: w.rows.slice(0, 40), partial: w.partial, tookMs: Date.now() - t0 }
}

function scan(kind, path, minBytes, fresh = false) {
  const key = `${kind}:${path}:${minBytes}`
  const hit = scanCache.get(key)
  if (hit?.promise) return hit.promise
  if (!fresh && hit && Date.now() - hit.at < SCAN_TTL_MS) return Promise.resolve({ ...hit.data, cached: true })
  if (queuedScans >= MAX_QUEUED_SCANS) return Promise.reject(new Error('too many scans queued, try again in a moment'))
  queuedScans += 1
  const job = scanChain
    .then(async () => {
      const data = process.platform === 'linux' ? await scanLinux(kind, path, minBytes) : await scanPortable(kind, path, minBytes)
      data.scannedAt = Date.now()
      return data
    })
    .finally(() => {
      queuedScans -= 1
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
    ctx.effect(() => ctx.connection.fetch.register({ path: `${BASE}${path}`, methods: ['GET'], requestBody: 'buffered', fetch }), `dsh-server-resources: ${path}`)

  ensureInit()

  reg('/overview', async () => {
    try {
      return json({ ok: true, value: await getOverview() })
    } catch (e) {
      return json({ ok: false, error: String(e?.message ?? e) }, 500)
    }
  })

  const scanRoute = (kind) => async (request) => {
    const url = new URL(request.url)
    try {
      const fallback = process.platform === 'win32' ? (process.env.SystemDrive ? process.env.SystemDrive + '\\' : 'C:\\') : '/'
      const path = await safePath(url.searchParams.get('path') ?? fallback)
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
