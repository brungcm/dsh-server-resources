# Platform notes

What is measured on each OS, with which command, and how it maps to what you see. The sample outputs the
parsers are tested against are real captures in [`test/fixtures`](../test/fixtures).

## Support matrix

| Metric | Linux | macOS | Windows |
|---|---|---|---|
| CPU % (overall, per core) | `/proc/stat` delta | `os.cpus()` delta | `os.cpus()` delta |
| CPU load | `/proc/loadavg` | `sysctl -n vm.loadavg` | — (shows logical CPU count) |
| I/O wait, steal | `/proc/stat` | — | — |
| Pressure (PSI) | `/proc/pressure/{cpu,memory,io}` | — | — |
| RAM used / available | `/proc/meminfo` (`MemTotal − MemAvailable`) | `vm_stat` (see below) | `Win32_OperatingSystem` |
| Cache | `Cached + Buffers + SReclaimable` | file-backed + purgeable pages | — |
| Swap | `/proc/meminfo` | `sysctl -n vm.swapusage` | `Win32_PageFileUsage` (page file) |
| Disks | `df -P -B1 -T` | `df -k -P` + `mount` | `Win32_LogicalDisk` (fixed drives) |
| Processes (CPU, RAM, command line) | `/proc/<pid>/{stat,statm,status,cmdline}` | `ps -axo …` + `ps -axww -o pid=,command=` | `Win32_Process` |
| Per-process swap | `VmSwap` | — | `PageFileUsage` (private committed memory) |
| Largest folders / files | `ionice -c3 nice -n19 du / find` | `lib/walker.js` | `lib/walker.js` |

## macOS

- **Memory used** follows Activity Monitor: *app + wired + compressed* pages — not `total − free`, which sits near 100%
  because macOS keeps spare RAM as cache. *Available* = free + inactive + speculative + purgeable pages. The page size
  is read from the `vm_stat` header (16 KB on Apple silicon, 4 KB on Intel).
- **Swap** is a pool the OS grows on demand; `vm.swapusage` reads `total = 0.00M` until memory pressure forces it.
  The panel says "none in use (managed by macOS)" instead of a misleading 0%.
- **Disks.** One APFS container is exposed as several volumes that all report the same capacity. The sealed read-only
  system volume `/` is shown with the usage of the `/System/Volumes/Data` volume added (that is the space you can
  actually fill); the internal helper volumes (`/System/Volumes/VM`, `Preboot`, asset images, `devfs`, `auto_home`)
  are hidden.
- **Process CPU** is `ps %cpu`, which macOS computes as a decaying average over the process lifetime — it lags a
  sudden spike. Overall and per-core CPU use real deltas of `os.cpus()`, so they react immediately.
- Process names come from the executable path; names with spaces (`Google Chrome Helper (Renderer)`) are kept whole.

## Windows

- **One PowerShell call per sample.** It reads five CIM classes and prints one JSON document. `pwsh` (7+) is used
  when present — ≈125 ms to read the process table vs ≈1.9 s in Windows PowerShell 5.1 on a GitHub runner —
  otherwise `powershell.exe`, which exists on every Windows.
- **No injection surface.** The script is a constant; it is passed with `-EncodedCommand` (UTF-16LE base64).
  Nothing from the browser reaches it.
- **Units.** `TotalVisibleMemorySize` and `FreePhysicalMemory` are KB, page file sizes are MB, `WorkingSetSize` is
  bytes, `PageFileUsage` (per process) is KB, `KernelModeTime`/`UserModeTime` are 100 ns ticks.
  `ConvertTo-Json` emits an *object* for one row and an *array* for several; the parsers accept both.
- **Process CPU** = Δ(kernel + user time) ÷ wall time between two samples (so 100% = one core). The first sample
  after the panel opens shows 0 until a second one arrives. `System Idle Process` (pid 0) is excluded: its "CPU
  time" is the idle time of every core.
- **"Swap"** is the page file. Per process it is *private committed memory*, labelled **Committed** in the UI.
- **Disks** are fixed local drives (`DriveType = 3`); network, optical and removable drives are skipped.
- **Paths** in the Disk tab use `C:\…`; matching is case-insensitive, as NTFS is.

## Linux

- **Memory used** = `MemTotal − MemAvailable`, the kernel's own estimate of memory that cannot be reclaimed.
- Clock ticks and page size are read from `getconf CLK_TCK` / `getconf PAGESIZE` at start-up (they are not 100 and
  4096 everywhere — 16 KB / 64 KB pages exist on some ARM64 kernels).
- `df` skips `tmpfs`, `devtmpfs`, `squashfs`, `overlay`, `efivarfs` and network filesystems.
- PSI needs kernel ≥ 4.20 with `CONFIG_PSI`; without it the pressure panel is empty.

## Not supported

FreeBSD/OpenBSD, Android, 32-bit Windows. On those the overview route answers
`unsupported platform: <name> (supported: linux, darwin, win32)` and the tab shows it.
