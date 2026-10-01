import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parsePatch, applyFilePatch } from './patch.js'

const code = c => e => e?.code === c

const apply = (content, patch) => applyFilePatch(content, parsePatch(patch).files[0])

describe('parsePatch', () => {
  it('parses multi-file patches with git headers', () => {
    const p = parsePatch(`diff --git a/a.js b/a.js
index 111..222 100644
--- a/a.js
+++ b/a.js
@@ -1,2 +1,2 @@
-one
+uno
 two
--- /dev/null
+++ b/dir/new.js
@@ -0,0 +1 @@
+hello
`)
    assert.deepEqual(p.files.map(f => [f.path, f.op, f.hunks.length]), [['a.js', 'modify', 1], ['dir/new.js', 'create', 1]])
    assert.equal(p.hunkCount, 2)
  })

  it('rejects malformed input', () => {
    for (const bad of ['', '   ', 'not a patch', '--- a/x\n', '--- a/x\n+++ b/x\n', '--- a/x\n+++ b/x\n@@ nonsense @@\n',
      '--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-a\n+b\n', '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n+extra\n']) {
      assert.throws(() => parsePatch(bad), code('patch_parse_error'), JSON.stringify(bad))
    }
  })

  it('rejects binary patches, renames, and duplicate targets', () => {
    assert.throws(() => parsePatch('Binary files a/x.png and b/x.png differ\n'), code('patch_parse_error'))
    assert.throws(() => parsePatch('rename from a\nrename to b\n'), code('patch_parse_error'))
    assert.throws(() => parsePatch('--- a/x\n+++ b/y\n@@ -1 +1 @@\n-a\n+b\n'), code('patch_parse_error'))
    const one = '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n'
    assert.throws(() => parsePatch(one + one), code('patch_parse_error'))
  })

  it('tolerates markdown fences around the diff', () => {
    assert.equal(parsePatch('```diff\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n```\n').files.length, 1)
  })
})

describe('applyFilePatch', () => {
  it('applies a single hunk', () => {
    assert.equal(apply('a\nb\nc\n', '--- a/f\n+++ b/f\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n'), 'a\nB\nc\n')
  })

  it('applies multiple hunks, tracking line shifts', () => {
    const src = Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join('\n') + '\n'
    const out = apply(src, `--- a/f
+++ b/f
@@ -1,3 +1,4 @@
 l1
+inserted
 l2
 l3
@@ -18,3 +19,2 @@
 l18
-l19
 l20
`)
    const lines = out.trimEnd().split('\n')
    assert.equal(lines[1], 'inserted')
    assert.ok(!lines.includes('l19'))
    assert.equal(lines.length, 20)
  })

  it('finds hunks displaced from their stated line numbers', () => {
    const out = apply('x\ny\na\nb\nc\n', '--- a/f\n+++ b/f\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n')
    assert.equal(out, 'x\ny\na\nB\nc\n')
  })

  it('tolerates trailing-whitespace differences in context', () => {
    assert.equal(apply('a  \nb\n', '--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n a\n-b\n+B\n'), 'a  \nB\n')
  })

  it('fails with patch_apply_failed when context does not match', () => {
    assert.throws(() => apply('a\nb\nc\n', '--- a/f\n+++ b/f\n@@ -1,3 +1,3 @@\n a\n-zzz\n+B\n c\n'), code('patch_apply_failed'))
  })

  it('creates and deletes whole files', () => {
    assert.equal(apply('', '--- /dev/null\n+++ b/n\n@@ -0,0 +1,2 @@\n+one\n+two\n'), 'one\ntwo\n')
    assert.equal(apply('one\ntwo\n', '--- a/n\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-one\n-two\n'), '')
    assert.throws(() => apply('one\ntwo\nthree\n', '--- a/n\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-one\n-two\n'), code('patch_apply_failed'))
  })

  it('preserves CRLF line endings', () => {
    assert.equal(apply('a\r\nb\r\n', '--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n a\n-b\n+B\n'), 'a\r\nB\r\n')
  })

  it('handles "No newline at end of file"', () => {
    const p = '--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+B\n\\ No newline at end of file\n'
    assert.equal(apply('a\nb', p), 'a\nB')
    const add = '--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+B\n'
    assert.equal(apply('a\nb', add), 'a\nB\n')
  })
})
