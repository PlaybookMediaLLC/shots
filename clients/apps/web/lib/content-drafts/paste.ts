/** Elements that already make their own block when the editor reads pasted HTML. */
const BLOCKS =
  'address,article,aside,blockquote,div,dl,figure,footer,h1,h2,h3,h4,h5,h6,header,hr,li,main,nav,ol,p,pre,section,table,ul'

/**
 * Many apps put each copied line in its own `<div>`. The editor reads a div as
 * inline, so pasted lines ran together ("Do not publish.QA pasted"). Each div
 * that holds no other block becomes a paragraph. Null when nothing changes.
 */
export function divLinesAsParagraphs(
  html: string,
  parser: Pick<DOMParser, 'parseFromString'> = new DOMParser()
): string | null {
  if (!/<div[\s>]/i.test(html)) return null
  const doc = parser.parseFromString(html, 'text/html')
  const lines = [...doc.body.querySelectorAll('div')].filter((div) => !div.querySelector(BLOCKS))
  if (!lines.length) return null
  for (const div of lines) {
    const paragraph = doc.createElement('p')
    paragraph.append(...div.childNodes)
    div.replaceWith(paragraph)
  }
  return doc.body.innerHTML
}
