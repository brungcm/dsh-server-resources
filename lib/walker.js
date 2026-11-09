/**
 * Portable disk walker (pure Node, no external commands). Used on macOS and Windows, where GNU `du`
 * and `find -printf` do not exist; Linux keeps using du/find because they are ~3x faster.
 *
 * Guarantees: never follows symlinks/junctions, stays on the starting device, honours a deadline and
 * an entry budget (returns `partial: true` instead of running forever), and yields to the event loop
 * so the DSH server stays responsive during a scan.
 */
import { opendir, lstat } from 'node:fs/promises'
import { join } from 'node:path'

const YIELD_EVERY = 400
const tick = () => new Promise((r) => setImmediate(r))

/** Bytes a file really occupies: allocated blocks where the platform reports them, else its size. */
export function diskBytes(st) {
  return st.blocks ? st.blocks * 512 : st.size
}

/**
 * Walks `root` and returns per-child totals for `dirs`, or a top-N list for `files`.
 * @param {string} root
 * @param {{ mode: 'dirs'|'files', minBytes?: number, deadline: number, maxEntries?: number, top?: number, skip?: (path: string) => boolean }} opts
 */
export async function walk(root, opts) {
  const { mode, minBytes = 0, deadline, maxEntries = 3_000_000, top = 40, skip = () => false } = opts
  const children = new Map() // direct child path → bytes (dirs mode)
  const big = [] // { path, bytes, mtime } (files mode, kept ≤ top*4 then trimmed)
  let total = 0
  let seen = 0
  let found = 0
  let partial = false

  let rootDev
  try {
    rootDev = (await lstat(root)).dev
  } catch {
    return { total: 0, rows: [], found: 0, partial: true }
  }

  async function visit(dir, child) {
    let handle
    try {
      handle = await opendir(dir)
    } catch {
      return // permission denied / vanished: skip silently
    }
    try {
      for await (const entry of handle) {
        if (partial) return
        if (++seen % YIELD_EVERY === 0) {
          await tick()
          if (Date.now() > deadline || seen > maxEntries) {
            partial = true
            return
          }
        }
        const p = join(dir, entry.name)
        if (entry.isSymbolicLink() || skip(p)) continue
        let st
        try {
          st = await lstat(p)
        } catch {
          continue
        }
        if (st.isSymbolicLink()) continue
        if (st.isDirectory()) {
          if (st.dev !== rootDev) continue // another filesystem (mount point)
          await visit(p, child ?? p)
        } else if (st.isFile()) {
          const bytes = diskBytes(st)
          total += bytes
          if (mode === 'dirs') {
            const key = child ?? p
            children.set(key, (children.get(key) ?? 0) + bytes)
          } else if (bytes >= minBytes) {
            found += 1
            big.push({ path: p, bytes, mtime: Math.round(st.mtimeMs) })
            if (big.length > top * 8) {
              big.sort((a, b) => b.bytes - a.bytes)
              big.length = top * 2
            }
          }
        }
      }
    } finally {
      try {
        await handle.close()
      } catch {
        /* already closed by the iterator */
      }
    }
  }

  await visit(root, null)

  if (mode === 'dirs') {
    const rows = [...children].map(([path, bytes]) => ({ path, bytes })).sort((a, b) => b.bytes - a.bytes)
    return { total, rows, found: rows.length, partial }
  }
  big.sort((a, b) => b.bytes - a.bytes)
  return { total, rows: big, found, partial }
}
