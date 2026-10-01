// Lightweight deterministic file index: one cached directory walk per
// invalidation. No embeddings, no content parsing.
import fs from 'node:fs/promises'
import path from 'node:path'

export const DEFAULT_IGNORE = Object.freeze(['.git', 'node_modules', 'dist', 'build', 'coverage', '.cache'])

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)

export function createFileIndex({ root, ignore = DEFAULT_IGNORE, maxFiles = 50_000 }) {
  const ignored = new Set(ignore.map(n => n.replace(/\/+$/, '')))
  let cache = null

  async function build() {
    const files = []
    const directories = []
    let truncated = false
    const queue = ['']
    while (queue.length && !truncated) {
      const rel = queue.shift()
      let entries
      try {
        entries = await fs.readdir(path.join(root, rel), { withFileTypes: true })
      } catch { continue }
      entries.sort(byName)
      const subdirs = []
      for (const entry of entries) {
        const child = rel === '' ? entry.name : `${rel}/${entry.name}`
        if (entry.isDirectory()) {
          if (ignored.has(entry.name)) continue
          directories.push(child)
          subdirs.push(child)
        } else if (entry.isFile()) {
          if (files.length >= maxFiles) { truncated = true; break }
          files.push(child)
        }
      }
      queue.push(...subdirs)
    }
    files.sort()
    directories.sort()
    return { files, directories, truncated }
  }

  return {
    ignoredNames: ignored,
    /** @returns {Promise<{files:string[],directories:string[],truncated:boolean}>} */
    snapshot() {
      cache ??= build()
      return cache
    },
    async files() { return (await this.snapshot()).files },
    invalidate() { cache = null },
    isIgnoredName: name => ignored.has(name),
  }
}
