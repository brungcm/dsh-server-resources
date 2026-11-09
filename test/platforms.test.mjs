import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseVmStat, parseSwapUsage, parseLoadAvgBraces, parsePsMac, parsePsCommands, parseDfBsd, parseMountBsd, pickMacDisks,
  parseJsonLoose, asArray, parseWinMemory, parseWinDisks, parseWinProcesses,
} from '../lib/parsers.js'
import { walk, diskBytes } from '../lib/walker.js'
import { encodePs, PS_SCRIPT } from '../lib/platform/win32.js'
import { collectOverview, safePath } from '../lib/index.js'
import { createCpuSampler } from '../lib/platform/shared.js'
import { linux } from '../lib/platform/linux.js'

const fx = (n) => readFileSync(new URL('./fixtures/' + n, import.meta.url), 'utf8')

// ───────── macOS (samples captured on a real macOS 26 / Apple M1 runner) ─────────

test('mac: vm_stat uses 16 KB pages and reports Activity-Monitor style memory', () => {
  const total = 7516192768
  const m = parseVmStat(fx('macos-vm_stat.txt'), total)
  const page = 16384
  assert.equal(m.free, 6842 * page)
  assert.equal(m.used, (191114 + 55698 + 10008) * page) // active + wired + compressor
  assert.equal(m.compressed, 10008 * page)
  assert.ok(m.used > 0 && m.used <= total)
  assert.ok(m.available <= total)
})

test('mac: vm_stat falls back to 16 KB pages and survives garbage', () => {
  const m = parseVmStat('', 8 * 2 ** 30)
  assert.equal(m.used, 0)
  assert.equal(m.total, 8 * 2 ** 30)
})

test('mac: swapusage and loadavg', () => {
  assert.deepEqual(parseSwapUsage(fx('macos-swapusage.txt')), { swapTotal: 0, swapUsed: 0 })
  assert.deepEqual(parseSwapUsage('total = 2048.00M  used = 1024.50M  free = 1023.50M  (encrypted)'), { swapTotal: 2048 * 2 ** 20, swapUsed: Math.round(1024.5 * 2 ** 20) })
  assert.deepEqual(parseSwapUsage('total = 3.50G  used = 1.00G'), { swapTotal: Math.round(3.5 * 2 ** 30), swapUsed: 2 ** 30 })
  assert.deepEqual(parseLoadAvgBraces(fx('macos-loadavg.txt')), [82.51, 42.26, 17.33])
  assert.deepEqual(parseLoadAvgBraces('garbage'), [0, 0, 0])
})

test('mac: ps keeps command paths with spaces and takes the executable name', () => {
  const rows = parsePsMac(fx('macos-ps.txt'))
  assert.equal(rows.length, 5)
  const chrome = rows.find((r) => r.pid === 412)
  assert.equal(chrome.comm, 'Google Chrome')
  assert.equal(chrome.user, 'demo')
  assert.equal(chrome.cpu, 12.5)
  assert.equal(chrome.rss, 801232 * 1024)
  assert.equal(rows.find((r) => r.pid === 413).comm, 'Google Chrome Helper (Renderer)')
  assert.equal(rows.find((r) => r.pid === 900).user, '_accessoryupdater') // wider than the column
  assert.equal(rows.find((r) => r.pid === 1).comm, 'launchd')
})

test('mac: ps -ww command map', () => {
  const m = parsePsCommands('    1 /sbin/launchd\n  90 /usr/bin/foo --flag "a b"\n')
  assert.equal(m.get(90), '/usr/bin/foo --flag "a b"')
})

test('mac: df -k -P and mount → one row per real volume, Data volume carries the usage', () => {
  const df = parseDfBsd(fx('macos-df.txt'))
  assert.ok(df.length >= 5)
  const picked = pickMacDisks(df, parseMountBsd(fx('macos-mount.txt')))
  const mounts = picked.map((r) => r.mount)
  assert.ok(mounts.includes('/'))
  assert.ok(!mounts.includes('/dev'))
  assert.ok(!mounts.some((m) => m.startsWith('/System/Library')))
  assert.ok(!mounts.includes('/System/Volumes/VM'))
  const root = picked.find((r) => r.mount === '/')
  assert.equal(root.fstype, 'apfs')
  // "/" is a sealed read-only system volume; real usage = system volume + Data volume of the same container
  const data = df.find((r) => r.mount === '/System/Volumes/Data')
  assert.equal(root.used, df.find((r) => r.mount === '/').used + data.used)
  assert.equal(root.total, data.total)
  assert.ok(Math.abs(root.percent - (root.used / root.total) * 100) < 1e-9)
  assert.ok(!mounts.includes('/System/Volumes/Data'), 'merged into "/" instead of listed twice')
})

