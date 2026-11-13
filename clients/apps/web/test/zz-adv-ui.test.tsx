import test from 'node:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { LinkCards } from '@/components/write/composer/link-cards'

test('render LinkCards', () => {
  const url = 'https://example.com/story'
  const text = `Read ${url} and https://x.com/a/status/123`
  for (const channel of ['x', 'bluesky', 'linkedin', 'threads', 'mastodon', 'instagram'] as const)
    for (const removed of [undefined, true]) {
      const html = renderToStaticMarkup(
        <LinkCards text={text} channel={channel} cards={[{ url, title: 'Story', ...(removed ? { removed } : {}) }]} onChange={() => {}} onQuote={() => {}} />
      )
      console.log(`--- ${channel} removed=${removed}\n${html.replace(/class="[^"]*"/g, '')}`)
    }
})
