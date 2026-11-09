/**
 * macOS collector. Everything comes from tools that ship with the OS: `sysctl`, `vm_stat`, `ps`, `df`, `mount`.
 *
 * What is different from Linux
 *  - Memory "used" follows Activity Monitor (app + wired + compressed), not "total - free".
 *  - Swap is a pool managed by the OS (`vm.swapusage`); it is 0 until memory pressure forces it, which is normal.
 *  - Overall and per-core CPU come from `os.cpus()` deltas. Per-process CPU is `ps %cpu`, a decaying average
 *    (it lags a sudden spike, which is why the UI says so).
 *  - No I/O wait, steal or pressure counters from user space: the UI hides those panels.
 *  - Per-process swap is not exposed; the Swap ranking is hidden.
 */
import os from 'node:os'
import { parseVmStat, parseSwapUsage, parseLoadAvgBraces, parsePsMac, parsePsCommands, parseDfBsd, parseMountBsd, pickMacDisks } from '../parsers.js'
import { run, caps, createCpuSampler } from './shared.js'

let totalMem = os.totalmem()
const cpuSampler = createCpuSampler()

export const darwin = {
  id: 'darwin',
  capabilities: caps({ perCoreCpu: true, cache: true, commandLine: true }),

  async init() {
    const r = await run('sysctl', ['-n', 'hw.memsize'], { timeoutMs: 3000 })
    const n = Number(r.stdout.trim())
    if (Number.isFinite(n) && n > 0) totalMem = n
  },

  async sample(now) {
    const [vm, swap, load, ps, cmds, df, mount, up] = await Promise.all([
      run('vm_stat', [], { timeoutMs: 5000 }),
      run('sysctl', ['-n', 'vm.swapusage'], { timeoutMs: 3000 }),
      run('sysctl', ['-n', 'vm.loadavg'], { timeoutMs: 3000 }),
      run('ps', ['-axo', 'pid=,ppid=,user=,pcpu=,rss=,comm='], { timeoutMs: 10_000 }),
      run('ps', ['-axww', '-o', 'pid=,command='], { timeoutMs: 10_000 }),
      run('df', ['-k', '-P', '-l'], { timeoutMs: 10_000 }), // -l: local volumes only; a dead NFS/SMB mount must never block the sample
      run('mount', [], { timeoutMs: 5000 }),
      run('sysctl', ['-n', 'kern.boottime'], { timeoutMs: 3000 }),
    ])

    const memory = { ...parseVmStat(vm.stdout, totalMem), ...parseSwapUsage(swap.stdout) }
    const full = parsePsCommands(cmds.stdout)
    const list = parsePsMac(ps.stdout).map((p) => ({
      pid: p.pid,
      user: p.user,
      comm: p.comm,
      cpu: p.cpu,
      rss: p.rss,
      swap: 0,
      args: full.get(p.pid) ?? p.exe,
    }))

    const cpus = os.cpus()
    const boot = /sec\s*=\s*(\d+)/.exec(up.stdout)
    const cores = cpus.length || 1
    // `os.loadavg()` works on macOS, but the sysctl form is what Activity Monitor/`uptime` print; use it when available.
    const loadAvg = load.stdout.trim() ? parseLoadAvgBraces(load.stdout) : os.loadavg()
    const sampled = cpuSampler()
    return {
      cpu: { percent: sampled.percent, cores: sampled.cores, iowait: 0, steal: 0, count: cores, load: loadAvg, model: sampled.model },
      memory,
      uptime: boot ? Math.max(0, Math.floor(now / 1000 - Number(boot[1]))) : os.uptime(),
      pressure: {},
      disks: pickMacDisks(parseDfBsd(df.stdout), parseMountBsd(mount.stdout)),
      processes: list,
      unreadable: 0,
    }
  },
}
