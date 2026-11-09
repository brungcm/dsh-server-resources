window.__ModuleLoader__.load({
  id: 'dsh-server-resources',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback, useMemo } = React

    const API = '/api/dsh-server-resources'
    const TAB_ID = 'dsh-server-resources:panel'
    const POLL_MS = 2500

    // ───────────── helpers ─────────────
    const fmtBytes = (n) => {
      if (!Number.isFinite(n)) return '–'
      const u = ['B', 'KB', 'MB', 'GB', 'TB']
      let i = 0
      let v = n
      while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
      return (v >= 100 || i === 0 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)) + ' ' + u[i]
    }
    const fmtUptime = (s) => {
      const d = Math.floor(s / 86400), hh = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60)
      return d > 0 ? d + 'd ' + hh + 'h' : hh > 0 ? hh + 'h ' + m + 'min' : m + 'min'
    }
    const fmtAgo = (t) => {
      const s = Math.max(0, Math.round((Date.now() - t) / 1000))
      return s < 60 ? s + 's' : s < 3600 ? Math.round(s / 60) + 'min' : Math.round(s / 3600) + 'h'
    }
    // green → amber → red
    const level = (p) => (p >= 90 ? 'crit' : p >= 75 ? 'warn' : 'ok')
    const COLOR = { ok: '#34d399', warn: '#fbbf24', crit: '#f87171', info: '#60a5fa', violet: '#a78bfa' }
    const colorFor = (p) => COLOR[level(p)]

    // ───────────── paths (POSIX "/a/b" and Windows "C:\\a\\b") ─────────────
    const isWinPath = (p) => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\')
    const sepOf = (p) => (isWinPath(p) ? '\\' : '/')
    const baseName = (p) => p.split(/[\\/]/).filter(Boolean).pop() || p
    const joinPath = (dir, name) => (dir.endsWith('/') || dir.endsWith('\\') ? dir : dir + sepOf(dir)) + name
    /** Breadcrumb segments: [{ label, path }]. Windows starts at the drive ("C:\\"), POSIX at "/". */
    function crumbsOf(p) {
      if (isWinPath(p)) {
        const m = /^([A-Za-z]:)[\\/]*(.*)$/.exec(p)
        const drive = m ? m[1] : p
        const out = [{ label: drive + '\\', path: drive + '\\' }]
        let acc = drive
        for (const seg of (m ? m[2] : '').split(/[\\/]/).filter(Boolean)) { acc += '\\' + seg; out.push({ label: seg, path: acc }) }
        return out
      }
      const out = [{ label: '/', path: '/' }]
      let acc = ''
      for (const seg of p.split('/').filter(Boolean)) { acc += '/' + seg; out.push({ label: seg, path: acc }) }
      return out
    }
    // Older hosts (v0.2.x) send no `capabilities`: they are Linux, so everything is available.
    const DEFAULT_CAPS = { perCoreCpu: true, ioWait: true, steal: true, pressure: true, swapPerProcess: true, cache: true, commandLine: true }
    const capsOf = (data) => ({ ...DEFAULT_CAPS, ...(data.capabilities || {}) })
    const PLATFORM_NAME = { linux: 'Linux', darwin: 'macOS', win32: 'Windows' }

    async function getJson(url, signal) {
      const res = await fetch(url, { headers: { accept: 'application/json' }, signal })
      const body = await res.json().catch(() => null)
      if (!body || body.ok === false) throw new Error(body?.error || 'HTTP ' + res.status)
      return body.value
    }

    // ───────────── styles ─────────────
    const CSS = `
.sr{--sr-fg:var(--dsw-alias-label-primary,#e5e7eb);--sr-fg2:var(--dsw-alias-label-secondary,#9ca3af);--sr-fg3:var(--dsw-alias-label-tertiary,#6b7280);
--sr-bg:var(--dsw-alias-bg-base,#0f1115);--sr-card:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.08));--sr-card2:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.14));
--sr-line:var(--dsw-alias-border-l1,rgba(127,127,127,.22));--sr-acc:var(--dsw-alias-brand-primary,#60a5fa);
height:100%;overflow:auto;box-sizing:border-box;padding:14px 14px 28px;color:var(--sr-fg);font-size:12.5px;line-height:1.45;font-variant-numeric:tabular-nums}
.sr *{box-sizing:border-box}
.sr-head{display:flex;align-items:center;gap:10px;margin-bottom:12px}
.sr-title{font-size:15px;font-weight:650;letter-spacing:.2px}
.sr-sub{color:var(--sr-fg3);font-size:11.5px}
.sr-live{margin-left:auto;display:flex;align-items:center;gap:6px;color:var(--sr-fg3);font-size:11px}
.sr-dot{width:7px;height:7px;border-radius:50%;background:#34d399;box-shadow:0 0 0 0 rgba(52,211,153,.6);animation:sr-pulse 2s infinite}
.sr-dot.off{background:#f87171;animation:none}
@keyframes sr-pulse{70%{box-shadow:0 0 0 7px rgba(52,211,153,0)}100%{box-shadow:0 0 0 0 rgba(52,211,153,0)}}
.sr-btn{border:1px solid var(--sr-line);background:var(--sr-card);color:var(--sr-fg2);border-radius:7px;padding:3px 9px;font:inherit;font-size:11.5px;cursor:pointer;transition:.15s}
.sr-btn:hover{background:var(--sr-card2);color:var(--sr-fg)}
.sr-btn[disabled]{opacity:.5;cursor:default}
.sr-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(138px,1fr));gap:9px;margin-bottom:10px}
.sr-card{background:var(--sr-card);border:1px solid var(--sr-line);border-radius:12px;padding:11px 12px;position:relative;overflow:hidden}
.sr-card h4{margin:0 0 6px;font-size:10.5px;font-weight:600;letter-spacing:.9px;text-transform:uppercase;color:var(--sr-fg3)}
.sr-gauge{display:flex;align-items:center;gap:11px}
.sr-gauge svg{flex:none;transform:rotate(-90deg)}
.sr-gauge .arc{transition:stroke-dashoffset .6s ease,stroke .3s}
.sr-big{font-size:21px;font-weight:700;line-height:1.1}
.sr-big small{font-size:12px;font-weight:500;color:var(--sr-fg3);margin-left:1px}
.sr-mut{color:var(--sr-fg3);font-size:11px}
.sr-wide{background:var(--sr-card);border:1px solid var(--sr-line);border-radius:12px;padding:11px 12px;margin-bottom:10px}
.sr-wide h4{margin:0 0 8px;font-size:10.5px;font-weight:600;letter-spacing:.9px;text-transform:uppercase;color:var(--sr-fg3);display:flex;justify-content:space-between;align-items:center;gap:8px}
.sr-cores{display:grid;grid-template-columns:repeat(auto-fill,minmax(26px,1fr));gap:4px;align-items:end;height:44px}
.sr-core{background:var(--sr-card2);border-radius:4px;position:relative;height:100%;overflow:hidden}
.sr-core i{position:absolute;left:0;right:0;bottom:0;border-radius:4px;transition:height .5s ease,background .3s}
.sr-leg{display:flex;gap:12px;color:var(--sr-fg3);font-size:11px;margin-top:6px;flex-wrap:wrap}
.sr-leg b{font-weight:600;color:var(--sr-fg2)}
.sr-psi{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.sr-psi div{background:var(--sr-card2);border-radius:9px;padding:7px 9px}
.sr-psi span{display:block;font-size:10.5px;color:var(--sr-fg3);text-transform:uppercase;letter-spacing:.7px}
.sr-psi strong{font-size:15px}
.sr-tabs{display:flex;gap:2px;padding:3px;background:var(--sr-card);border:1px solid var(--sr-line);border-radius:10px;margin:14px 0 10px}
.sr-tab{flex:1;border:0;background:transparent;color:var(--sr-fg2);padding:6px 8px;border-radius:7px;font:inherit;font-weight:600;font-size:12px;cursor:pointer;transition:.15s}
.sr-tab:hover{color:var(--sr-fg)}
.sr-tab.on{background:var(--tc,var(--sr-acc));color:#fff;box-shadow:0 2px 10px -2px var(--tc,var(--sr-acc))}
.sr-tab i{font-style:normal;margin-right:6px}
.sr-tab:not(.on):hover{background:var(--sr-card2)}
.sr-seg{display:inline-flex;border:1px solid var(--sr-line);border-radius:8px;overflow:hidden}
.sr-seg button{border:0;background:transparent;color:var(--sr-fg2);padding:3px 10px;font:inherit;font-size:11.5px;cursor:pointer}
.sr-seg button.on{background:var(--tc,var(--sr-acc));color:#fff}
.sr-bar-row{display:grid;grid-template-columns:22px 1fr 68px;gap:8px;align-items:center;padding:6px 4px;border-radius:8px;cursor:default}
.sr-bar-row:hover{background:var(--sr-card)}
.sr-rank{color:var(--sr-fg3);font-size:11px;text-align:right}
.sr-name{display:flex;align-items:center;gap:6px;min-width:0}
.sr-name b{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sr-tag{font-size:10px;color:var(--sr-fg3);background:var(--sr-card2);border-radius:5px;padding:0 5px;white-space:nowrap}
.sr-track{height:6px;border-radius:4px;background:var(--sr-card2);margin-top:4px;overflow:hidden}
.sr-fill{height:100%;border-radius:4px;transition:width .5s ease}
.sr-val{font-weight:650;text-align:right;white-space:nowrap}
.sr-cmd{color:var(--sr-fg3);font-size:10.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.sr-fs{margin-bottom:9px}
.sr-fs-top{display:flex;justify-content:space-between;gap:8px;margin-bottom:4px}
.sr-crumbs{display:flex;flex-wrap:wrap;align-items:center;gap:2px;margin-bottom:8px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px}
.sr-crumbs button{border:0;background:transparent;color:var(--sr-acc);cursor:pointer;padding:1px 3px;border-radius:4px;font:inherit}
.sr-crumbs button:hover{background:var(--sr-card2)}
.sr-crumbs span{color:var(--sr-fg3)}
.sr-click{cursor:pointer}
.sr-empty{color:var(--sr-fg3);text-align:center;padding:22px 8px}
.sr-spin{display:inline-block;width:12px;height:12px;border:2px solid var(--sr-line);border-top-color:var(--sr-acc);border-radius:50%;animation:sr-rot .8s linear infinite;vertical-align:-2px;margin-right:6px}
@keyframes sr-rot{to{transform:rotate(360deg)}}
.sr-err{color:#f87171;background:rgba(248,113,113,.1);border:1px solid rgba(248,113,113,.3);border-radius:9px;padding:8px 10px;margin-bottom:10px}
.sr-note{color:var(--sr-fg3);font-size:11px;margin-top:6px}
.sr-row2{display:flex;gap:8px;align-items:center;justify-content:space-between;margin-bottom:8px;flex-wrap:wrap}
`
    function useStyle() {
      useEffect(() => {
        if (document.getElementById('dsh-server-resources-css')) return
        const el = document.createElement('style')
        el.id = 'dsh-server-resources-css'
        el.textContent = CSS
        document.head.appendChild(el)
      }, [])
    }

    // ───────────── visual components ─────────────
    function Ring({ percent, size = 62, stroke = 7, color }) {
      const r = (size - stroke) / 2
      const c = 2 * Math.PI * r
      const p = Math.max(0, Math.min(100, percent || 0))
      return h('svg', { width: size, height: size, viewBox: '0 0 ' + size + ' ' + size },
        h('circle', { cx: size / 2, cy: size / 2, r, fill: 'none', stroke: 'currentColor', strokeOpacity: 0.12, strokeWidth: stroke }),
        h('circle', {
          className: 'arc', cx: size / 2, cy: size / 2, r, fill: 'none', stroke: color || colorFor(p),
          strokeWidth: stroke, strokeLinecap: 'round', strokeDasharray: c, strokeDashoffset: c * (1 - p / 100),
        }))
    }

    function Gauge({ title, percent, main, sub, color }) {
      const p = Math.max(0, Math.min(100, percent || 0))
      return h('div', { className: 'sr-card' },
        h('h4', null, title),
        h('div', { className: 'sr-gauge' },
          h(Ring, { percent: p, color }),
          h('div', null,
            h('div', { className: 'sr-big' }, main),
            h('div', { className: 'sr-mut' }, sub))))
    }

    let sparkSeq = 0
    function Spark({ data, keyName, color, height = 54 }) {
      const sparkUid = useRef(++sparkSeq).current // hook before any early return
      const w = 300
      if (!data || data.length < 2) return h('div', { className: 'sr-mut', style: { height } }, 'collecting…')
      const pts = data.map((d, i) => [(i / (data.length - 1)) * w, height - 2 - (Math.min(100, d[keyName]) / 100) * (height - 6)])
      const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ')
      const area = line + ' L' + w + ' ' + height + ' L0 ' + height + ' Z'
      const id = 'sg-' + keyName + '-' + sparkUid
      return h('svg', { viewBox: '0 0 ' + w + ' ' + height, width: '100%', height, preserveAspectRatio: 'none', style: { display: 'block' } },
        h('defs', null, h('linearGradient', { id, x1: 0, x2: 0, y1: 0, y2: 1 },
          h('stop', { offset: '0%', stopColor: color, stopOpacity: 0.35 }), h('stop', { offset: '100%', stopColor: color, stopOpacity: 0 }))),
        h('path', { d: area, fill: 'url(#' + id + ')' }),
        h('path', { d: line, fill: 'none', stroke: color, strokeWidth: 1.8, strokeLinejoin: 'round', vectorEffect: 'non-scaling-stroke' }))
    }

    function Bars({ rows, max, format, color, onClick, sub }) {
      if (!rows.length) return h('div', { className: 'sr-empty' }, 'Nothing to show.')
      return h('div', null, rows.map((r, i) => h('div', {
        key: r.key, className: 'sr-bar-row' + (onClick ? ' sr-click' : ''), title: r.title, onClick: onClick ? () => onClick(r) : undefined,
      },
        h('div', { className: 'sr-rank' }, i + 1),
        h('div', { style: { minWidth: 0 } },
          h('div', { className: 'sr-name' }, h('b', null, r.label), r.tag ? h('span', { className: 'sr-tag' }, r.tag) : null),
          sub ? h('div', { className: 'sr-cmd' }, r.sub) : null,
          h('div', { className: 'sr-track' }, h('div', { className: 'sr-fill', style: { width: Math.max(1.5, max > 0 ? (r.value / max) * 100 : 0) + '%', background: (typeof color === 'function' ? color(r, i) : color) } }))),
        h('div', { className: 'sr-val' }, format(r.value)))))
    }

    // ───────────── section: processes ─────────────
    function ProcessesView({ data }) {
      const [metric, setMetric] = useState('cpu')
      const [grouped, setGrouped] = useState(true)
      const p = data.processes
      const caps = capsOf(data)
      const rows = useMemo(() => {
        if (grouped) {
          const src = metric === 'cpu' ? p.groupsByCpu : metric === 'mem' ? p.groupsByMem : []
          return src.map((g) => ({ key: g.comm, label: g.comm, tag: g.count > 1 ? '×' + g.count : null, value: metric === 'cpu' ? g.cpu : g.rss, title: g.comm }))
        }
        const src = metric === 'cpu' ? p.byCpu : metric === 'mem' ? p.byMem : p.bySwap
        return src.map((x) => ({ key: x.pid, label: x.comm, tag: 'pid ' + x.pid + ' · ' + x.user, sub: x.args, value: metric === 'cpu' ? x.cpu : metric === 'mem' ? x.rss : x.swap, title: x.args }))
      }, [metric, grouped, p])
      const cores = data.cpu.count
      const max = metric === 'cpu' ? Math.max(100, ...rows.map((r) => r.value)) : Math.max(1, ...rows.map((r) => r.value))
      const fmt = metric === 'cpu' ? (v) => v.toFixed(1) + '%' : fmtBytes
      const color = metric === 'cpu' ? (r) => colorFor((r.value / (cores * 100)) * 400) : metric === 'mem' ? COLOR.ok : COLOR.violet
      const effGrouped = grouped && metric !== 'swap'
      return h('div', null,
        h('div', { className: 'sr-row2' },
          h('div', { className: 'sr-seg' },
            [['cpu', 'CPU', '#60a5fa'], ['mem', 'RAM', '#34d399'], ...(caps.swapPerProcess ? [['swap', data.platform === 'win32' ? 'Committed' : 'Swap', '#a78bfa']] : [])].map(([k, l, c]) => h('button', { key: k, className: metric === k ? 'on' : '', style: { '--tc': c }, onClick: () => setMetric(k) }, l))),
          metric !== 'swap' ? h('div', { className: 'sr-seg' },
            [[true, 'Group'], [false, 'Processes']].map(([k, l]) => h('button', { key: String(k), className: grouped === k ? 'on' : '', onClick: () => setGrouped(k) }, l))) : null),
        h(Bars, { rows: effGrouped ? rows : metric === 'swap' ? p.bySwap.map((x) => ({ key: x.pid, label: x.comm, tag: 'pid ' + x.pid + ' · ' + x.user, sub: x.args, value: x.swap, title: x.args })) : rows, max, format: fmt, color, sub: !effGrouped }),
        h('div', { className: 'sr-note' }, [
          metric === 'cpu' ? 'CPU: 100% = 1 core (max ' + cores * 100 + '%)' : null,
          p.total + ' processes' + (p.unreadable ? ' (' + p.unreadable + ' not readable)' : ''),
          data.platform === 'darwin' && metric === 'cpu' ? 'per-process CPU is macOS\'s decaying average' : null,
          'read-only',
        ].filter(Boolean).join(' · ') + '.'))
    }

    // ───────────── section: disk ─────────────
    function DiskView({ data }) {
      const [path, setPath] = useState(() => (data.disks.length ? data.disks.reduce((a, b) => (b.percent > a.percent ? b : a)).mount : '/'))
      const [mode, setMode] = useState('dirs')
      const [minMb, setMinMb] = useState(100)
      const [state, setState] = useState({ loading: false, data: null, error: null })
      const abort = useRef(null)
      const freshNext = useRef(false)

      const load = useCallback(async () => {
        abort.current?.abort()
        const ac = new AbortController()
        abort.current = ac
        setState((s) => ({ ...s, loading: true, error: null }))
        try {
          const q = new URLSearchParams({ path, minMb: String(minMb) })
          if (freshNext.current) { q.set('fresh', '1'); freshNext.current = false }
          const v = await getJson(API + '/disk/' + mode + '?' + q, ac.signal)
          if (!ac.signal.aborted) setState({ loading: false, data: v, error: null })
        } catch (e) {
          if (!ac.signal.aborted) setState({ loading: false, data: null, error: String(e.message || e) })
        }
      }, [path, mode, minMb])
      useEffect(() => { load(); return () => abort.current?.abort() }, [load])

      const crumbs = []
      crumbsOf(path).forEach((c, i) => {
        if (i) crumbs.push(h('span', { key: 's' + i }, '›'))
        crumbs.push(h('button', { key: 'p' + i, onClick: () => setPath(c.path) }, c.label))
      })
      const d = state.data
      const rows = d ? d.rows : []
      const max = rows.length ? rows[0].bytes : 1

      return h('div', null,
        data.disks.map((fs) => h('div', { key: fs.device, className: 'sr-fs' },
          h('div', { className: 'sr-fs-top' },
            h('b', null, fs.mount),
            h('span', { className: 'sr-mut' }, fmtBytes(fs.used) + ' of ' + fmtBytes(fs.total) + ' · free ' + fmtBytes(fs.avail))),
          h('div', { className: 'sr-track', style: { height: 9 } },
            h('div', { className: 'sr-fill', style: { width: fs.percent + '%', background: colorFor(fs.percent) } })),
          h('div', { className: 'sr-mut', style: { marginTop: 3 } }, fs.percent.toFixed(0) + '% used · ' + fs.device + ' · ' + fs.fstype))),
        h('div', { className: 'sr-tabs', style: { margin: '12px 0 10px' } },
          [['dirs', 'Largest folders', '#34d399', '▤'], ['files', 'Largest files', '#a78bfa', '▥']].map(([k, l, c, ic]) =>
            h('button', { key: k, className: 'sr-tab' + (mode === k ? ' on' : ''), style: { '--tc': c }, onClick: () => setMode(k) }, h('i', null, ic), l))),
        h('div', { className: 'sr-crumbs' }, crumbs),
        mode === 'files' ? h('div', { className: 'sr-row2' },
          h('span', { className: 'sr-mut' }, 'Files larger than'),
          h('div', { className: 'sr-seg' }, [20, 100, 500, 1000].map((m) => h('button', { key: m, className: minMb === m ? 'on' : '', onClick: () => setMinMb(m) }, m >= 1000 ? '1 GB' : m + ' MB')))) : null,
        state.error ? h('div', { className: 'sr-err' }, state.error) : null,
        state.loading ? h('div', { className: 'sr-empty' }, h('span', { className: 'sr-spin' }), 'Scanning disk (low priority, may take up to 2 min)…') : null,
        !state.loading && d ? h('div', null,
          mode === 'dirs'
            ? h('div', { className: 'sr-row2' }, h('span', { className: 'sr-mut' }, 'Total of ' + d.path + ': '), h('b', null, fmtBytes(d.total)))
            : h('div', { className: 'sr-row2' }, h('span', { className: 'sr-mut' }, d.found + ' file(s) found in ' + d.path)),
          mode === 'dirs'
            ? h(Bars, {
              rows: rows.map((r) => ({ key: r.path, label: baseName(r.path), tag: d.total ? ((r.bytes / d.total) * 100).toFixed(0) + '%' : null, value: r.bytes, title: r.path + '\nClick to open' })),
              max, format: fmtBytes, color: (r, i) => (i === 0 ? COLOR.crit : i < 3 ? COLOR.warn : COLOR.info),
              onClick: (r) => setPath(r.path),
            })
            : h(Bars, {
              rows: rows.map((r) => ({ key: r.path, label: baseName(r.path), tag: new Date(r.mtime).toLocaleDateString(), sub: r.path, value: r.bytes, title: r.path })),
              max, format: fmtBytes, color: (r, i) => (i === 0 ? COLOR.crit : i < 3 ? COLOR.warn : COLOR.info), sub: true,
            }),
          d.partial ? h('div', { className: 'sr-note' }, '⚠ Scan stopped by the time limit: partial result.') : null,
          h('div', { className: 'sr-row2', style: { marginTop: 8 } },
            h('span', { className: 'sr-note' }, (d.cached ? 'Cached · ' : '') + 'scanned ' + fmtAgo(d.scannedAt) + ' ago in ' + (d.tookMs / 1000).toFixed(1) + 's'),
            h('button', { className: 'sr-btn', disabled: state.loading, onClick: () => { freshNext.current = true; load() } }, 'Rescan'))) : null)
    }

    // ───────────── main panel ─────────────
    function Panel({ visible }) {
      useStyle()
      const [data, setData] = useState(null)
      const [error, setError] = useState(null)
      const [tab, setTab] = useState('proc')
      const [lastOk, setLastOk] = useState(0)

      useEffect(() => {
        if (visible === false) return undefined
        let stop = false
        let timer = null
        const ac = new AbortController()
        let delay = POLL_MS
        const tick = async () => {
          const t0 = Date.now()
          try {
            const v = await getJson(API + '/overview', ac.signal)
            if (!stop) {
              setData(v); setError(null); setLastOk(Date.now())
              // Windows samples through PowerShell (slower): never poll faster than ~4x the cost of one sample.
              delay = Math.max(POLL_MS, Math.min(15000, (Date.now() - t0) * 4))
            }
          } catch (e) {
            if (!stop && !ac.signal.aborted) { setError(String(e.message || e)); delay = Math.min(15000, delay * 2) }
          }
          if (!stop) timer = setTimeout(tick, delay)
        }
        tick()
        return () => { stop = true; ac.abort(); if (timer) clearTimeout(timer) }
      }, [visible])

      if (!data) return h('div', { className: 'sr' }, error ? h('div', { className: 'sr-err' }, 'Could not read server resources: ' + error) : h('div', { className: 'sr-empty' }, h('span', { className: 'sr-spin' }), 'Reading server resources…'))

      const { cpu, memory: m, pressure: ps } = data
      const memPct = m.total ? (m.used / m.total) * 100 : 0
      const swapPct = m.swapTotal ? (m.swapUsed / m.swapTotal) * 100 : 0
      const maxMount = data.disks.reduce((a, b) => (b.percent > a.percent ? b : a), data.disks[0] || { percent: 0, mount: '' })
      const live = !error && Date.now() - lastOk < POLL_MS * 3
      const caps = capsOf(data)
      const hasSwap = m.swapTotal > 0 || data.platform === 'linux'
      const loadText = data.platform === 'win32' ? cpu.count + ' logical CPUs' : 'load ' + cpu.load.map((x) => x.toFixed(1)).join(' · ') + ' / ' + cpu.count

      return h('div', { className: 'sr' },
        h('div', { className: 'sr-head' },
          h('div', null,
            h('div', { className: 'sr-title' }, 'Server resources'),
            h('div', { className: 'sr-sub' }, data.host.name + ' · ' + (PLATFORM_NAME[data.platform] || 'Unknown OS') + ' · up ' + fmtUptime(data.host.uptime) + (data.platform === 'linux' ? ' · kernel ' + data.host.kernel : ' · ' + data.host.kernel))),
          h('div', { className: 'sr-live' }, h('span', { className: 'sr-dot' + (live ? '' : ' off') }), live ? 'live' : 'offline')),
        error ? h('div', { className: 'sr-err' }, error) : null,

        h('div', { className: 'sr-grid' },
          h(Gauge, { title: 'CPU', percent: cpu.percent, main: h('span', null, cpu.percent.toFixed(0), h('small', null, '%')), sub: loadText }),
          h(Gauge, { title: 'RAM', percent: memPct, main: h('span', null, memPct.toFixed(0), h('small', null, '%')), sub: fmtBytes(m.used) + ' of ' + fmtBytes(m.total) }),
          h(Gauge, { title: data.platform === 'win32' ? 'Page file' : 'Swap', percent: swapPct, main: h('span', null, hasSwap ? swapPct.toFixed(0) : '–', hasSwap ? h('small', null, '%') : null), sub: m.swapTotal > 0 ? fmtBytes(m.swapUsed) + ' of ' + fmtBytes(m.swapTotal) : (data.platform === 'darwin' ? 'none in use (managed by macOS)' : 'not configured') }),
          h(Gauge, { title: 'Disk ' + (maxMount.mount || ''), percent: maxMount.percent, main: h('span', null, maxMount.percent.toFixed(0), h('small', null, '%')), sub: 'free ' + fmtBytes(maxMount.avail) })),

        h('div', { className: 'sr-wide' },
          h('h4', null, h('span', null, 'Last minutes'), h('span', { style: { textTransform: 'none', letterSpacing: 0, display: 'flex', gap: 10 } },
            h('span', { style: { color: COLOR.info } }, '● CPU'), h('span', { style: { color: COLOR.violet } }, '● RAM'))),
          h('div', { style: { position: 'relative' } },
            h(Spark, { data: data.history, keyName: 'cpu', color: COLOR.info }),
            h('div', { style: { position: 'absolute', inset: 0 } }, h(Spark, { data: data.history, keyName: 'mem', color: COLOR.violet })))),

        h('div', { className: 'sr-wide' },
          h('h4', null, h('span', null, caps.perCoreCpu && cpu.cores.length ? 'Cores' : 'Memory details'), h('span', { style: { textTransform: 'none', letterSpacing: 0 } }, cpu.count + ' × ' + (cpu.model || '').replace(/\(R\)|\(TM\)|CPU /g, '').trim().slice(0, 34))),
          caps.perCoreCpu && cpu.cores.length ? h('div', { className: 'sr-cores' }, cpu.cores.map((c, i) => h('div', { key: i, className: 'sr-core', title: 'core ' + i + ': ' + c.toFixed(0) + '%' },
            h('i', { style: { height: Math.max(3, c) + '%', background: colorFor(c) } })))) : null,
          h('div', { className: 'sr-leg' },
            caps.ioWait ? h('span', null, 'I/O wait ', h('b', null, cpu.iowait.toFixed(1) + '%')) : null,
            caps.steal ? h('span', null, 'steal ', h('b', null, cpu.steal.toFixed(1) + '%')) : null,
            caps.cache ? h('span', null, 'cache ', h('b', null, fmtBytes(m.cache))) : null,
            data.platform === 'darwin' && m.compressed != null ? h('span', null, 'compressed ', h('b', null, fmtBytes(m.compressed))) : null,
            data.platform === 'darwin' && m.wired != null ? h('span', null, 'wired ', h('b', null, fmtBytes(m.wired))) : null,
            h('span', null, 'available ', h('b', null, fmtBytes(m.available))))),

        caps.pressure ? h('div', { className: 'sr-wide' },
          h('h4', null, h('span', null, 'Pressure (PSI, 60s avg)'), h('span', { style: { textTransform: 'none', letterSpacing: 0 } }, 'time stalled waiting')),
          h('div', { className: 'sr-psi' },
            [['CPU', ps.cpu?.some], ['Memory', ps.memory?.some], ['Disk I/O', ps.io?.some]].map(([l, v]) =>
              h('div', { key: l }, h('span', null, l), h('strong', { style: { color: colorFor((v?.avg60 ?? 0) * 3) } }, (v?.avg60 ?? 0).toFixed(1) + '%'))))) : null,

        h('div', { className: 'sr-tabs' },
          [['proc', 'Processes', '#60a5fa', '▦'], ['disk', 'Disk', '#fbbf24', '◔']].map(([k, l, c, ic]) => h('button', { key: k, className: 'sr-tab' + (tab === k ? ' on' : ''), style: { '--tc': c }, onClick: () => setTab(k) }, h('i', null, ic), l))),
        tab === 'proc' ? h(ProcessesView, { data }) : h(DiskView, { data }))
    }

    // ───────────── sidebar registration ─────────────
    const inject = ['betterSidebar']

    function Icon({ size = 16 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('rect', { x: 3, y: 4, width: 18, height: 7, rx: 2 }), h('rect', { x: 3, y: 13, width: 18, height: 7, rx: 2 }),
        h('path', { d: 'M7 7.5h.01M7 16.5h.01M11 7.5h6M11 16.5h6' }))
    }

    function apply(ctx) {
      ctx.effect(() => ctx.betterSidebar.registerTab({
        id: TAB_ID,
        title: () => 'Resources',
        description: () => 'CPU, RAM, swap and disk of the host (Linux, macOS, Windows), with rankings of the biggest consumers.',
        icon: (size) => h(Icon, { size }),
        order: 45,
        single: true,
        component: ({ visible }) => h(Panel, { visible }),
      }), 'dsh-server-resources: sidebar tab')
    }

    exports.apply = apply
    exports.inject = inject
    exports.Panel = Panel
    return module.exports
  },
})
