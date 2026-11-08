# dsh-server-resources

A **Resources** tab for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) that shows what is using your Linux server — live CPU, RAM, swap and disk, with a ranked list of the biggest consumers of each.

It lives in the right sidebar (through [`dsh-better-sidebar`](https://www.npmjs.com/package/dsh-better-sidebar)) and follows the DSH light/dark theme.

## What you get

- **Overview** — rings for CPU, RAM, swap and the fullest disk (green → amber → red), a history chart of the last few minutes, per-core load, I/O wait, steal, page cache, and Linux pressure-stall info (PSI) for CPU, memory and disk I/O.
- **Processes** tab — top consumers of **CPU**, **RAM** or **swap**. Group by program (`claude ×4`) or list single processes with PID, user and full command line.
- **Disk** tab — usage bars for every mounted filesystem, then drill down: **largest folders** (click a folder to enter it, breadcrumb to go back) and **largest files** (filter: 20 MB / 100 MB / 500 MB / 1 GB).

## Install

```sh
dsh plugin --profile <your-profile> add dsh-server-resources
```

or straight from GitHub:

```sh
dsh plugin --profile <your-profile> add github:brungcm/dsh-server-resources
```

Open the **+** menu of the right sidebar and pick **Resources**. Requires `dsh-better-sidebar` ≥ 0.30 to be enabled.

## Safety

- **Read-only.** It never kills a process, deletes a file or changes any setting.
- **No dependencies, no network, no shell.** It reads `/proc` and runs `df`, `du` and `find` with fixed arguments (`spawn`, never a shell string).
- **Gentle on the server.** Disk scans run under `ionice -c3 nice -n19`, one at a time, with a 150 s time limit and a 5 min cache. Overview polling is every 2.5 s and pauses while the tab is hidden.
- `/proc`, `/sys`, `/dev` and `/run` cannot be scanned. Every path is resolved with `realpath` and must be an existing directory.
- It shows the **full command line** of every process, which can include secrets passed as arguments. The routes sit behind DSH's own owner authentication; do not expose DSH publicly without it.

## Limitations

- Linux only (reads `/proc`). Not for macOS or Windows.
- Processes owned by other users are listed, but their swap/RSS may be hidden if `/proc` is mounted with `hidepid`.
- Container limits (cgroups) are not shown; numbers are those of the host.

## API (internal)

`GET /api/dsh-server-resources/overview`, `/disk/dirs?path=&fresh=1`, `/disk/files?path=&minMb=`. Served through DSH's connection layer.

## Development

```sh
npm test        # node --test, no install step
```

## License

MIT