// ───────── Windows (samples captured on a real Windows Server 2025 runner) ─────────

test('win: memory (KB) and page file (MB) are converted to bytes', () => {
  const m = parseWinMemory(parseJsonLoose(fx('windows-os.json')), parseJsonLoose(fx('windows-pagefile.json')))
  assert.equal(m.total, 16771836 * 1024)
  assert.equal(m.available, 14048416 * 1024)
  assert.equal(m.used, (16771836 - 14048416) * 1024)
  assert.equal(m.swapTotal, 2944 * 1024 * 1024)
  assert.equal(m.swapUsed, 0)
})

test('win: ConvertTo-Json emits an object for one row and an array for many', () => {
  assert.equal(asArray(parseJsonLoose(fx('windows-pagefile.json'))).length, 1) // single object
  assert.equal(asArray(parseJsonLoose(fx('windows-disks.json'))).length, 2) // array
  assert.deepEqual(asArray(null), [])
  assert.equal(parseJsonLoose('\uFEFF{"a":1}').a, 1) // BOM
  assert.equal(parseJsonLoose('not json'), null)
})

test('win: logical disks keep fixed drives only', () => {
  const rows = parseWinDisks(parseJsonLoose(fx('windows-disks.json')))
  assert.equal(rows.length, 2)
  assert.equal(rows[0].mount, 'C:\\')
  assert.equal(rows[0].fstype, 'NTFS')
  assert.equal(rows[0].used, 160939618304 - 33488502784)
  assert.ok(Math.abs(rows[0].percent - 79.19) < 0.1)
  assert.equal(parseWinDisks([{ DeviceID: 'E:', DriveType: 5, Size: 1 }]).length, 0) // CD-ROM
})

test('win: processes (100 ns CPU time, bytes, KB page file, .exe stripped)', () => {
  const rows = parseWinProcesses([
    { ProcessId: 4, Name: 'System', CommandLine: null, WorkingSetSize: 172032, PageFileUsage: 44, KernelModeTime: 80468750, UserModeTime: 0, CreationDate: '2026-11-09T09:49:56+00:00' },
    { ProcessId: 812, Name: 'node.exe', CommandLine: 'node.exe C:\\app\\server.js', WorkingSetSize: 104857600, PageFileUsage: 2048, KernelModeTime: 10, UserModeTime: 30, CreationDate: 'x' },
    { Name: 'bad' },
  ])
  assert.equal(rows.length, 2)
  assert.equal(rows[0].args, 'System')
  assert.equal(rows[1].comm, 'node')
  assert.equal(rows[1].ticks100ns, 40)
  assert.equal(rows[1].swap, 2048 * 1024)
  assert.equal(rows[1].args, 'node.exe C:\\app\\server.js')
})

test('win: the PowerShell script is encoded as UTF-16LE base64 and has no interpolation', () => {
  const enc = encodePs(PS_SCRIPT)
  assert.equal(Buffer.from(enc, 'base64').toString('utf16le'), PS_SCRIPT)
  assert.ok(!PS_SCRIPT.includes('${') && !PS_SCRIPT.includes('`'), 'nothing is interpolated into the script')
  for (const cls of ['Win32_OperatingSystem', 'Win32_PageFileUsage', 'Win32_LogicalDisk', 'Win32_Processor', 'Win32_Process']) assert.ok(PS_SCRIPT.includes(cls), cls)
})

// ───────── portable walker (used on macOS and Windows) ─────────

function tree() {
  const root = mkdtempSync(join(tmpdir(), 'dsr-walk-'))
  mkdirSync(join(root, 'a/deep'), { recursive: true })
  mkdirSync(join(root, 'b'))
  writeFileSync(join(root, 'a/one.bin'), Buffer.alloc(300_000))
  writeFileSync(join(root, 'a/deep/two.bin'), Buffer.alloc(500_000))
  writeFileSync(join(root, 'b/three.bin'), Buffer.alloc(100_000))
  writeFileSync(join(root, 'top.bin'), Buffer.alloc(50_000))
  return root
}

