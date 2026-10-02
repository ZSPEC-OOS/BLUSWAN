// Command output arrives from arbitrary programs. Before it reaches the UI it is reduced to plain text:
// terminal escape sequences are removed (colors, cursor movement, OSC titles/links), carriage-return
// progress lines collapse to their final state, and other control characters are dropped. React escapes the
// result as text; nothing here is ever used as HTML.

// eslint-disable-next-line no-control-regex
const CSI = /\u001b\[[0-?]*[ -/]*[@-~]/g
// eslint-disable-next-line no-control-regex
const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g
// eslint-disable-next-line no-control-regex
const OTHER_ESC = /\u001b[@-Z\\-_]|\u001b[()][A-Za-z0-9]/g
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g

export function sanitizeTerminalText(input) {
  let s = String(input ?? '')
  s = s.replace(OSC, '').replace(CSI, '').replace(OTHER_ESC, '')
  s = s.replace(/\r\n/g, '\n')
  s = s.split('\n').map(line => (line.includes('\r') ? line.split('\r').filter((_, i, a) => i === a.length - 1 || a[a.length - 1] === '').pop() ?? '' : line)).join('\n')
  return s.replace(CONTROL, '').replaceAll('\u001b', '')
}
