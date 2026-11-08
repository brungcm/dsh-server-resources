import test from 'node:test'
import assert from 'node:assert/strict'
import { parseCpuLine, cpuPercent, parseMeminfo, parsePressure, parsePidStat, parseDf, parseDu, parseFind, groupProcesses, safePath } from '../lib/index.js'

test('cpu: percentage between two readings', () => {
  const a = parseCpuLine('cpu  100 0 100 800 0 0 0 0')
  const b = parseCpuLine('cpu  200 0 200 1000 0 0 0 0')
  assert.equal(Math.round(cpuPercent(a, b)), 50)
  assert.equal(cpuPercent(null, b), 0)
  assert.equal(cpuPercent(a, a), 0)
})

test('meminfo: used = total - available; swap', () => {
  const m = parseMeminfo('MemTotal: 1000 kB\nMemAvailable: 400 kB\nMemFree: 100 kB\nSwapTotal: 200 kB\nSwapFree: 50 kB\n')
  assert.equal(m.used, 600 * 1024)
  assert.equal(m.swapUsed, 150 * 1024)
})

test('pressure', () => {
  const p = parsePressure('some avg10=1.50 avg60=2.00 avg300=3.00 total=1\nfull avg10=0.00 avg60=0.10 avg300=0.20 total=2')
  assert.equal(p.some.avg60, 2)
  assert.equal(p.full.avg300, 0.2)
})

test('pid stat: comm with spaces and parentheses', () => {
  const line = '42 (my (weird) proc) S 1 1 1 0 -1 4194304 1 0 0 0 7 3 0 0 20 0 1 0 999 1 1 0'
  const s = parsePidStat(line)
  assert.equal(s.comm, 'my (weird) proc')
  assert.equal(s.ticks, 10)
  assert.equal(s.start, 999)
  assert.equal(parsePidStat('lixo'), null)
})

test('df: skips duplicates and keeps mount points with spaces', () => {
  const rows = parseDf('Filesystem Type 1-blocks Used Available Capacity Mounted on\n/dev/sda1 ext4 1000 900 100 90% /\n/dev/sda1 ext4 1000 900 100 90% /data\n/dev/sdb ext4 2000 500 1500 25% /my disk\n')
  assert.equal(rows.length, 2)
  assert.equal(rows[0].percent, 90)
  assert.equal(rows[1].mount, '/my disk')
})

test('du: splits the total and sorts', () => {
  const r = parseDu('10\t/a/x\n300\t/a/y\n400\t/a\n', '/a')
  assert.equal(r.total, 400)
  assert.deepEqual(r.rows.map((x) => x.path), ['/a/y', '/a/x'])
})

test('find: paths with spaces, sorted by size', () => {
  const r = parseFind('5\t1700000000.5\t/p/a b\n9\t1700000000.0\t/p/c\n')
  assert.equal(r[0].path, '/p/c')
  assert.equal(r[1].path, '/p/a b')
})

test('groups processes by command', () => {
  const g = groupProcesses([{ comm: 'x', cpu: 1, rss: 10, swap: 0 }, { comm: 'x', cpu: 2, rss: 20, swap: 5 }, { comm: 'y', cpu: 0, rss: 1, swap: 0 }])
  const x = g.find((i) => i.comm === 'x')
  assert.equal(x.count, 2); assert.equal(x.rss, 30); assert.equal(x.swap, 5)
})

test('safePath: rejects /proc, relative and missing paths', async () => {
  await assert.rejects(safePath('/proc'))
  await assert.rejects(safePath('relativo'))
  await assert.rejects(safePath('/nao/existe/xyz'))
  assert.equal(await safePath('/tmp'), '/tmp')
})

import { getOverview, collectOverview } from '../lib/index.js'

test('getOverview: callers within the sampling window share one snapshot', async () => {
  const a = await getOverview()
  const b = await getOverview()
  assert.equal(a, b)
})

test('collectOverview: shape of the snapshot', async () => {
  const o = await collectOverview()
  assert.ok(o.cpu.count >= 1)
  assert.ok(o.memory.total > 0)
  assert.ok(Array.isArray(o.disks))
  assert.ok(o.processes.total > 0)
  assert.equal(typeof o.processes.unreadable, 'number')
  assert.ok(o.processes.byMem.length > 0)
})
