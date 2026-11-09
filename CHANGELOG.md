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

### Compatibility
- The client keeps working against a 0.2.x host (no `capabilities` ⇒ Linux defaults).

## 0.2.0 — 2026-11-08
- Linux: runtime detection of clock ticks and page size; one shared 1 s sampler; bounded scan queue; network
  filesystems skipped; unreadable-process counter.
- README with screenshots, demo fixtures, CI on Node 20/22/24.

## 0.1.0 — 2026-11-08
- First release: Linux resources panel (gauges, history, cores, PSI, process ranking, disk drill-down).
