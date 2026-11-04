import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import { divLinesAsParagraphs } from '@/lib/content-drafts/paste'

// jsdom is hoisted into the workspace (the editor package tests with it); the
// widened specifier keeps the type-checker from asking for its declarations.
const JSDOM_SPECIFIER: string = 'jsdom'
let parser: DOMParser
before(async () => {
  const { JSDOM } = (await import(JSDOM_SPECIFIER)) as {
    JSDOM: new () => { window: { DOMParser: new () => DOMParser } }
  }
  parser = new new JSDOM().window.DOMParser()
})

test('pasted div lines become paragraphs instead of running together', () => {
  assert.equal(
    divLinesAsParagraphs('<div>Do not publish.</div><div>QA <b>pasted</b></div>', parser),
    '<p>Do not publish.</p><p>QA <b>pasted</b></p>'
  )
  // Only the innermost divs are lines; a wrapper keeps its blocks.
  assert.equal(
    divLinesAsParagraphs('<div><div>One</div><div><br></div><div>Two</div></div>', parser),
    '<div><p>One</p><p><br></p><p>Two</p></div>'
  )
})

test('HTML without div lines is left to the editor', () => {
  assert.equal(divLinesAsParagraphs('<p>One</p><p>Two</p>', parser), null)
  assert.equal(divLinesAsParagraphs('One<br>Two', parser), null)
})
