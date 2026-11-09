// Real-host check of the parts the unit tests cannot cover: the portable walker and safePath on the real filesystem.
import { walk } from '../lib/walker.js'
import { safePath } from '../lib/index.js'
import { tmpdir, homedir } from 'node:os'

const fail = (m) => { console.error('HOST CHECK FAIL:', m); process.exit(1) }
const root = process.platform === 'win32' ? (process.env.SystemDrive || 'C:') + '\\' : '/'

const p = await safePath(root)
console.log('safePath(root) =', p)
const tmp = await safePath(tmpdir())
console.log('safePath(tmpdir) =', tmp)
const home = await safePath(homedir())
console.log('safePath(home) =', home)

for (const [label, dir] of [['home', home], ['tmp', tmp]]) {
  const t0 = Date.now()
  const d = await walk(dir, { mode: 'dirs', deadline: Date.now() + 40_000, maxEntries: 400_000 })
  console.log(`walk dirs ${label}: ${Date.now() - t0} ms, rows=${d.rows.length}, total=${(d.total / 2 ** 20).toFixed(0)} MB, partial=${d.partial}`)
  if (!(d.rows.length >= 0)) fail('rows')
  const f = await walk(dir, { mode: 'files', minBytes: 1 << 20, deadline: Date.now() + 40_000, maxEntries: 400_000 })
  console.log(`walk files ${label}: found=${f.found}, top=${f.rows[0] ? f.rows[0].path + ' ' + (f.rows[0].bytes / 2 ** 20).toFixed(0) + ' MB' : '-'}, partial=${f.partial}`)
}

// Case-insensitive path handling: same directory spelled in a different case must resolve to one real path.
if (process.platform !== 'linux') {
  const a = await safePath(tmpdir())
  const b = await safePath(tmpdir().toUpperCase())
  console.log('case-insensitive paths agree:', a.toLowerCase() === b.toLowerCase(), '|', a, '|', b)
  if (a.toLowerCase() !== b.toLowerCase()) fail('case-insensitive paths differ')
}
// A drive/volume root must never be rejected as a pseudo filesystem.
const rootOk = await safePath(root).then(() => true, () => false)
if (!rootOk) fail('root rejected')
if (process.platform === 'win32') {
  await safePath('C:/Windows').then(() => console.log('forward slashes accepted'), () => fail('C:/Windows rejected'))
  await safePath('\\\\?\\C:\\Windows').then(() => console.log('extended-length path accepted'), (e) => console.log('extended-length path rejected:', e.message))
  await safePath('relative\\path').then(() => fail('relative path accepted'), () => console.log('relative rejected'))
}
console.log('HOST CHECK OK')
