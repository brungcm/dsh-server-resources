import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

test('client: syntactically valid and registers the Resources tab', () => {
  assert.doesNotThrow(() => new Function('window', src))
  assert.ok(src.includes("registerTab"))
  assert.ok(src.includes("'dsh-server-resources:panel'"))
})

test('client: keeps working against a 0.2.x host (no platform, no capabilities)', () => {
  assert.ok(src.includes("data.platform || 'linux'"), 'platform defaults to linux')
  assert.ok(src.includes('DEFAULT_CAPS') && src.includes('...(data.capabilities || {})'), 'capabilities default to everything')
})

test('client: network calls have a timeout and polling backs off', () => {
  assert.ok(/AbortSignal\.timeout/.test(src))
  assert.ok(/delay\s*=\s*Math\.min\(15000/.test(src))
})

test('client: keyboard and screen-reader affordances', () => {
  for (const needle of ["role: 'tab'", "'aria-selected'", "'aria-pressed'", "role: 'button'", 'tabIndex: 0', "role: 'alert'", "role: 'status'", 'prefers-reduced-motion']) assert.ok(src.includes(needle), needle)
})

test('client: no leftover Portuguese strings and no dead helper', () => {
  assert.ok(!/[áéíóúãõçÁÉÍÓÚ]/.test(src.replace(/\/\/.*$/gm, '')), 'no accented text in the UI')
  assert.ok(!src.includes('joinPath'))
})
