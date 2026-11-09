import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { run } from '../lib/platform/shared.js'
import { maskArgs, parseWinDate, parsePsMac, parseSwapUsage, parseLoadAvgBraces, parseFind, parseVmStat, pickMacDisks, parseDfBsd, parseMountBsd } from '../lib/parsers.js'
import { shellCandidates, PS_SCRIPT } from '../lib/platform/win32.js'
import { isAbs, norm, DENY_PREFIXES, safePath } from '../lib/index.js'
import { walk } from '../lib/walker.js'

const isWin = process.platform === 'win32'

// ───────── run(): always settles, never throws ─────────

test('run: settles at the timeout even if the child ignores the kill (no hang)', async (t) => {
  if (isWin) return t.skip('uses sh')
  const t0 = Date.now()
  const r = await run('sh', ['-c', 'sleep 5 & wait'], { timeoutMs: 400 })
  assert.equal(r.timedOut, true)
  assert.ok(Date.now() - t0 < 2000, 'resolved long before the 5 s sleep ended: ' + (Date.now() - t0) + ' ms')
})

test('run: exit code is reported without discarding stdout', async (t) => {
  if (isWin) return t.skip('uses sh')
  const r = await run('sh', ['-c', 'echo partial; exit 3'])
  assert.equal(r.stdout.trim(), 'partial')
  assert.equal(r.code, 3)
  assert.equal(r.failed, false)
})

test('run: a missing executable is reported as failed, not thrown', async () => {
  const r = await run('definitely-not-a-real-command-xyz', [])
  assert.equal(r.failed, true)
  assert.equal(r.stdout, '')
})

test('run: output over maxBytes is cut and flagged', async (t) => {
  if (isWin) return t.skip('uses sh')
  const r = await run('sh', ['-c', 'head -c 5000 /dev/zero | tr "\\0" a'], { maxBytes: 1000 })
  assert.equal(r.truncated, true)
  assert.ok(r.stdout.length <= 1000)
})

test('run: LC_ALL=C is forced so decimals and labels do not depend on the locale', async (t) => {
  if (isWin) return t.skip('uses sh')
  assert.equal((await run('sh', ['-c', 'echo $LC_ALL'], { env: {} })).stdout.trim(), 'C')
})

// ───────── locale-proof parsing ─────────

test('parsers accept a decimal comma (pt-BR / de-DE style output)', () => {
  assert.equal(parsePsMac('  5 1 user 12,5 2048 /x/y')[0].cpu, 12.5)
  assert.equal(parseSwapUsage('total = 1024,50M  used = 10,5M').swapTotal, Math.round(1024.5 * 2 ** 20))
  assert.deepEqual(parseLoadAvgBraces('{ 1,50 2,25 3,00 }'), [1.5, 2.25, 3])
})

// ───────── Windows dates: ISO (pwsh 7 and our script) and legacy PowerShell 5.1 ─────────

test('win: dates in ISO form and in the legacy "\\/Date(ms)\\/" form', () => {
  assert.equal(parseWinDate('2026-11-09T09:49:54.740Z'), Date.parse('2026-11-09T09:49:54.740Z'))
  assert.equal(parseWinDate('\\/Date(1762682994740)\\/'), 1762682994740)
  assert.equal(parseWinDate('/Date(1762682994740+0100)/'), 1762682994740)
  assert.ok(Number.isNaN(parseWinDate('not a date')))
  assert.ok(Number.isNaN(parseWinDate(null)))
})

test('win: the script forces UTF-8 output and returns its own clock; no ExecutionPolicy trick is needed', () => {
  assert.ok(PS_SCRIPT.includes('OutputEncoding'))
  assert.ok(PS_SCRIPT.includes('UtcNow.ToUnixTimeMilliseconds'))
  assert.ok(PS_SCRIPT.includes("ToString('o')"))
})

