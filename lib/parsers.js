/**
 * Pure text → data parsers for every supported platform. No I/O here: each function takes the raw
 * output of a system command (or file) and returns plain objects, so they are unit-tested against
 * real samples in test/fixtures.
 */

// ───────────────────────── Linux: /proc ─────────────────────────

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

/** Percentage (0–100) between two { busy, total } readings. */
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

// ───────────────────────── df (Linux and macOS) ─────────────────────────

/** Output of GNU `df -P -B1 -T` (Linux): device, type, size, used, avail, %, mount. */
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

/** Output of BSD `df -k -P` (macOS): device, 1024-blocks, used, avail, capacity, mount. */
export function parseDfBsd(text) {
  const rows = []
  const seen = new Set()
  for (const line of text.trim().split('\n').slice(1)) {
    const m = /^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+\d+%\s+(.+)$/.exec(line.trim())
    if (!m) continue
    const [, device, blocks, used, avail, mount] = m
    const total = Number(blocks) * 1024
    if (total <= 0 || seen.has(device)) continue
    seen.add(device)
    rows.push({ device, fstype: '', mount, total, used: Number(used) * 1024, avail: Number(avail) * 1024, percent: (Number(used) / Number(blocks)) * 100 })
  }
  return rows
}

/** `mount` on macOS → Map(mountpoint → { fstype, flags[] }). */
export function parseMountBsd(text) {
  const map = new Map()
  for (const line of text.split('\n')) {
    const m = /^(\S+) on (.+) \(([^)]*)\)\s*$/.exec(line)
    if (!m) continue
    const [fstype, ...flags] = m[3].split(',').map((s) => s.trim())
    map.set(m[2], { device: m[1], fstype, flags })
  }
  return map
}

/**
 * macOS exposes one APFS container through several volumes that all report the same capacity.
 * Keep the user-visible ones: skip system/hidden mounts and read-only system snapshots, and
 * collapse volumes of one container (same total and same free space) to the most informative.
 */
export function pickMacDisks(dfRows, mounts) {
  const kept = []
  for (const r of dfRows) {
    const info = mounts.get(r.mount)
    if (r.mount.startsWith('/System/Library') || r.mount === '/dev') continue
    if (r.mount.startsWith('/System/Volumes/') && r.mount !== '/System/Volumes/Data') continue
    if (info?.flags.includes('nobrowse') && r.mount !== '/System/Volumes/Data') continue
    if (info?.flags.includes('read-only') && r.mount !== '/') continue // mounted disk images (DMG installers) sit at 100% and are not yours to free
    if (/^(map |devfs)/.test(r.device) || r.total < 64 * 1024 * 1024) continue
    kept.push({ ...r, fstype: info?.fstype ?? r.fstype })
  }
  // APFS: "/" (sealed system volume) and "/System/Volumes/Data" share one container. Show "/" with the container's
  // real occupancy: everything that is not free.
  const data = kept.find((r) => r.mount === '/System/Volumes/Data')
  const root = kept.find((r) => r.mount === '/')
  if (data && root) {
    return kept
      .filter((r) => r !== data)
      .map((r) => (r === root ? { ...r, used: Math.max(0, r.total - data.avail), avail: data.avail, percent: (Math.max(0, r.total - data.avail) / r.total) * 100 } : r))
  }
  return kept
}

// ───────────────────────── macOS: vm_stat / sysctl / ps ─────────────────────────

/** `vm_stat` → memory figures in bytes. Used = app + wired + compressor, like Activity Monitor. */
export function parseVmStat(text, totalBytes) {
  const page = Number(/page size of (\d+) bytes/.exec(text)?.[1] ?? 16384)
  const n = (label) => {
    const m = new RegExp('^' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':\\s+(\\d+)\\.?', 'm').exec(text)
    return m ? Number(m[1]) : 0
  }
  const free = n('Pages free')
  const active = n('Pages active')
  const inactive = n('Pages inactive')
  const speculative = n('Pages speculative')
  const wired = n('Pages wired down')
  const purgeable = n('Pages purgeable')
  const fileBacked = n('File-backed pages')
  const compressor = n('Pages occupied by compressor')
  const anonymous = n('Anonymous pages')
  // Activity Monitor's "Memory Used" = App Memory (anonymous − purgeable) + wired + compressed. `active` includes
  // file-backed pages, so it is only the fallback for a vm_stat that has no "Anonymous pages" line.
  const used = (anonymous ? Math.max(0, anonymous - purgeable) + wired + compressor : active + wired + compressor) * page
  const cache = (fileBacked + purgeable) * page
  const available = Math.max(0, (free + inactive + speculative + purgeable) * page)
  return {
    total: totalBytes,
    available: Math.min(totalBytes || available, available),
    used: totalBytes ? Math.min(totalBytes, used) : used,
    cache,
    free: free * page,
    shmem: 0,
    compressed: compressor * page,
    wired: wired * page,
  }
}

