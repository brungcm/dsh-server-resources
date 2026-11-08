// Renders docs/images/*.png from fixture.mjs.
// Usage: PW_FROM=<dir-with-node_modules/playwright-core>/ node docs/demo/render.mjs <chrome-binary> <react.iife.js>
// <react.iife.js> is any IIFE build of React 18/19 + react-dom/client exposing window.React and window.createRoot.
import http from 'node:http'
import { readFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { overview, scans, files } from './fixture.mjs'

const [chromeBin, reactJs] = process.argv.slice(2)
const root = new URL('../../', import.meta.url).pathname
const outDir = root + 'docs/images/'
mkdirSync(outDir, { recursive: true })
const themes = {
  dark: '--dsw-alias-label-primary:#e5e7eb;--dsw-alias-label-secondary:#9ca3af;--dsw-alias-label-tertiary:#6b7280;--dsw-alias-bg-layer-1:#1c1f26;--dsw-alias-bg-layer-2:#272b34;--dsw-alias-border-l1:#2f343e;--dsw-alias-brand-primary:#60a5fa;background:#14161b;color:#e5e7eb',
  light: '--dsw-alias-label-primary:#111827;--dsw-alias-label-secondary:#4b5563;--dsw-alias-label-tertiary:#8a93a3;--dsw-alias-bg-layer-1:#f3f4f6;--dsw-alias-bg-layer-2:#e5e7eb;--dsw-alias-border-l1:#d8dce3;--dsw-alias-brand-primary:#2563eb;background:#ffffff;color:#111827',
}
const page = (t) => `<!doctype html><meta charset=utf-8><body style="margin:0;font-family:system-ui,-apple-system,Segoe UI,sans-serif;${themes[t]}"><div id=app style="width:440px;height:100vh;${themes[t]}"></div>
<script>window.__ModuleLoader__={load:m=>{window.__mod=m}}</script><script src="/react.js"></script><script src="/client.js"></script>
<script>const exp=window.__mod.factory(n=>{if(n==='react')return window.React;throw new Error(n)});let reg;exp.apply({effect:f=>f(),betterSidebar:{registerTab:d=>{reg=d;return()=>{}}}});
createRoot(document.getElementById('app')).render(React.createElement(reg.component,{visible:true}))</script>`
const server = http.createServer((q, s) => {
  const u = new URL(q.url, 'http://x'); const send = (t, b) => { s.setHeader('content-type', t); s.end(b) }
  if (u.pathname === '/') return send('text/html', page(u.searchParams.get('theme') || 'dark'))
  if (u.pathname === '/react.js') return send('text/javascript', readFileSync(reactJs))
  if (u.pathname === '/client.js') return send('text/javascript', readFileSync(root + 'lib/client.js'))
  if (u.pathname === '/api/dsh-server-resources/overview') return send('application/json', JSON.stringify({ ok: true, value: { ...overview, sampledAt: Date.now() } }))
  if (u.pathname === '/api/dsh-server-resources/disk/dirs') return send('application/json', JSON.stringify({ ok: true, value: scans[u.searchParams.get('path')] || scans['/'] }))
  if (u.pathname === '/api/dsh-server-resources/disk/files') return send('application/json', JSON.stringify({ ok: true, value: files }))
  s.statusCode = 404; s.end()
}).listen(0, '127.0.0.1')
await new Promise((r) => server.on('listening', r))
const base = `http://127.0.0.1:${server.address().port}`
const require = createRequire(process.env.PW_FROM || process.cwd() + '/')
const { chromium } = require('playwright-core')
const b = await chromium.launch({ executablePath: chromeBin, args: ['--no-sandbox'] })
const errs = []
for (const theme of ['dark', 'light']) {
  const p = await b.newPage({ viewport: { width: 440, height: 1180 }, deviceScaleFactor: 2 })
  p.on('pageerror', (e) => errs.push(e.message))
  await p.goto(`${base}/?theme=${theme}`)
  await p.waitForSelector('.sr-gauge')
  await p.waitForTimeout(1200)
  await p.screenshot({ path: `${outDir}overview-${theme}.png`, clip: { x: 0, y: 0, width: 440, height: 1010 } })
  await p.click('.sr-tab >> nth=1'); await p.waitForSelector('.sr-bar-row'); await p.waitForTimeout(700)
  await p.screenshot({ path: `${outDir}disk-${theme}.png`, fullPage: true })
  await p.close()
}
await b.close(); server.close()
console.log('render errors:', JSON.stringify(errs))
