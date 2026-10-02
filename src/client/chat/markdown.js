// A small, safe Markdown parser: text in, plain data out. Rendering builds React elements from this
// AST (never innerHTML), so raw HTML in a message is always shown as text. Partial input is fine
// (an unclosed code fence while streaming simply keeps extending the code block).

const SAFE_HREF = /^(https?:\/\/|mailto:)/i
// A workspace-relative file path: has a directory separator or a known extension, optional :line.
const PATH_RE = /(?:^|(?<=[\s("'`]))((?:\.{0,2}\/)?(?:[\w@.-]+\/)+[\w@.-]+\.[A-Za-z0-9]{1,8}|[\w@-]+\.(?:[cm]?[jt]sx?|json|md|css|scss|html|py|rs|go|java|ya?ml|toml|lock|mjs|cjs))(?::\d+(?::\d+)?)?(?![\w/])/g

export const looksLikePath = (s) => /^(?:\.{0,2}\/)?(?:[\w@.-]+\/)*[\w@.-]+\.[A-Za-z0-9]{1,8}(?::\d+(?::\d+)?)?$/.test(s) && !/^\d+(\.\d+)+$/.test(s)

function pushText(out, text) {
  if (!text) return
  let last = 0
  for (const m of text.matchAll(PATH_RE)) {
    if (m.index > last) out.push({ type: 'text', text: text.slice(last, m.index) })
    out.push({ type: 'path', text: m[0] })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) })
}

/** Inline syntax: `code`, **strong**, *em* / _em_, [text](url). Everything else is text (paths are detected). */
export function parseInline(src) {
  const out = []
  let i = 0
  let buf = ''
  const flush = () => { pushText(out, buf); buf = '' }
  while (i < src.length) {
    const c = src[i]
    if (c === '\\' && i + 1 < src.length && /[\\`*_[\]()#>|~-]/.test(src[i + 1])) { buf += src[i + 1]; i += 2; continue }
    if (c === '`') {
      const run = /^`+/.exec(src.slice(i))[0]
      const end = src.indexOf(run, i + run.length)
      if (end > 0) { flush(); const text = src.slice(i + run.length, end).trim(); out.push(looksLikePath(text) ? { type: 'path', text, code: true } : { type: 'code', text }); i = end + run.length; continue }
    }
    if ((c === '*' && src[i + 1] === '*') || (c === '_' && src[i + 1] === '_')) {
      const mark = c + c
      const end = src.indexOf(mark, i + 2)
      if (end > i + 2) { flush(); out.push({ type: 'strong', children: parseInline(src.slice(i + 2, end)) }); i = end + 2; continue }
    }
    if ((c === '*' || c === '_') && src[i + 1] && !/\s/.test(src[i + 1]) && (c === '*' || !/\w/.test(src[i - 1] ?? ' '))) {
      const end = src.indexOf(c, i + 1)
      if (end > i + 1 && !/\s/.test(src[end - 1]) && (c === '*' || !/\w/.test(src[end + 1] ?? ' '))) { flush(); out.push({ type: 'em', children: parseInline(src.slice(i + 1, end)) }); i = end + 1; continue }
    }
    if (c === '[') {
      const m = /^\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(src.slice(i))
      if (m) {
        flush()
        out.push(SAFE_HREF.test(m[2]) ? { type: 'link', href: m[2], children: parseInline(m[1]) } : { type: 'text', text: m[1] }) // unsafe schemes (javascript:, data:) become plain text
        i += m[0].length
        continue
      }
    }
    buf += c
    i++
  }
  flush()
  return out
}

const isTableSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l) && l.includes('-')
const splitRow = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim())

/** @returns {object[]} block nodes */
export function parseMarkdown(src) {
  const lines = String(src ?? '').replace(/\r\n/g, '\n').split('\n')
  const blocks = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (/^\s*$/.test(line)) { i++; continue }

    const fence = /^(\s*)(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/.exec(line)
    if (fence) {
      const body = []
      i++
      while (i < lines.length && !new RegExp(`^\\s*${fence[2][0]}{${fence[2].length},}\\s*$`).test(lines[i])) body.push(lines[i++].replace(new RegExp(`^ {0,${fence[1].length}}`), ''))
      i++ // closing fence (absent while streaming)
      blocks.push({ type: 'code', lang: fence[3] || null, text: body.join('\n') })
      continue
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (h) { blocks.push({ type: 'heading', level: h[1].length, children: parseInline(h[2]) }); i++; continue }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { blocks.push({ type: 'rule' }); i++; continue }
    if (/^\s*>/.test(line)) {
      const q = []
      while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''))
      blocks.push({ type: 'blockquote', children: parseMarkdown(q.join('\n')) })
      continue
    }
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const header = splitRow(line).map(parseInline)
      i += 2
      const rows = []
      while (i < lines.length && lines[i].includes('|') && !/^\s*$/.test(lines[i])) rows.push(splitRow(lines[i++]).map(parseInline))
      blocks.push({ type: 'table', header, rows })
      continue
    }
    const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line)
    if (li) {
      const ordered = /\d/.test(li[2])
      const items = []
      while (i < lines.length) {
        const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i])
        if (!m || /\d/.test(m[2]) !== ordered) break
        const text = [m[3]]
        i++
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) text.push(lines[i++].trim())
        items.push(parseInline(text.join(' ')))
      }
      blocks.push({ type: 'list', ordered, items })
      continue
    }
    const para = [line]
    i++
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(\s*)(`{3,}|~{3,})/.test(lines[i]) && !/^#{1,6}\s/.test(lines[i]) && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) && !/^\s*>/.test(lines[i])) para.push(lines[i++])
    blocks.push({ type: 'paragraph', children: parseInline(para.join('\n')) })
  }
  return blocks
}
