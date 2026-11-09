/**
 * Windows collector. One PowerShell call per sample reads CIM/WMI classes and returns a single JSON document
 * (Win32_OperatingSystem, Win32_PageFileUsage, Win32_LogicalDisk, Win32_Processor, Win32_Process).
 *
 * Choices that matter
 *  - PowerShell 7 (`pwsh`) is ~15x faster to start than Windows PowerShell 5.1 (≈125 ms vs ≈1.9 s measured on a
 *    GitHub runner), so it is preferred when installed; `powershell.exe` is the fallback present on every Windows.
 *  - The script is passed with `-EncodedCommand` (UTF-16LE base64): nothing from the user or the UI is ever
 *    interpolated into it, and there is no quoting to get wrong.
 *  - CPU % per process is a delta of kernel+user time (100 ns units) between samples, divided by wall time.
 *  - "Swap" is the page file; per-process swap is the process's private committed memory (PageFileUsage).
 *  - No I/O wait, steal or pressure counters: the UI hides them.
 */
import os from 'node:os'
import { run } from './shared.js'
import { caps, pct } from './shared.js'
import { parseJsonLoose, asArray, parseWinMemory, parseWinDisks, parseWinProcesses } from '../parsers.js'

export const PS_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
$os   = Get-CimInstance Win32_OperatingSystem | Select-Object TotalVisibleMemorySize,FreePhysicalMemory,LastBootUpTime
$pf   = @(Get-CimInstance Win32_PageFileUsage | Select-Object AllocatedBaseSize,CurrentUsage)
$disk = @(Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,DriveType,FileSystem,Size,FreeSpace,VolumeName)
$cpu  = @(Get-CimInstance Win32_Processor | Select-Object Name,NumberOfLogicalProcessors,LoadPercentage)
$proc = @(Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine,WorkingSetSize,PageFileUsage,KernelModeTime,UserModeTime,CreationDate)
[pscustomobject]@{ os = $os; pagefile = $pf; disks = $disk; cpu = $cpu; procs = $proc } | ConvertTo-Json -Depth 4 -Compress
`

/** UTF-16LE base64, the encoding PowerShell's -EncodedCommand expects. */
export function encodePs(script) {
  return Buffer.from(script, 'utf16le').toString('base64')
}

let shell = null // 'pwsh' | 'powershell'
let prev = new Map() // pid → { ticks, start }
let prevAt = 0
const users = new Map()

async function pickShell() {
  const probe = async (exe) => (await run(exe, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], { timeoutMs: 8000 })).stdout.trim()
  if (/^\d+$/.test(await probe('pwsh'))) return 'pwsh'
  if (/^\d+$/.test(await probe('powershell'))) return 'powershell'
  return null
}

export const win32 = {
  id: 'win32',
  capabilities: caps({ perCoreCpu: false, commandLine: true, swapPerProcess: true, cache: false }),

  async init() {
    shell = await pickShell()
  },

  async sample(now) {
    if (!shell) shell = await pickShell()
    if (!shell) throw new Error('PowerShell was not found (neither pwsh nor powershell.exe)')
    const r = await run(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePs(PS_SCRIPT)], { timeoutMs: 25_000 })
    const doc = parseJsonLoose(r.stdout)
    if (!doc) throw new Error('could not read system information from PowerShell')

    const procs = parseWinProcesses(doc.procs)
    const dtSec = prevAt ? (now - prevAt) / 1000 : 0
    const cores = asArray(doc.cpu).reduce((a, c) => a + (c.NumberOfLogicalProcessors ?? 0), 0) || os.cpus().length
    const list = []
    const next = new Map()
    for (const p of procs) {
      const before = prev.get(p.pid)
      const same = before && before.start === p.start
      const cpuPct = same && dtSec > 0 ? Math.max(0, ((p.ticks100ns - before.ticks) / 1e7 / dtSec) * 100) : 0
      next.set(p.pid, { ticks: p.ticks100ns, start: p.start })
      list.push({ pid: p.pid, user: '', comm: p.comm, cpu: cpuPct, rss: p.rss, swap: p.swap, args: p.args })
    }
    prev = next
    prevAt = now

    const boot = doc.os?.LastBootUpTime ? Date.parse(doc.os.LastBootUpTime) : NaN
    const load = asArray(doc.cpu).reduce((a, c) => a + (c.LoadPercentage ?? 0), 0) / Math.max(1, asArray(doc.cpu).length)
    return {
      cpu: { percent: pct(load, 100), cores: [], iowait: 0, steal: 0, count: cores, load: [0, 0, 0], model: String(asArray(doc.cpu)[0]?.Name ?? os.cpus()[0]?.model ?? '').trim() },
      memory: parseWinMemory(doc.os, doc.pagefile),
      uptime: Number.isFinite(boot) ? Math.max(0, Math.floor((now - boot) / 1000)) : os.uptime(),
      pressure: {},
      disks: parseWinDisks(doc.disks),
      processes: list,
      unreadable: 0,
    }
  },
}
