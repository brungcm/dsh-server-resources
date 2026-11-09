# Architecture

```
lib/
├─ index.js            host entry: routes, shared sampler, history, disk-scan queue/cache, safePath
├─ parsers.js          pure text/JSON → data parsers for every OS (no I/O) — all unit-tested
├─ walker.js           portable disk walker (pure Node) for macOS and Windows
├─ platform/
│  ├─ shared.js        run() (spawn with argv, never a shell), createCpuSampler(), caps()
│  ├─ linux.js         /proc + df
│  ├─ darwin.js        sysctl · vm_stat · ps · df · mount
│  └─ win32.js         one PowerShell/CIM call
└─ client.js           browser half: a React tab registered in dsh-better-sidebar (no build step)
```

## The collector contract

Each platform module exports `{ id, capabilities, init?(), sample(now) }`. `sample` returns

```js
{
  cpu:       { percent, cores[], iowait, steal, count, load[3], model },
  memory:    { total, available, used, cache, free, shmem, swapTotal, swapUsed, ...extras },
  uptime,    // seconds
  pressure:  { cpu, memory, io },             // {} where unsupported
  disks:     [{ device, fstype, mount, total, used, avail, percent }],
  processes: [{ pid, user, comm, cpu, rss, swap, args }],
  unreadable // processes that could not be read
}
```

`index.js` turns that into the public snapshot (rankings, groups, history) and adds `platform` and
`capabilities`. Adding an OS means writing one module that satisfies this contract and registering it in
`PLATFORMS`.

### `capabilities`

```js
{ perCoreCpu, ioWait, steal, pressure, swapPerProcess, cache, commandLine }
```

The UI reads these flags and **omits** what is `false`. A host from a 0.2.x release sends no `capabilities` and no
`platform`; the client then assumes Linux with everything available, so a new UI keeps working against an old host.

## Sampling model

- `getOverview()` is the only entry the route uses. Callers inside a window share one snapshot; the window is
  `max(1 s, 2 × last sample cost)`, so a slow collector (PowerShell, ~1.5 s) is never run back-to-back and
  several browser tabs cannot skew the CPU delta.
- CPU percentages are deltas against the previous sample, kept per collector. The first sample after start-up
  reports 0.
- The client polls every 2.5 s, or 4× the last response time (max 15 s) so a slow host is not hammered; after an
  error it backs off exponentially. Polling stops while the tab is hidden.

## Disk scans

- Linux: `ionice -c3 nice -n19 du -x -B1 --max-depth=1` and `find -xdev -type f -size +N -printf`. About 3× faster
  than any Node walker.
- macOS/Windows: `walker.js`. It uses `opendir` + `lstat`, never follows symlinks/junctions, stays on the starting
  device, counts allocated blocks where the OS reports them, yields every 400 entries, and stops at a deadline or
  an entry budget with `partial: true`.
- One scan runs at a time (a promise chain), at most 4 may wait, results are cached for 5 minutes, and an
  in-flight identical request is shared.

## Security boundaries

1. **Commands** are started with `spawn(cmd, argv)`; there is no shell and no string is concatenated into a command.
2. **PowerShell** receives a constant script via `-EncodedCommand`.
3. **Paths** from the browser pass `safePath`: absolute, `realpath`-resolved, an existing directory, not under a
   pseudo filesystem. The walker re-checks symlinks with `lstat` on every entry.
4. **Auth** is DSH's: routes are registered on the connection layer and answer only the signed-in owner.
5. **Output** includes full process command lines (see the README heads-up).
