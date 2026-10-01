// Parsing of unified-diff text into per-file statistics.

/** @returns {{files:{path:string,additions:number,deletions:number,binary:boolean}[],additions:number,deletions:number}} */
export function summarizeDiff(diffText) {
  const files = []
  let current = null
  let inHunk = false
  for (const line of diffText.split('\n')) {
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line)
    if (header) {
      current = { path: header[2], additions: 0, deletions: 0, binary: false }
      files.push(current)
      inHunk = false
    } else if (!current) {
      continue
    } else if (line.startsWith('@@')) {
      inHunk = true
    } else if (/^Binary files .* differ$/.test(line) || line.startsWith('GIT binary patch')) {
      current.binary = true
    } else if (inHunk && line.startsWith('+')) {
      current.additions++
    } else if (inHunk && line.startsWith('-')) {
      current.deletions++
    }
  }
  return {
    files,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
  }
}
