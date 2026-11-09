// Entirely fictional data used to render the README screenshots. Nothing here comes from a real server.
const GB = 1024 ** 3, MB = 1024 ** 2
const wave = (i, base, amp, ph) => Math.max(1, Math.min(99, base + Math.sin(i / 5 + ph) * amp + Math.sin(i / 2.3 + ph * 2) * amp * 0.3))
export const overview = {
  platform: 'linux',
  capabilities: { perCoreCpu: true, ioWait: true, steal: true, pressure: true, swapPerProcess: true, cache: true, commandLine: true },
  host: { name: 'demo-server', kernel: '6.8.0-demo', uptime: 41 * 86400 + 6 * 3600 },
  sampledAt: Date.now(),
  cpu: { percent: 38, cores: [62, 41, 33, 27, 55, 19, 71, 24], iowait: 4.2, steal: 0, count: 8, load: [2.4, 2.1, 1.8], model: 'Demo CPU @ 2.60GHz' },
  memory: { total: 16 * GB, available: 5.2 * GB, used: 10.8 * GB, cache: 4.1 * GB, free: 1.1 * GB, shmem: 0.4 * GB, swapTotal: 6 * GB, swapUsed: 1.1 * GB },
  pressure: { cpu: { some: { avg10: 3, avg60: 4.2, avg300: 3.1 } }, memory: { some: { avg10: 1, avg60: 2.1, avg300: 1.4 } }, io: { some: { avg10: 22, avg60: 18.4, avg300: 12 } } },
  disks: [
    { device: '/dev/vda1', fstype: 'ext4', mount: '/', total: 80 * GB, used: 71 * GB, avail: 9 * GB, percent: 88.7 },
    { device: '/dev/vdb', fstype: 'ext4', mount: '/data', total: 200 * GB, used: 96 * GB, avail: 104 * GB, percent: 48 },
  ],
  processes: {
    total: 214, unreadable: 0,
    byCpu: [], byMem: [], bySwap: [],
    groupsByCpu: [
      { comm: 'node', count: 6, cpu: 148.2, rss: 2.1 * GB, swap: 0 }, { comm: 'postgres', count: 9, cpu: 64.5, rss: 1.3 * GB, swap: 0 },
      { comm: 'python3', count: 3, cpu: 41.0, rss: 0.9 * GB, swap: 0 }, { comm: 'nginx', count: 4, cpu: 12.3, rss: 0.2 * GB, swap: 0 },
      { comm: 'redis-server', count: 1, cpu: 8.1, rss: 0.4 * GB, swap: 0 }, { comm: 'java', count: 1, cpu: 6.7, rss: 1.6 * GB, swap: 0 },
      { comm: 'dockerd', count: 1, cpu: 3.2, rss: 0.2 * GB, swap: 0 }, { comm: 'sshd', count: 5, cpu: 0.4, rss: 0.05 * GB, swap: 0 },
    ],
    groupsByMem: [],
  },
  history: Array.from({ length: 90 }, (_, i) => ({ t: i, cpu: wave(i, 38, 22, 0), mem: wave(i, 66, 4, 1) })),
}
overview.processes.groupsByMem = [...overview.processes.groupsByCpu].sort((a, b) => b.rss - a.rss)
const row = (p, c, m) => ({ pid: p, user: 'app', comm: c, cpu: 0, rss: m, swap: 0, args: '' })

const dirs = (path, items) => ({ path, total: items.reduce((a, b) => a + b[1], 0) * 1.08, rows: items.map(([n, b]) => ({ path: (path === '/' ? '' : path) + '/' + n, bytes: b })), partial: false, tookMs: 4200, scannedAt: Date.now(), cached: false })
export const scans = {
  '/': dirs('/', [['var', 24.6 * GB], ['usr', 11.2 * GB], ['home', 9.4 * GB], ['opt', 4.1 * GB], ['srv', 2.2 * GB], ['boot', 0.3 * GB]]),
  '/var': dirs('/var', [['lib', 18.2 * GB], ['log', 3.1 * GB], ['cache', 2.4 * GB], ['tmp', 0.6 * GB]]),
}
export const files = {
  path: '/', minBytes: 100 * MB, found: 6, partial: false, tookMs: 9100, scannedAt: Date.now(), cached: false,
  rows: [
    ['/var/lib/docker/overlay2/a1b2/diff/data.bin', 6.4 * GB], ['/var/lib/postgresql/16/main/base/16384/2619', 3.9 * GB],
    ['/home/app/builds/target/release/app', 1.2 * GB], ['/var/log/journal/system.journal', 0.9 * GB], ['/opt/backups/db-2026-01.dump', 0.7 * GB], ['/var/cache/apt/archives/linux-image.deb', 0.3 * GB],
  ].map(([path, bytes], i) => ({ path, bytes, mtime: Date.UTC(2026, 0, 5 + i * 3) })),
}

// ───── fictional macOS and Windows hosts (same shape, different capabilities) ─────
const clone = (o) => JSON.parse(JSON.stringify(o))

