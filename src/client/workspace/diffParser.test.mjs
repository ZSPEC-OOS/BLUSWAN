import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseDiff } from './parseDiff.js'
import { sanitizeTerminalText } from './terminalText.js'

const MOD = `diff --git a/src/a.js b/src/a.js
index 111..222 100644
--- a/src/a.js
+++ b/src/a.js
@@ -1,4 +1,5 @@ function x() {
 keep
-old
+new1
+new2
 tail
@@ -20,2 +21,2 @@
-gone
+here
 end
\\ No newline at end of file
`
describe('parseDiff', () => {
  it('parses a modified file with hunks, numbering and counts', () => {
    const { files } = parseDiff(MOD)
    assert.equal(files.length, 1)
    const f = files[0]
    assert.deepEqual([f.path, f.status, f.additions, f.deletions, f.hunks.length], ['src/a.js', 'modified', 3, 2, 2])
    assert.deepEqual(f.hunks[0].lines.map(l => [l.type, l.oldNo, l.newNo]), [['context', 1, 1], ['del', 2, null], ['add', null, 2], ['add', null, 3], ['context', 3, 4]])
    assert.equal(f.hunks[0].header, '@@ -1,4 +1,5 @@'); assert.equal(f.hunks[0].section, 'function x() {')
    assert.deepEqual(f.hunks[1].lines.at(-1), { type: 'meta', text: 'No newline at end of file', oldNo: null, newNo: null })
  })
  it('detects new and deleted files', () => {
    const add = parseDiff('diff --git a/n.txt b/n.txt\nnew file mode 100644\nindex 0..1\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,2 @@\n+a\n+b\n').files[0]
    assert.deepEqual([add.status, add.additions, add.hunks[0].lines[1].newNo], ['added', 2, 2])
    const del = parseDiff('diff --git a/o.txt b/o.txt\ndeleted file mode 100644\nindex 1..0\n--- a/o.txt\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n').files[0]
    assert.deepEqual([del.status, del.deletions], ['deleted', 2])
  })
  it('parses multiple files and renames', () => {
    const d = `${MOD}diff --git a/old.js b/new.js\nsimilarity index 90%\nrename from old.js\nrename to new.js\n`
    const { files } = parseDiff(d)
    assert.deepEqual(files.map(f => f.path), ['src/a.js', 'new.js'])
    assert.deepEqual([files[1].status, files[1].renamedFrom], ['renamed', 'old.js'])
  })
  it('flags binary files without hunks', () => {
    const f = parseDiff('diff --git a/i.png b/i.png\nindex 1..2\nBinary files a/i.png and b/i.png differ\n').files[0]
    assert.deepEqual([f.binary, f.hunks.length], [true, 0])
  })
  it('carries the truncated flag and tolerates a cut hunk', () => {
    const r = parseDiff('diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1,3 +1,3 @@\n-x\n+y\n', { truncated: true })
    assert.equal(r.truncated, true); assert.equal(r.files[0].hunks[0].lines.length, 2)
  })
  it('falls back to raw text for malformed input and handles empty', () => {
    const r = parseDiff('this is not a diff')
    assert.deepEqual([r.malformed, r.files.length, r.raw], [true, 0, 'this is not a diff'])
    assert.deepEqual(parseDiff(''), { files: [], truncated: false, malformed: false })
  })
  it('keeps hostile content as inert text', () => {
    const f = parseDiff('diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-x\n+<script>alert(1)</script>\n').files[0]
    assert.equal(f.hunks[0].lines[1].text, '<script>alert(1)</script>')
  })
})

describe('sanitizeTerminalText', () => {
  it('strips colors, cursor movement and OSC sequences', () => {
    assert.equal(sanitizeTerminalText('\u001b[31mred\u001b[0m \u001b[2K\u001b[1Gdone \u001b]0;title\u0007ok \u001b]8;;http://x\u001b\\link'), 'red done ok link')
  })
  it('collapses carriage-return progress and drops control characters', () => {
    assert.equal(sanitizeTerminalText('10%\r50%\r100%\nnext\u0007\u0000'), '100%\nnext')
  })
  it('leaves HTML as text', () => { assert.equal(sanitizeTerminalText('<img onerror=x>'), '<img onerror=x>') })
})