/** `sysctl -n vm.swapusage` → { total, used } bytes. Example: "total = 0.00M  used = 0.00M  free = 0.00M  (encrypted)". */
export function parseSwapUsage(text) {
  const grab = (k) => {
    const m = new RegExp(k + '\\s*=\\s*([\\d.,]+)([KMGT]?)', 'i').exec(text)
    if (!m) return 0
    const mult = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[m[2].toUpperCase()]
    return Math.round(Number(m[1].replace(',', '.')) * mult)
  }
  return { swapTotal: grab('total'), swapUsed: grab('used') }
}

/** `sysctl -n vm.loadavg` → [1m, 5m, 15m]. Example: "{ 82.51 42.26 17.33 }". */
export function parseLoadAvgBraces(text) {
  const nums = (text.match(/[\d.,]+/g) ?? []).slice(0, 3).map((x) => Number(x.replace(',', '.')))
  return nums.length === 3 && nums.every(Number.isFinite) ? nums : [0, 0, 0]
}

/**
 * `ps -axo pid=,ppid=,user=,pcpu=,rss=,comm=` (macOS). Columns before the command are fixed-width
 * tokens; the command (an absolute path that may contain spaces) is the rest of the line.
 * The short name is the last path component of the executable.
 */
export function parsePsMac(text) {
  const out = []
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+([\d.,]+)\s+(\d+)\s+(.+?)\s*$/.exec(line)
    if (!m) continue
    const exe = m[6]
    const name = exe.split('/').filter(Boolean).pop() ?? exe
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), user: m[3], cpu: Number(m[4].replace(',', '.')), rss: Number(m[5]) * 1024, comm: name.slice(0, 64), exe })
  }
  return out
}

/** `ps -axww -o pid=,command=` → Map(pid → full command line). */
export function parsePsCommands(text) {
  const map = new Map()
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line)
    if (m) map.set(Number(m[1]), m[2])
  }
  return map
}

// ───────────────────────── Windows: PowerShell JSON ─────────────────────────

/** PowerShell's `ConvertTo-Json` emits an object for one row and an array for several: normalise. */
export function asArray(x) {
  return x == null ? [] : Array.isArray(x) ? x : [x]
}

export function parseJsonLoose(text) {
  const t = String(text ?? '').replace(/^\uFEFF/, '').trim()
  if (!t) return null
  try {
    return JSON.parse(t)
  } catch {
    return null
  }
}

/**
 * Date → epoch ms. Accepts ISO 8601 (what the script emits), and the legacy Windows PowerShell 5.1 JSON form
 * "\/Date(1762682994740)\/" (with or without an offset) in case a host serialises it that way. NaN if unreadable.
 */
export function parseWinDate(value) {
  if (typeof value === 'number') return value
  const t = String(value ?? '')
  const legacy = /\\?\/Date\((-?\d+)(?:[+-]\d{4})?\)\\?\//.exec(t)
  if (legacy) return Number(legacy[1])
  const ms = Date.parse(t)
  return Number.isFinite(ms) ? ms : NaN
}

/** Win32_OperatingSystem (KB values) + Win32_PageFileUsage (MB values) → memory snapshot in bytes. */
export function parseWinMemory(os, pagefiles) {
  const o = os ?? {}
  const total = (o.TotalVisibleMemorySize ?? 0) * 1024
  const available = (o.FreePhysicalMemory ?? 0) * 1024
  const swapTotal = asArray(pagefiles).reduce((a, p) => a + (p.AllocatedBaseSize ?? 0), 0) * 1024 * 1024
  const swapUsed = asArray(pagefiles).reduce((a, p) => a + (p.CurrentUsage ?? 0), 0) * 1024 * 1024
  return { total, available, used: Math.max(0, total - available), cache: 0, free: available, shmem: 0, swapTotal, swapUsed }
}

/** Win32_LogicalDisk → disk rows. DriveType 3 = local fixed disk. */
export function parseWinDisks(disks) {
  const rows = []
  for (const d of asArray(disks)) {
    if (d.DriveType !== 3 || !d.Size) continue
    const used = d.Size - (d.FreeSpace ?? 0)
    rows.push({ device: d.DeviceID, fstype: d.FileSystem ?? '', mount: d.DeviceID + '\\', label: d.VolumeName ?? '', total: d.Size, used, avail: d.FreeSpace ?? 0, percent: (used / d.Size) * 100 })
  }
  return rows
}

