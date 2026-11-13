import assert from 'node:assert/strict'
import test from 'node:test'
import { POST_BREAK } from '@/lib/content-drafts/serialize'
import type { PlateBody, DraftChannel } from '@/lib/write/document'
import { buildPublication, type PublicationDraft } from '@/lib/write/publication'
import { buildPublication as oldBuild } from './zz-adv-old-publication'
import { readVersions, withOptions } from '@/lib/write/versions'
import { stagedChecks, previewPublications } from '@/lib/write/batch'

const p = (text: string) => ({ children: [{ text }], type: 'p' })
const brk = (extra: object = {}) => ({ children: [{ text: '' }], type: POST_BREAK, ...extra })
const vid = { type: 'video', assetId: 'cvideo000001', children: [{ text: '' }] }
const img = { type: 'img', assetId: 'cimage000001', children: [{ text: '' }] }
const gif = { type: 'img', assetId: 'cgif00000001', mimeType: 'image/gif', children: [{ text: '' }] }
const draft = (extra: Partial<PublicationDraft> = {}): PublicationDraft => ({
  article: null, body: [p('x')], kind: 'standard', platformVersions: readVersions(undefined), target: null, ...extra,
})
const channels: DraftChannel[] = ['x', 'linkedin', 'instagram', 'threads', 'bluesky', 'mastodon', 'tiktok', 'youtube']
const bodies: Record<string, PlateBody> = {
  text: [p('Read https://example.com/story')],
  textImg: [p('Read https://example.com/story'), img],
  textVid: [p('Read https://example.com/story'), vid],
  gif: [p('Read https://example.com/story'), gif],
  threadVidReply: [brk(), p('First https://example.com/story'), brk(), p('Second'), vid],
  threadLinkReply: [brk(), p('First'), brk(), p('Second https://example.com/story'), img],
}
const card = (removed?: boolean) => ({ url: 'https://example.com/story', title: 'Story', ...(removed === undefined ? {} : { removed }) })
const standings = [undefined, {}, { maxWeightedCharacters: 280 as const }, { maxWeightedCharacters: 280 as const, xVideoMaxSeconds: null }, { maxWeightedCharacters: 25_000 as const, xVideoMaxSeconds: 7500 }, { maxWeightedCharacters: null, xVideoMaxSeconds: null }, { tiktokCreator: undefined }]

test('differential vs origin/develop', () => {
  const diffs: string[] = []
  for (const channel of channels)
    for (const [name, b] of Object.entries(bodies))
      for (const kind of ['standard', 'article', 'quote', 'reply'] as const)
        for (const c of [undefined, card(), card(false), card(true)])
          for (const standing of standings) {
            let versions = readVersions(undefined)
            if (c) versions = withOptions(versions, channel, { linkPreviews: [c] })
            const d = draft({ body: b, kind, platformVersions: versions, article: kind === 'article' ? { title: 'T' } as never : null, target: kind === 'quote' || kind === 'reply' ? { platform: channel, remoteId: '123', url: 'https://x.com/a/status/123' } as never : null })
            const acc = { channel, connectionId: 'c1', standing: standing as never }
            const n = buildPublication(d, acc)
            const o = oldBuild(d, acc)
            const nj = JSON.stringify({ p: n.problems, t: n.target, a: n.accountProblems })
            const oj = JSON.stringify({ p: o.problems, t: o.target, a: o.accountProblems })
            if (nj !== oj) diffs.push(`${channel}/${name}/${kind}/card=${JSON.stringify(c?.removed)}/standing=${JSON.stringify(standing)}\n  old=${oj}\n  new=${nj}`)
          }
  const summary = new Map<string, number>()
  for (const d of diffs) {
    const [head] = d.split('\n')
    const k = head.split('/').slice(0, 1).join('/') + ' ' + (d.includes('Reconnect X to verify this account') ? 'video' : d.includes('preview removal') ? 'removal' : 'other')
    summary.set(k, (summary.get(k) ?? 0) + 1)
  }
  console.log([...summary])
  console.log(diffs.filter((d) => d.includes('video limits')).map((d)=>d.split('\n')[0]).join('\n'))
})
