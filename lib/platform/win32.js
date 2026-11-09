/**
 * Windows collector. One PowerShell call per sample reads CIM/WMI classes and returns a single JSON document
 * (Win32_OperatingSystem, Win32_PageFileUsage, Win32_LogicalDisk, Win32_Processor, Win32_Process).
 *
 * Choices that matter
 *  - PowerShell 7 (`pwsh`) is ~15x faster to start than Windows PowerShell 5.1 (≈125 ms vs ≈1.9 s measured on a
 *    GitHub runner), so it is preferred when installed; `powershell.exe` is the fallback present on every Windows.
 *  - The script is passed with `-EncodedCommand` (UTF-16LE base64): nothing from the user or the UI is ever
 *    interpolated into it, and there is no quoting to get wrong. No `-ExecutionPolicy` flag: it only affects .ps1
 *    files, and `-ExecutionPolicy Bypass -EncodedCommand` is a classic EDR alert signature.
 *  - The shell is started by absolute path (never a bare name, which libuv resolves in the current directory first).
 *  - The script sets UTF-8 stdout (otherwise the OEM code page garbles accented names) and returns its own clock and
 *    ISO-8601 dates, so Windows PowerShell 5.1 and 7 produce the same JSON.
 *  - CPU % per process is a delta of kernel+user time (100 ns units) between samples, divided by wall time.
 *  - "Swap" is the page file; per-process swap is the process's private committed memory (PageFileUsage).
 *  - Overall and per-core CPU come from `os.cpus()` deltas (the CIM LoadPercentage is a coarse 1-second value).
 *  - No I/O wait, steal or pressure counters: the UI hides them.
 */
import os from 'node:os'
import { run } from './shared.js'
import { caps, createCpuSampler } from './shared.js'
import { parseJsonLoose, parseWinDate, asArray, parseWinMemory, parseWinDisks, parseWinProcesses } from '../parsers.js'

export const PS_SCRIPT = `
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
$os   = Get-CimInstance Win32_OperatingSystem | Select-Object TotalVisibleMemorySize,FreePhysicalMemory,@{n='LastBootUpTime';e={$_.LastBootUpTime.ToUniversalTime().ToString('o')}}
$pf   = @(Get-CimInstance Win32_PageFileUsage | Select-Object AllocatedBaseSize,CurrentUsage)
$disk = @(Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,DriveType,FileSystem,Size,FreeSpace,VolumeName)
$cpu  = @(Get-CimInstance Win32_Processor | Select-Object Name,NumberOfLogicalProcessors,LoadPercentage)
$proc = @(Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine,WorkingSetSize,PageFileUsage,KernelModeTime,UserModeTime,@{n='CreationDate';e={$_.CreationDate.ToUniversalTime().ToString('o')}})
[pscustomobject]@{ clock = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); os = $os; pagefile = $pf; disks = $disk; cpu = $cpu; procs = $proc } | ConvertTo-Json -Depth 4 -Compress
`

/** UTF-16LE base64, the encoding PowerShell's -EncodedCommand expects. */
export function encodePs(script) {
  return Buffer.from(script, 'utf16le').toString('base64')
}

let shell = null // 'pwsh' | 'powershell'
const cpuSampler = createCpuSampler()
let prev = new Map() // pid → { ticks, start }
let prevAt = 0
const users = new Map()

/** Absolute paths only: on Windows, spawning a bare name makes libuv look in the current directory first (CWE-427). */
export function shellCandidates(env = process.env) {
  const root = env.SystemRoot || env.windir || 'C:\\Windows'
  const pf = [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432].filter(Boolean)
  return {
    pwsh: [...new Set(pf)].map((d) => d + '\\PowerShell\\7\\pwsh.exe'),
    powershell: [root + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'],
  }
}

async function pickShell() {
  const forced = process.env.DSR_SHELL // 'powershell' forces Windows PowerShell 5.1 (used by CI to test it)
  const cands = shellCandidates()
  const probe = async (exe) => (await run(exe, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], { timeoutMs: 8000 })).stdout.trim()
  for (const kind of forced === 'powershell' ? ['powershell'] : ['pwsh', 'powershell']) {
    for (const exe of cands[kind]) if (/^\d+$/.test(await probe(exe))) return exe
  }
  return null
}

export const win32 = {
  id: 'win32',
  capabilities: caps({ perCoreCpu: true, commandLine: true, swapPerProcess: true, cache: false }),

  async init() {
    shell = await pickShell()
  },

  async sample(now) {
    if (!shell) shell = await pickShell()
    if (!shell) throw new Error('PowerShell was not found (neither pwsh nor powershell.exe)')
    const r = await run(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePs(PS_SCRIPT)], { timeoutMs: 25_000 })
    const doc = parseJsonLoose(r.stdout)
    if (!doc) throw new Error(r.timedOut ? 'PowerShell took too long to answer' : 'could not read system information from PowerShell (blocked by policy, or no output)')
    // Use the clock read INSIDE the script: the CIM snapshot is taken after PowerShell starts (0.1–2 s later than `now`).
    const at = Number.isFinite(doc.clock) ? doc.clock : now

    const procs = parseWinProcesses(doc.procs)
    const dtSec = prevAt ? (at - prevAt) / 1000 : 0
    const cores = asArray(doc.cpu).reduce((a, c) => a + (c.NumberOfLogicalProcessors ?? 0), 0) || os.cpus().length
    const list = []
    const next = new Map()
    for (const p of procs) {
      if (p.pid === 0) continue // "System Idle Process": its CPU time is the idle time of every core, not a consumer
      const before = prev.get(p.pid)
      const same = before && before.start === p.start
      const cpuPct = same && dtSec > 0 ? Math.max(0, ((p.ticks100ns - before.ticks) / 1e7 / dtSec) * 100) : 0
      next.set(p.pid, { ticks: p.ticks100ns, start: p.start })
      list.push({ pid: p.pid, user: '', comm: p.comm, cpu: cpuPct, rss: p.rss, swap: p.swap, args: p.args })
    }
    prev = next
    prevAt = at

    const boot = parseWinDate(doc.os?.LastBootUpTime)
    const sampled = cpuSampler()
    return {
      cpu: { percent: sampled.percent, cores: sampled.cores, iowait: 0, steal: 0, count: cores, load: [0, 0, 0], model: String(asArray(doc.cpu)[0]?.Name ?? sampled.model).trim() },
      memory: parseWinMemory(doc.os, doc.pagefile),
      uptime: Number.isFinite(boot) ? Math.max(0, Math.floor((at - boot) / 1000)) : os.uptime(),
      pressure: {},
      disks: parseWinDisks(doc.disks),
      processes: list,
      unreadable: 0,
    }
  },
}