/**
 * Win32_Process rows → processes. KernelModeTime/UserModeTime are in 100 ns units; WorkingSetSize is bytes;
 * PageFileUsage is in KB (private committed memory, the closest thing Windows has to "swap used" per process).
 */
export function parseWinProcesses(rows) {
  const out = []
  for (const p of asArray(rows)) {
    if (typeof p.ProcessId !== 'number') continue
    const name = String(p.Name ?? '').replace(/\.exe$/i, '')
    out.push({
      pid: p.ProcessId,
      comm: name || String(p.ProcessId),
      ticks100ns: (Number(p.KernelModeTime) || 0) + (Number(p.UserModeTime) || 0),
      start: p.CreationDate ? String(p.CreationDate) : '',
      rss: Number(p.WorkingSetSize) || 0,
      swap: (Number(p.PageFileUsage) || 0) * 1024,
      args: p.CommandLine ? String(p.CommandLine) : name,
    })
  }
  return out
}

// ───────────────────────── disk scans (GNU du / find; kept for Linux) ─────────────────────────

/** Output of `du -x -B1 --max-depth=1` → { total, rows[] } without the root itself, largest first. */
export function parseDu(text, root, unit = 1) {
  const rows = []
  let self = 0
  for (const line of text.split('\n')) {
    const m = /^(\d+)\t(.*)$/.exec(line)
    if (!m) continue
    const bytes = Number(m[1]) * unit
    if (m[2] === root) self = bytes
    else rows.push({ path: m[2], bytes })
  }
  rows.sort((a, b) => b.bytes - a.bytes)
  return { total: self, rows }
}

/** macOS: `find … -exec stat -f '%b|%m|%N' {} +` → [{ bytes (allocated), mtime (ms), path }], largest first. */
export function parseStatLines(text) {
  const rows = []
  for (const line of text.split('\n')) {
    const a = line.indexOf('|')
    const b = line.indexOf('|', a + 1)
    if (a < 1 || b < 0) continue
    const blocks = Number(line.slice(0, a))
    const mtime = Number(line.slice(a + 1, b))
    const path = line.slice(b + 1)
    if (Number.isFinite(blocks) && Number.isFinite(mtime) && path) rows.push({ bytes: blocks * 512, mtime: mtime * 1000, path })
  }
  rows.sort((x, y) => y.bytes - x.bytes)
  return rows
}

/** Output of `find -printf '%b\t%T@\t%p\n'` (512-byte blocks: pass `unit = 512`) or `%s` (bytes, `unit = 1`). */
export function parseFind(text, unit = 1) {
  const rows = []
  for (const line of text.split('\n')) {
    const m = /^(\d+)\t([\d.]+)\t(.*)$/.exec(line)
    if (m) rows.push({ bytes: Number(m[1]) * unit, mtime: Math.round(Number(m[2]) * 1000), path: m[3] })
  }
  rows.sort((a, b) => b.bytes - a.bytes)
  return rows
}

// ───────────────────────── shared ─────────────────────────

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

// ───────────────────────── command lines ─────────────────────────

const SECRET_WORD = '(?:pass(?:word|wd)?|pwd|secret|token|api[-_.]?key|access[-_.]?key|private[-_.]?key|credential|authorization|auth)'
const RE_ENV = new RegExp(`\\b([A-Za-z0-9_.]*${SECRET_WORD}[A-Za-z0-9_.]*)=("[^"]*"|'[^']*'|\\S+)`, 'gi')
const RE_FLAG = new RegExp(`(\\s--?[A-Za-z0-9_.-]*${SECRET_WORD}[A-Za-z0-9_.-]*)\\s+("[^"]*"|'[^']*'|[^\\s-]\\S*)`, 'gi')
const RE_BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi
const RE_URL_CRED = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+@/gi

/**
 * Best-effort masking of secrets in a process command line: `KEY=value` where the key looks like a secret,
 * `--password value` style flags, `Bearer xxx` tokens and `scheme://user:pass@host`. It is a safety net, not a
 * guarantee — a secret passed as a bare positional argument cannot be recognised.
 */
export function maskArgs(text) {
  return String(text ?? '')
    .replace(RE_URL_CRED, '$1***@')
    .replace(RE_BEARER, '$1 ***')
    .replace(RE_ENV, (_, k, v) => `${k}=${v.startsWith('"') ? '"***"' : v.startsWith("'") ? "'***'" : '***'}`)
    .replace(RE_FLAG, '$1 ***')
}
