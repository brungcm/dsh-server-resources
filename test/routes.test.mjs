import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { apply, getOverview } from '../lib/index.js'

function mount() {
  const routes = {}
  apply({ connection: { fetch: { register: (r) => { routes[r.path] = r; return async () => {} } } }, effect: (f) => f() })
  const call = async (path, query = '') => {
    const res = await routes['/api/dsh-server-resources' + path].fetch(new Request('http://x' + path + '?' + query))
    return { status: res.status, body: await res.json(), headers: res.headers }
  }
  return { routes, call }
}

test('routes: registered as exact GET routes under /api/dsh-server-resources', () => {
  const { routes } = mount()
  assert.deepEqual(Object.keys(routes).sort(), ['/api/dsh-server-resources/disk/dirs', '/api/dsh-server-resources/disk/files', '/api/dsh-server-resources/overview'])
  for (const r of Object.values(routes)) {
    assert.deepEqual(r.methods, ['GET'])
    assert.equal(r.requestBody, 'buffered')
  }
})

test('overview route: ok shape, no-store, platform and capabilities present', async () => {
  const { call } = mount()
  const { status, body, headers } = await call('/overview')
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(headers.get('cache-control'), 'no-store')
  assert.ok(['linux', 'darwin', 'win32'].includes(body.value.platform))
  assert.equal(typeof body.value.capabilities.perCoreCpu, 'boolean')
  assert.ok(body.value.processes.total > 0)
})

test('overview: the shared sampler returns one snapshot to near-simultaneous callers', async () => {
  const [a, b, c] = await Promise.all([getOverview(), getOverview(), getOverview()])
  assert.equal(a, b)
  assert.equal(b, c)
})

test('overview: the first sample is not added to the history (no CPU delta yet)', async () => {
  const o = await getOverview()
  for (const p of o.history) assert.ok(p.cpu >= 0 && p.cpu <= 100)
})

test('disk routes: bad paths are HTTP 400 with a message, never a stack trace', async () => {
  const { call } = mount()
  for (const q of ['path=relative', 'path=', 'path=' + encodeURIComponent('/definitely/not/here/' + Date.now())]) {
    const { status, body } = await call('/disk/dirs', q)
    assert.equal(status, 400, q)
    assert.equal(body.ok, false)
    assert.equal(typeof body.error, 'string')
    assert.ok(!/\n\s+at /.test(body.error), 'no stack trace')
  }
})

test('disk routes: dirs and files over a real temporary tree', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsr-route-'))
  try {
    mkdirSync(join(root, 'a'))
    mkdirSync(join(root, 'b'))
    writeFileSync(join(root, 'a', 'big.bin'), randomBytes(1_500_000))
    writeFileSync(join(root, 'b', 'small.bin'), randomBytes(50_000))
    writeFileSync(join(root, 'loose.bin'), randomBytes(300_000)) // loose file in the scanned root: must be listed (du -a / walker)
    const { call } = mount()

    const dirs = await call('/disk/dirs', 'path=' + encodeURIComponent(root) + '&fresh=1')
    assert.equal(dirs.status, 200)
    const names = dirs.body.value.rows.map((r) => r.path.split(/[\\/]/).pop())
    assert.deepEqual(names.slice(0, 3), ['a', 'loose.bin', 'b'], 'largest first, loose file included')
    assert.equal(dirs.body.value.partial, false)
    assert.equal(dirs.body.value.cached, false)

    const again = await call('/disk/dirs', 'path=' + encodeURIComponent(root))
    assert.equal(again.body.value.cached, true, 'second call comes from the cache')

    const files = await call('/disk/files', 'path=' + encodeURIComponent(root) + '&minMb=1&fresh=1')
    assert.equal(files.status, 200)
    assert.equal(files.body.value.found, 1)
    assert.match(files.body.value.rows[0].path, /big\.bin$/)
    assert.ok(files.body.value.rows[0].bytes >= 1_400_000)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('disk routes: minMb is clamped (no negative or absurd thresholds)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsr-clamp-'))
  try {
    const { call } = mount()
    for (const q of ['minMb=-5', 'minMb=abc', 'minMb=99999999']) {
      const r = await call('/disk/files', 'path=' + encodeURIComponent(root) + '&fresh=1&' + q)
      assert.equal(r.status, 200, q)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('disk routes: a burst never leaves the queue stuck (counter is released after errors)', async () => {
  const { call } = mount()
  for (let i = 0; i < 12; i++) await call('/disk/dirs', 'path=' + encodeURIComponent('/nope/' + i + '/' + Date.now()))
  const root = mkdtempSync(join(tmpdir(), 'dsr-burst-'))
  try {
    writeFileSync(join(root, 'f'), 'x')
    const ok = await call('/disk/dirs', 'path=' + encodeURIComponent(root) + '&fresh=1')
    assert.equal(ok.status, 200)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('disk routes: more than 4 distinct scans waiting at once → the extras get HTTP 429', async () => {
  const roots = []
  try {
    for (let i = 0; i < 9; i++) {
      const r = mkdtempSync(join(tmpdir(), 'dsr-q' + i + '-'))
      for (let k = 0; k < 200; k++) writeFileSync(join(r, 'f' + k), 'x')
      roots.push(r)
    }
    const { call } = mount()
    const results = await Promise.all(roots.map((r) => call('/disk/dirs', 'path=' + encodeURIComponent(r) + '&fresh=1')))
    const busy = results.filter((r) => r.status === 429)
    const ok = results.filter((r) => r.status === 200)
    assert.ok(ok.length >= 1, 'some scans succeed')
    assert.ok(busy.length >= 1, 'the overflow is refused with 429 (got ' + results.map((r) => r.status).join(',') + ')')
    for (const r of busy) assert.match(r.body.error, /too many scans/)
  } finally {
    for (const r of roots) rmSync(r, { recursive: true, force: true })
  }
})
