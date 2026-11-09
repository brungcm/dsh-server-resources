# Changelog

## 0.3.0 — 2026-11-09

### Added
- **macOS and Windows support.** Per-OS collectors (`lib/platform/`), real-sample fixtures and tests.
- Portable disk walker (`lib/walker.js`) for macOS/Windows.
- `platform` and `capabilities` in the overview, so the UI shows only what each OS can measure.
- Windows: page-file gauge, per-process *committed* memory ranking, drive-letter breadcrumbs (`C:\`).
- macOS: compressed and wired memory, "managed by macOS" swap, APFS volumes merged into one disk.
- `npm run smoke` and a CI job that runs the real collectors on a Linux, macOS and Windows host.
- Docs: `docs/PLATFORMS.md`, `docs/ARCHITECTURE.md`, `CONTRIBUTING.md`.

### Changed
- CI matrix: Linux, macOS and Windows × Node 20, 22, 24.
- The reuse window of the shared sampler adapts to the cost of a sample (PowerShell is slower than `/proc`).
- The client polls more slowly when a sample is slow and backs off after errors.
- `npm test` uses an explicit file runner (Node 20 on Windows does not expand globs).

### Fixed (independent code review before release)
- `run()` could hang for as long as a child ignored SIGKILL (e.g. `df` on a dead NFS mount), freezing `/overview`; it now settles at its timeout, the whole collection is capped at 30 s, macOS lists local volumes only (`df -l`) and the UI fetch has a timeout.
- Windows: stdout forced to UTF-8 (accented names were garbled), PowerShell started by absolute path (cwd search, CWE-427), `-ExecutionPolicy Bypass` removed (EDR signature), dates normalised for Windows PowerShell 5.1, CPU delta uses the clock from inside the script, UNC / `\\?\` paths refused. CI now exercises PowerShell 5.1 too.
- macOS: *Memory Used* matches Activity Monitor (App Memory + wired + compressed), APFS container math (`used + free = total`), mounted DMGs hidden, locale-proof number parsing (decimal comma), disk scans via BSD `du`/`find`.
- Linux: `du -a` so loose files in the scanned folder are listed; `find` reports allocated size; containers whose `/` is an overlay still show a disk.
- Disk tab: volumes are clickable (reach `D:\`, external drives), unreadable folders are counted, hard links counted once, scan cache bounded, HTTP 429 when the queue is full.
- Command lines: best-effort masking of secrets; `DSR_HIDE_COMMAND_LINES=1` hides them.
- Accessibility: keyboard-operable rows and volumes, roles/`aria-*` on tabs and toggles, readable contrast on the active tab, `prefers-reduced-motion`.
- The history chart no longer starts with a fake 0% sample.

### Tests
- 70 tests (was 31): `run()` timeouts, routes, scan queue/cache/429, `safePath`, masking, walker (hard links, unreadable folders, budget), real-host smoke tests on Linux, macOS, Windows, Windows PowerShell 5.1 and a Linux container.

### Compatibility
- The client keeps working against a 0.2.x host (no `platform`/`capabilities` ⇒ Linux with everything available).

## 0.2.0 — 2026-11-08
- Linux: runtime detection of clock ticks and page size; one shared 1 s sampler; bounded scan queue; network
  filesystems skipped; unreadable-process counter.
- README with screenshots, demo fixtures, CI on Node 20/22/24.

## 0.1.0 — 2026-11-08
- First release: Linux resources panel (gauges, history, cores, PSI, process ranking, disk drill-down).