export const overviewMac = (() => {
  const o = clone(overview)
  o.platform = 'darwin'
  o.capabilities = { perCoreCpu: false, ioWait: false, steal: false, pressure: false, swapPerProcess: false, cache: true, commandLine: true }
  o.host = { name: 'demo-macbook', kernel: 'Darwin 25.0', uptime: 6 * 86400 + 3 * 3600 }
  o.cpu = { percent: 27, cores: [], iowait: 0, steal: 0, count: 10, load: [3.1, 2.8, 2.4], model: 'Apple M-series' }
  o.memory = { total: 24 * GB, available: 7.4 * GB, used: 16.6 * GB, cache: 6.2 * GB, free: 0.3 * GB, shmem: 0, compressed: 2.9 * GB, wired: 3.4 * GB, swapTotal: 0, swapUsed: 0 }
  o.disks = [{ device: '/dev/disk3s1s1', fstype: 'apfs', mount: '/', total: 994 * GB, used: 612 * GB, avail: 382 * GB, percent: 61.6 }]
  o.processes.groupsByCpu = [
    { comm: 'Google Chrome', count: 14, cpu: 58.2, rss: 3.4 * GB, swap: 0 }, { comm: 'Xcode', count: 1, cpu: 31.5, rss: 2.2 * GB, swap: 0 },
    { comm: 'node', count: 5, cpu: 22.0, rss: 1.1 * GB, swap: 0 }, { comm: 'Slack', count: 6, cpu: 9.8, rss: 1.0 * GB, swap: 0 },
    { comm: 'WindowServer', count: 1, cpu: 7.1, rss: 0.4 * GB, swap: 0 }, { comm: 'docker', count: 3, cpu: 4.4, rss: 0.9 * GB, swap: 0 },
    { comm: 'Spotify', count: 5, cpu: 2.9, rss: 0.6 * GB, swap: 0 }, { comm: 'Finder', count: 1, cpu: 0.6, rss: 0.2 * GB, swap: 0 },
  ]
  o.processes.groupsByMem = [...o.processes.groupsByCpu].sort((a, b) => b.rss - a.rss)
  return o
})()

export const overviewWin = (() => {
  const o = clone(overview)
  o.platform = 'win32'
  o.capabilities = { perCoreCpu: false, ioWait: false, steal: false, pressure: false, swapPerProcess: true, cache: false, commandLine: true }
  o.host = { name: 'DEMO-PC', kernel: '10.0.26100', uptime: 3 * 86400 + 9 * 3600 }
  o.cpu = { percent: 44, cores: [], iowait: 0, steal: 0, count: 16, load: [0, 0, 0], model: 'Demo Ryzen 7' }
  o.memory = { total: 32 * GB, available: 11.2 * GB, used: 20.8 * GB, cache: 0, free: 11.2 * GB, shmem: 0, swapTotal: 8 * GB, swapUsed: 2.6 * GB }
  o.disks = [
    { device: 'C:', fstype: 'NTFS', mount: 'C:\\', label: 'Windows', total: 953 * GB, used: 702 * GB, avail: 251 * GB, percent: 73.7 },
    { device: 'D:', fstype: 'NTFS', mount: 'D:\\', label: 'Data', total: 1862 * GB, used: 604 * GB, avail: 1258 * GB, percent: 32.4 },
  ]
  o.processes.groupsByCpu = [
    { comm: 'chrome', count: 22, cpu: 71.4, rss: 4.1 * GB, swap: 1.6 * GB }, { comm: 'Code', count: 9, cpu: 38.2, rss: 2.7 * GB, swap: 0.9 * GB },
    { comm: 'node', count: 7, cpu: 25.5, rss: 1.4 * GB, swap: 0.4 * GB }, { comm: 'MsMpEng', count: 1, cpu: 11.9, rss: 0.3 * GB, swap: 0.1 * GB },
    { comm: 'docker', count: 4, cpu: 8.8, rss: 1.8 * GB, swap: 0.5 * GB }, { comm: 'Teams', count: 8, cpu: 6.2, rss: 1.3 * GB, swap: 0.4 * GB },
    { comm: 'explorer', count: 1, cpu: 1.4, rss: 0.2 * GB, swap: 0.1 * GB }, { comm: 'System', count: 1, cpu: 0.9, rss: 0.1 * GB, swap: 0 },
  ]
  o.processes.groupsByMem = [...o.processes.groupsByCpu].sort((a, b) => b.rss - a.rss)
  return o
})()

const winDirs = (path, items) => ({ path, total: items.reduce((a, b) => a + b[1], 0) * 1.05, rows: items.map(([n, b]) => ({ path: path.replace(/\\\\$/, '') + '\\\\' + n, bytes: b })), partial: false, tookMs: 7800, scannedAt: Date.now(), cached: false })
export const scansWin = { 'C:\\': winDirs('C:\\', [['Users', 312 * GB], ['Program Files', 96 * GB], ['Windows', 41 * GB], ['ProgramData', 28 * GB], ['Program Files (x86)', 22 * GB]]) }
const macDirs = (path, items) => ({ path, total: items.reduce((a, b) => a + b[1], 0) * 1.05, rows: items.map(([n, b]) => ({ path: (path === '/' ? '' : path) + '/' + n, bytes: b })), partial: false, tookMs: 6400, scannedAt: Date.now(), cached: false })
export const scansMac = { '/': macDirs('/', [['Users', 402 * GB], ['Applications', 88 * GB], ['Library', 54 * GB], ['opt', 21 * GB], ['usr', 14 * GB]]) }
