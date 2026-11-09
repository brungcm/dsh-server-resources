# Contributing

Issues and pull requests are welcome. The project has no runtime dependencies and no build step; keep it that way.

## Run the checks

```sh
npm test        # unit tests (Node ≥ 20, nothing to install)
npm run smoke   # run the real collectors on this machine
```

CI runs both on Linux, macOS and Windows.

## Add a metric

1. Add a **pure parser** to `lib/parsers.js` that takes the raw text/JSON and returns plain data.
2. Add a **real sample** of the command output to `test/fixtures/` (strip hostnames, user names and paths first)
   and a test that parses it.
3. Wire it into the platform collector(s) and, if an OS cannot provide it, set the matching flag in that
   collector's `capabilities`.
4. Show it in `lib/client.js` only when the capability flag is true.

## Add a platform

Create `lib/platform/<process.platform>.js` exporting `{ id, capabilities, init?, sample }` as described in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), register it in `PLATFORMS` in `lib/index.js`, add fixtures and tests,
and extend the CI matrix.

## Rules of the house

- Commands are spawned with an argument array. Never build a shell string.
- Nothing is interpolated into the PowerShell script.
- Everything is read-only.
- Screenshots come from fictional data (`docs/demo`). Never commit a capture of a real machine.
