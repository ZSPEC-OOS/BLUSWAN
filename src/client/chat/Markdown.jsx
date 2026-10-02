import { memo, useMemo } from 'react'
import { parseMarkdown } from './markdown.js'
import CodeBlock from './CodeBlock.jsx'
import './chat.css'

function Path({ text, onOpenPath }) {
  const path = text.replace(/:\d+(?::\d+)?$/, '')
  return onOpenPath
    ? <button type="button" className="path" onClick={() => onOpenPath(path)} title={`Open ${path}`}>{text}</button>
    : <code className="path">{text}</code>
}

export function Inline({ nodes, onOpenPath }) {
  return nodes.map((n, i) => {
    switch (n.type) {
      case 'text': return n.text
      case 'code': return <code key={i} className="inline-code">{n.text}</code>
      case 'path': return <Path key={i} text={n.text} onOpenPath={onOpenPath} />
      case 'strong': return <strong key={i}><Inline nodes={n.children} onOpenPath={onOpenPath} /></strong>
      case 'em': return <em key={i}><Inline nodes={n.children} onOpenPath={onOpenPath} /></em>
      case 'link': return <a key={i} href={n.href} target="_blank" rel="noopener noreferrer nofollow"><Inline nodes={n.children} onOpenPath={onOpenPath} /></a>
      default: return null
    }
  })
}

function Blocks({ blocks, onOpenPath }) {
  return blocks.map((b, i) => {
    switch (b.type) {
      case 'paragraph': return <p key={i}><Inline nodes={b.children} onOpenPath={onOpenPath} /></p>
      case 'heading': { const H = `h${Math.min(b.level + 2, 6)}`; return <H key={i} className="md-h"><Inline nodes={b.children} onOpenPath={onOpenPath} /></H> }
      case 'code': return <CodeBlock key={i} text={b.text} lang={b.lang} />
      case 'list': {
        const L = b.ordered ? 'ol' : 'ul'
        return <L key={i}>{b.items.map((item, j) => <li key={j}><Inline nodes={item} onOpenPath={onOpenPath} /></li>)}</L>
      }
      case 'table':
        return (
          <div key={i} className="md-table" tabIndex={0}>
            <table>
              <thead><tr>{b.header.map((c, j) => <th key={j}><Inline nodes={c} onOpenPath={onOpenPath} /></th>)}</tr></thead>
              <tbody>{b.rows.map((r, j) => <tr key={j}>{r.map((c, k) => <td key={k}><Inline nodes={c} onOpenPath={onOpenPath} /></td>)}</tr>)}</tbody>
            </table>
          </div>
        )
      case 'blockquote': return <blockquote key={i}><Blocks blocks={b.children} onOpenPath={onOpenPath} /></blockquote>
      case 'rule': return <hr key={i} />
      default: return null
    }
  })
}

/** Safe Markdown: built from a parsed AST into React elements, never HTML strings. */
function Markdown({ text, onOpenPath }) {
  const blocks = useMemo(() => parseMarkdown(text), [text])
  return <div className="md"><Blocks blocks={blocks} onOpenPath={onOpenPath} /></div>
}

export default memo(Markdown)
