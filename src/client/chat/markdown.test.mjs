import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseMarkdown, parseInline, looksLikePath } from './markdown.js'
import { deriveTitle } from '../sessions/sessionTitle.js'

const types = (nodes) => nodes.map(n => n.type)

describe('markdown parser', () => {
  it('parses headings, paragraphs, rules and lists', () => {
    const blocks = parseMarkdown('# Title\n\nSome **bold** text with `code`.\n\n- one\n- two\n\n1. first\n2. second\n\n---')
    assert.deepEqual(types(blocks), ['heading', 'paragraph', 'list', 'list', 'rule'])
    assert.equal(blocks[0].level, 1)
    assert.deepEqual(types(blocks[1].children), ['text', 'strong', 'text', 'code', 'text'])
    assert.deepEqual([blocks[2].ordered, blocks[2].items.length, blocks[3].ordered], [false, 2, true])
  })
  it('parses fenced code blocks with language, and tolerates an unclosed fence while streaming', () => {
    const [code] = parseMarkdown('```js\nconst a = 1\n  indented()\n```')
    assert.deepEqual([code.type, code.lang, code.text], ['code', 'js', 'const a = 1\n  indented()'])
    const [open] = parseMarkdown('```py\nprint("hi")\nmore')
    assert.deepEqual([open.type, open.text], ['code', 'print("hi")\nmore'])
    assert.equal(parseMarkdown('````\n```\nnested\n```\n````')[0].text, '```\nnested\n```')
  })
  it('parses tables and blockquotes', () => {
    const [table] = parseMarkdown('| Tool | Effect |\n|---|---|\n| `grep` | read |\n| patch | write |')
    assert.equal(table.type, 'table')
    assert.deepEqual([table.header.length, table.rows.length], [2, 2])
    assert.equal(table.rows[0][0][0].type, 'code')
    assert.equal(parseMarkdown('> quoted **text**')[0].type, 'blockquote')
  })
  it('only allows safe link targets', () => {
    const [ok] = parseInline('see [docs](https://example.com/a?b=1) now')
    assert.deepEqual([ok.type, ok.text ?? null], ['text', 'see '])
    const link = parseInline('[docs](https://example.com)')[0]
    assert.deepEqual([link.type, link.href], ['link', 'https://example.com'])
    for (const bad of ['javascript:alert(1)', 'data:text/html,<script>', 'vbscript:x', '//evil.com']) {
      const nodes = parseInline(`[click](${bad})`)
      assert.ok(!nodes.some(n => n.type === 'link'), bad)
    }
    assert.equal(parseInline('[mail](mailto:a@b.co)')[0].type, 'link')
  })
  it('never produces HTML: raw tags stay as text', () => {
    const blocks = parseMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>')
    assert.deepEqual(types(blocks), ['paragraph', 'paragraph'])
    assert.equal(blocks[0].children[0].text, '<script>alert(1)</script>')
    assert.ok(!JSON.stringify(blocks).includes('"html"'))
  })
  it('recognizes file paths in prose and inline code, not versions or plain words', () => {
    const nodes = parseInline('Edited src/services/auth.js:84 and `tests/auth.test.js`, bumped to 1.2.3, see README.md.')
    const paths = nodes.filter(n => n.type === 'path').map(n => n.text)
    assert.deepEqual(paths, ['src/services/auth.js:84', 'tests/auth.test.js', 'README.md'])
    assert.ok(looksLikePath('package.json') && looksLikePath('./src/a.js') && !looksLikePath('1.2.3') && !looksLikePath('hello'))
    assert.equal(parseInline('`npm test`')[0].type, 'code')
  })
  it('handles emphasis, escapes and underscores in identifiers', () => {
    assert.deepEqual(types(parseInline('*em* and _em2_ and snake_case_name')), ['em', 'text', 'em', 'text'])
    assert.equal(parseInline('snake_case_name')[0].text, 'snake_case_name')
    assert.equal(parseInline('\\*literal\\*')[0].text, '*literal*')
  })
  it('is total: any input produces nodes without throwing', () => {
    for (const s of ['', '`', '```', '**', '[', '[a](', '| a |', '>', '- ', '1.', '#', '\u0000', 'a'.repeat(10_000)]) assert.doesNotThrow(() => parseMarkdown(s), JSON.stringify(s).slice(0, 20))
  })
})

describe('session titles', () => {
  it('derives short, useful titles from the first request', () => {
    assert.equal(deriveTitle('Fix the authentication race.'), 'Fix the authentication race')
    assert.equal(deriveTitle('Can you please add an export endpoint? It should stream CSV.'), 'Add an export endpoint')
    assert.equal(deriveTitle('please refactor the settings panel'), 'Refactor the settings panel')
    assert.equal(deriveTitle('I want you to rename getUser to fetchUser'), 'Rename getUser to fetchUser')
    assert.equal(deriveTitle('   '), 'New chat')
    assert.equal(deriveTitle(undefined), 'New chat')
  })
  it('truncates long titles at a word boundary and ignores code blocks', () => {
    const t = deriveTitle('Implement pagination for the repository listing endpoint with cursor support and tests')
    assert.ok(t.length <= 49 && t.endsWith('…') && !t.includes('  '))
    assert.equal(deriveTitle('```js\nconsole.log(1)\n```\nWhy does this log twice?'), 'Why does this log twice')
  })
})