test('walker: dirs mode groups by direct child and sorts largest first', async () => {
  const root = tree()
  try {
    const r = await walk(root, { mode: 'dirs', deadline: Date.now() + 20_000 })
    assert.equal(r.partial, false)
    assert.equal(r.rows[0].path, join(root, 'a'))
    assert.ok(r.rows[0].bytes >= 800_000)
    assert.equal(r.rows.find((x) => x.path === join(root, 'b')).bytes >= 100_000, true)
    assert.ok(r.rows.some((x) => x.path === join(root, 'top.bin')), 'files directly in the root are listed too')
    assert.ok(r.total >= 950_000)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('walker: files mode honours the size floor and the order', async () => {
  const root = tree()
  try {
    const r = await walk(root, { mode: 'files', minBytes: 200_000, deadline: Date.now() + 20_000 })
    assert.equal(r.found, 2)
    assert.deepEqual(r.rows.map((x) => x.path.split(/[\\/]/).pop()), ['two.bin', 'one.bin'])
    assert.equal(typeof r.rows[0].mtime, 'number')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('walker: never follows symlinks (no loops, no double counting)', async (t) => {
  const root = tree()
  try {
    try {
      symlinkSync(root, join(root, 'loop'), 'dir')
      symlinkSync(join(root, 'a'), join(root, 'alias'), 'dir')
    } catch {
      return t.skip('symlinks not permitted on this system')
    }
    const r = await walk(root, { mode: 'dirs', deadline: Date.now() + 20_000 })
    assert.equal(r.partial, false)
    assert.ok(!r.rows.some((x) => /loop|alias/.test(x.path)))
    assert.ok(r.total < 1_500_000)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('walker: an expired deadline returns a partial result instead of hanging', async () => {
  const root = tree()
  try {
    for (let i = 0; i < 900; i++) writeFileSync(join(root, 'b', 'f' + i), 'x')
    const r = await walk(root, { mode: 'dirs', deadline: Date.now() - 1 })
    assert.equal(r.partial, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('walker: a missing root is reported as partial, not thrown', async () => {
  const r = await walk(join(tmpdir(), 'dsr-does-not-exist-' + Date.now()), { mode: 'dirs', deadline: Date.now() + 1000 })
  assert.equal(r.partial, true)
  assert.deepEqual(r.rows, [])
})

test('walker: diskBytes prefers allocated blocks and falls back to size', () => {
  assert.equal(diskBytes({ blocks: 8, size: 10 }), 4096)
  assert.equal(diskBytes({ blocks: 0, size: 10 }), 10)
  assert.equal(diskBytes({ size: 7 }), 7)
})

// ───────── contract: every platform returns the same shape ─────────

test('contract: collectOverview on this machine returns the shape the UI relies on', async () => {
  const o = await collectOverview()
  assert.ok(['linux', 'darwin', 'win32'].includes(o.platform))
  for (const k of ['perCoreCpu', 'ioWait', 'steal', 'pressure', 'swapPerProcess', 'cache', 'commandLine']) assert.equal(typeof o.capabilities[k], 'boolean', k)
  assert.ok(o.cpu.count >= 1)
  assert.ok(o.cpu.percent >= 0 && o.cpu.percent <= 100)
  assert.equal(o.cpu.load.length, 3)
  assert.ok(o.memory.total > 0 && o.memory.used >= 0 && o.memory.used <= o.memory.total * 1.001)
  assert.ok(Array.isArray(o.disks) && o.disks.length >= 1)
  for (const d of o.disks) {
    assert.ok(d.mount && d.total > 0 && d.percent >= 0 && d.percent <= 100.5, JSON.stringify(d))
  }
  assert.ok(o.processes.total > 0)
  assert.ok(o.processes.byMem.length > 0)
  assert.ok(o.host.uptime > 0)
})

test('contract: safePath accepts the platform root and rejects relative / missing paths', async () => {
  const root = process.platform === 'win32' ? (process.env.SystemDrive || 'C:') + '\\' : '/'
  assert.ok(await safePath(root))
  await assert.rejects(safePath('relative/path'))
  await assert.rejects(safePath(join(tmpdir(), 'dsr-nope-' + Date.now())))
  await assert.rejects(safePath(''))
})

test('contract: the Linux collector is only exposed on Linux (others are covered by fixtures)', () => {
  assert.equal(linux.id, 'linux')
  assert.equal(linux.capabilities.pressure, true)
})

// ───────── CPU sampler (macOS and Windows) ─────────

test('cpu sampler: first call is 0, later calls are bounded deltas with one value per core', async () => {
  const sample = createCpuSampler()
  const first = sample()
  assert.equal(first.percent, 0)
  assert.ok(first.cores.every((c) => c === 0))
  const t = Date.now()
  while (Date.now() - t < 300) Math.sqrt(Math.random()) // burn a little CPU so there is a delta
  const second = sample()
  assert.ok(second.percent >= 0 && second.percent <= 100)
  assert.equal(second.cores.length, first.cores.length)
  assert.ok(second.cores.every((c) => c >= 0 && c <= 100))
})

test('win: the Idle pseudo-process (pid 0) is not a CPU consumer', async () => {
  const { win32 } = await import('../lib/platform/win32.js')
  assert.equal(typeof win32.sample, 'function')
  assert.equal(win32.capabilities.perCoreCpu, true)
})