test('win: PowerShell is located by absolute path only (a bare name would be searched in the cwd first)', () => {
  const c = shellCandidates({ SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)' })
  for (const exe of [...c.pwsh, ...c.powershell]) assert.match(exe, /^[A-Za-z]:\\/, exe)
  assert.deepEqual(c.powershell, ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'])
  assert.ok(c.pwsh.includes('C:\\Program Files\\PowerShell\\7\\pwsh.exe'))
})

// ───────── paths ─────────

test('safePath helpers: POSIX absolute paths and the deny list', (t) => {
  if (isWin) return t.skip('POSIX only')
  assert.equal(isAbs('/a/b'), true)
  assert.equal(isAbs('a/b'), false)
  assert.equal(isAbs(''), false)
  for (const d of ['/proc', '/sys', '/dev', '/run']) assert.ok(DENY_PREFIXES.includes(d))
})

test('safePath: a forbidden root that EXISTS on this machine is refused (not merely missing)', async (t) => {
  if (isWin) return t.skip('POSIX only')
  await assert.rejects(safePath('/dev'), /not allowed/)
  // /dev/shm exists on Linux only; /dev/fd exists on macOS. Test whichever child exists here.
  const { existsSync } = await import('node:fs')
  const child = ['/dev/shm', '/dev/fd'].find((p) => existsSync(p))
  if (child) await assert.rejects(safePath(child), /not allowed/)
})

test('safePath: a symlink pointing into a forbidden tree is refused', async (t) => {
  if (isWin) return t.skip('POSIX only')
  const { symlinkSync } = await import('node:fs')
  const d = mkdtempSync(join(tmpdir(), 'dsr-sl-'))
  try {
    symlinkSync('/dev', join(d, 'to-dev'), 'dir')
    await assert.rejects(safePath(join(d, 'to-dev')), /not allowed/)
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})

test('safePath: UNC / extended-length / drive-relative forms are not accepted as absolute on Windows', (t) => {
  // isAbs is evaluated for the platform the tests run on; on Windows these must all be rejected.
  if (!isWin) return t.skip('Windows only')
  for (const p of ['\\\\server\\share', '\\\\?\\C:\\Windows', '\\\\.\\PhysicalDrive0', 'C:foo', 'relative\\x']) assert.equal(isAbs(p), false, p)
  assert.equal(isAbs('C:\\Windows'), true)
  assert.equal(isAbs('c:/Windows'), true)
})

test('norm: case-sensitive on Linux, case-insensitive elsewhere', () => {
  assert.equal(norm('/Tmp/A'), process.platform === 'linux' ? '/Tmp/A' : '/tmp/a')
})

// ───────── command-line masking ─────────

test('maskArgs hides common secret shapes and leaves normal arguments alone', () => {
  assert.equal(maskArgs('node app.js --password hunter2 --port 80'), 'node app.js --password *** --port 80')
  assert.equal(maskArgs('DB_PASSWORD=abc123 node x.js'), 'DB_PASSWORD=*** node x.js')
  assert.equal(maskArgs('run --token="a b c" --verbose'), 'run --token="***" --verbose')
  assert.equal(maskArgs('curl -H "Authorization: Bearer abcdefghijkl123" https://a'), 'curl -H "Authorization: Bearer ***" https://a')
  assert.equal(maskArgs('psql postgres://bob:s3cret@db/x'), 'psql postgres://bob:***@db/x')
  assert.equal(maskArgs('java -Dapi.key=XYZ -jar a.jar'), 'java -Dapi.key=*** -jar a.jar')
  assert.equal(maskArgs('/usr/bin/tokenizer --verbose file.txt'), '/usr/bin/tokenizer --verbose file.txt')
  assert.equal(maskArgs('git status'), 'git status')
  assert.equal(maskArgs(null), '')
})

// ───────── find output in 512-byte blocks (allocated size, same as du and the walker) ─────────

test('parseFind converts 512-byte blocks to bytes', () => {
  const rows = parseFind('8\t1700000000.5\t/p/a b\n2048\t1700000000.0\t/p/c\n', 512)
  assert.equal(rows[0].bytes, 2048 * 512)
  assert.equal(rows[1].path, '/p/a b')
})

// ───────── macOS disks: container math, DMGs, nobrowse ─────────

test('mac disks: a mounted read-only disk image never becomes a volume of its own', () => {
  const df = parseDfBsd(`Filesystem 1024-blocks Used Available Capacity Mounted on
/dev/disk3s1s1 976490576 12000000 400000000 3% /
/dev/disk3s5 976490576 560000000 400000000 59% /System/Volumes/Data
/dev/disk5s1 204800 204700 100 100% /Volumes/Installer
/dev/disk6s1 976490576 1 2 1% /Volumes/External`)
  const mount = parseMountBsd(`/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)
/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse, protect)
/dev/disk5s1 on /Volumes/Installer (hfs, local, nodev, nosuid, read-only, noowners)
/dev/disk6s1 on /Volumes/External (apfs, local, nodev, nosuid, journaled)`)
  const picked = pickMacDisks(df, mount)
  const mounts = picked.map((r) => r.mount)
  assert.ok(mounts.includes('/') && mounts.includes('/Volumes/External'))
  assert.ok(!mounts.includes('/Volumes/Installer'), 'DMG at 100% is hidden')
  assert.ok(!mounts.includes('/System/Volumes/Data'))
  const root = picked.find((r) => r.mount === '/')
  assert.equal(root.used + root.avail, root.total)
  assert.equal(root.avail, 400000000 * 1024)
})

// ───────── walker: loose files, hard links, unreadable folders, budget ─────────

test('walker: random data so compressed or sparse filesystems cannot shrink the numbers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsr-rw-'))
  try {
    writeFileSync(join(root, 'big.bin'), randomBytes(600_000))
    mkdirSync(join(root, 'sub'))
    writeFileSync(join(root, 'sub', 'x.bin'), randomBytes(200_000))
    const r = await walk(root, { mode: 'dirs', deadline: Date.now() + 20_000 })
    assert.equal(r.rows[0].path, join(root, 'big.bin'), 'a loose file in the root is listed like any child')
    assert.ok(r.rows[0].bytes >= 600_000 * 0.9)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('walker: a hard link is counted once', async (t) => {
  const { linkSync } = await import('node:fs')
  const root = mkdtempSync(join(tmpdir(), 'dsr-hl-'))
  try {
    writeFileSync(join(root, 'a.bin'), randomBytes(400_000))
    try {
      linkSync(join(root, 'a.bin'), join(root, 'b.bin'))
    } catch {
      return t.skip('hard links not permitted here')
    }
    const r = await walk(root, { mode: 'dirs', deadline: Date.now() + 20_000 })
    assert.ok(r.total < 400_000 * 1.6, 'not double counted: ' + r.total)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('walker: unreadable folders are counted in `skipped`, not hidden', async (t) => {
  if (isWin || (process.getuid && process.getuid() === 0)) return t.skip('needs a non-root POSIX user')
  const { chmodSync } = await import('node:fs')
  const root = mkdtempSync(join(tmpdir(), 'dsr-sk-'))
  try {
    mkdirSync(join(root, 'locked'))
    writeFileSync(join(root, 'locked', 'f'), 'x')
    chmodSync(join(root, 'locked'), 0o000)
    const r = await walk(root, { mode: 'dirs', deadline: Date.now() + 20_000 })
    assert.ok(r.skipped >= 1, 'skipped=' + r.skipped)
  } finally {
    const { chmodSync: ch } = await import('node:fs')
    try { ch(join(root, 'locked'), 0o700) } catch { /* ignore */ }
    rmSync(root, { recursive: true, force: true })
  }
})

test('walker: the entry budget turns into a partial result', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsr-bud-'))
  try {
    for (let i = 0; i < 1200; i++) writeFileSync(join(root, 'f' + i), 'x')
    const r = await walk(root, { mode: 'dirs', deadline: Date.now() + 20_000, maxEntries: 500 })
    assert.equal(r.partial, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
