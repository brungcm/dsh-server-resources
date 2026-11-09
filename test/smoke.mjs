// Real-host smoke test: runs the actual collectors on whatever OS this is and prints a short report.
// Exits non-zero if the snapshot is unusable. Used by CI on Linux, macOS and Windows runners.
import { collectOverview, getOverview } from '../lib/index.js'

const fmt = (n) => (n / 2 ** 30).toFixed(1) + ' GB'
await getOverview()
await new Promise((r) => setTimeout(r, 2000))
const t0 = Date.now()
const o = await collectOverview()
const ms = Date.now() - t0

console.log(`platform=${o.platform}  sample=${ms} ms  uptime=${Math.round(o.host.uptime)} s`)
console.log(`cpu=${o.cpu.percent.toFixed(1)}%  logical=${o.cpu.count}  perCore=${o.cpu.cores.length}  load=${o.cpu.load.map((x) => x.toFixed(2)).join('/')}`)
console.log(`ram=${fmt(o.memory.used)} of ${fmt(o.memory.total)}  available=${fmt(o.memory.available)}  swap=${fmt(o.memory.swapUsed)} of ${fmt(o.memory.swapTotal)}`)
console.log(`disks=${o.disks.map((d) => `${d.mount} ${d.percent.toFixed(0)}% of ${fmt(d.total)}`).join(' | ')}`)
console.log(`processes=${o.processes.total}  unreadable=${o.processes.unreadable}`)
console.log('top cpu :', o.processes.groupsByCpu.slice(0, 3).map((g) => `${g.comm}×${g.count} ${g.cpu}%`).join(', '))
console.log('top ram :', o.processes.groupsByMem.slice(0, 3).map((g) => `${g.comm}×${g.count} ${fmt(g.rss)}`).join(', '))
console.log('caps    :', JSON.stringify(o.capabilities))

const fail = (m) => { console.error('SMOKE FAIL:', m); process.exit(1) }
if (!['linux', 'darwin', 'win32'].includes(o.platform)) fail('platform')
if (!(o.memory.total > 0)) fail('memory.total')
if (!(o.memory.used >= 0 && o.memory.used <= o.memory.total * 1.001)) fail('memory.used out of range')
if (!(o.cpu.count >= 1)) fail('cpu.count')
if (!(o.disks.length >= 1)) fail('no disks')
for (const d of o.disks) if (!(d.total > 0 && d.percent >= 0 && d.percent <= 100.5)) fail('bad disk ' + JSON.stringify(d))
// A container sees only its own processes (a handful); a real host has dozens.
const min = process.env.DSR_MIN_PROCESSES ? Number(process.env.DSR_MIN_PROCESSES) : 5
if (!(o.processes.total >= min)) fail('too few processes: ' + o.processes.total)
if (!(o.processes.byMem[0].rss > 0)) fail('no RSS')
if (!o.processes.byMem.some((p) => p.args && p.args.length)) fail('no command lines')
if (o.platform === 'win32' && ms > 20000) fail('sample too slow: ' + ms)
console.log('SMOKE OK')
