import { useState } from 'react'
import './chat.css'

/** Monospace block with horizontal scrolling and a copy button. No syntax highlighting (not required). */
export default function CodeBlock({ text, lang }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* clipboard unavailable: nothing to do */ }
  }
  return (
    <figure className="code">
      <figcaption className="code__bar">
        <span className="code__lang">{lang ?? 'text'}</span>
        <button type="button" className="code__copy" onClick={copy} aria-label="Copy code to clipboard">{copied ? 'Copied' : 'Copy'}</button>
      </figcaption>
      <pre className="code__pre" tabIndex={0}><code>{text}</code></pre>
    </figure>
  )
}
