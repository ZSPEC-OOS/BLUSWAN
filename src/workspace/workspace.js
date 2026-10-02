// Canonical Workspace contract. The agent/tool layers depend on this shape and
// never on Node filesystem, process, or git APIs directly.
//
// Workspace {
//   id, root, metadata
//   readFile(path, {startLine?, endLine?, maxBytes?})  → {path, content, startLine, endLine, totalLines, truncated}
//   writeFile(path, content)                           → {path, created, overwritten, bytesWritten}
//   deleteFile(path)                                   → {path, deleted}
//   listDirectory(path?, {depth?})                     → {path, entries, truncated}
//   searchFiles(query, {path?, limit?})                → {matches, total, truncated}
//   grep(pattern, {path?, regex?, caseSensitive?, limit?}) → {matches, truncated, filesSearched}
//   applyPatch(patch)                                  → {changedFiles, appliedHunks, files}
//   runCommand(command, {timeoutMs?, env?, signal?})   → CommandResult
//   gitStatus() / gitDiff({path?, staged?})
//   exists(path) / stat(path)
//   listFiles({path?})                                 → {files, truncated}  (indexed regular files, sorted; ignores generated dirs)
//   close()
// }
// All paths are workspace-relative; failures throw WorkspaceError with a stable `code`.

export const WORKSPACE_METHODS = Object.freeze([
  'readFile', 'writeFile', 'deleteFile', 'listDirectory', 'searchFiles', 'grep',
  'applyPatch', 'runCommand', 'gitStatus', 'gitDiff', 'exists', 'stat', 'listFiles', 'close',
])

export function isWorkspace(ws) {
  return !!ws && typeof ws.id === 'string' && typeof ws.root === 'string' && !!ws.metadata
    && WORKSPACE_METHODS.every(m => typeof ws[m] === 'function')
}

export function assertWorkspace(ws) {
  if (!isWorkspace(ws)) throw new TypeError('Value does not implement the Workspace interface')
  return ws
}
