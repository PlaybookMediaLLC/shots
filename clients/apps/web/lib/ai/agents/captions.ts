import 'server-only'

import { generateText, stepCountIs, tool } from 'ai'
import type { WritingContext } from 'screenshot-studio-backend-sdk'
import { z } from 'zod'
import {
  CAPTION_CHANNELS,
  type CaptionChannel,
  captionChannelSchema,
  copyProblems,
} from '@/lib/captions/channels'
import type { DesignDocument } from '@/lib/design/document'
import { voiceInstructions } from '@/lib/write/voice'
import { models } from '../models'
import { CAPTIONS_INSTRUCTIONS } from '../prompts/captions'

/** The brand's voice, from the workspace brand profile, when it has one. */
export type BrandVoice = {
  audience?: string
  ctaConventions?: string | null
  productDescription?: string
  prohibitedTerms: string[]
  tone?: string
}

/** What the writer returns. */
export type WrittenCopy = { altText: string; captions: Partial<Record<CaptionChannel, string>> }

const submission = z.object({
  altText: z.string().describe('Literal description of what is visible.'),
  captions: z.array(z.object({ channel: captionChannelSchema, text: z.string() })),
})

/**
 * Write alt text and a caption for each requested platform from a snapshot
 * of the design and its text. Every submission is checked (lengths as each
 * platform counts them, missing platforms, prohibited terms) and sent back
 * until it passes.
 *
 * `voice` is the publishing identity's writing context (RFC 024): the same
 * merged brand and social-set voice Refine and the writing assistant use, so
 * a caption written here sounds like the account that will post it. It has
 * already absorbed the brand's tone and audience and may override them, so
 * with a voice the brand contributes only what the voice does not carry:
 * what the product is and how it asks for action. Prohibited terms are the
 * union of both and are enforced on every submission.
 */
export async function writeCopy(input: {
  brand: BrandVoice | null
  channels: readonly CaptionChannel[]
  document: DesignDocument
  notes?: string
  snapshotJpegBase64: string
  voice?: WritingContext | null
}): Promise<WrittenCopy> {
  let accepted: WrittenCopy | null = null
  const prohibited = [
    ...(input.brand?.prohibitedTerms ?? []),
    ...(input.voice?.prohibitedPhrases ?? []),
  ]
  const visibleText = input.document.texts.map((text) => text.text).filter(Boolean)
  const context = [
    `<channels>${input.channels.join(',')}</channels>`,
    ...input.channels.map(
      (channel) =>
        `<platform id="${channel}">${CAPTION_CHANNELS[channel].name}: at most ${CAPTION_CHANNELS[channel].limit} characters. ${CAPTION_CHANNELS[channel].conventions}</platform>`
    ),
    `<visible-text>${visibleText.length ? visibleText.join(' | ') : '(none)'}</visible-text>`,
    input.notes ? `<notes>${input.notes}</notes>` : '',
    input.brand
      ? `<brand>${JSON.stringify({
          audience: input.voice ? undefined : input.brand.audience,
          callsToAction: input.brand.ctaConventions,
          product: input.brand.productDescription,
          prohibited,
          tone: input.voice ? undefined : input.brand.tone,
        })}</brand>`
      : '',
  ]
    .filter(Boolean)
    .join('\n')
  await generateText({
    messages: [
      {
        content: [
          { text: context, type: 'text' },
          { data: input.snapshotJpegBase64, mediaType: 'image/jpeg', type: 'file' },
        ],
        role: 'user',
      },
    ],
    model: models.languageModel('drafting'),
    stopWhen: stepCountIs(4),
    system: CAPTIONS_INSTRUCTIONS + voiceInstructions(input.voice ?? null),
    tools: {
      submitCaptions: tool({
        description: 'Submit the alt text and one caption per requested platform.',
        execute: async (submitted: z.infer<typeof submission>) => {
          const problems = copyProblems(submitted, input.channels, prohibited)
          if (problems.length) return { ok: false, problems }
          accepted = {
            altText: submitted.altText.trim(),
            captions: Object.fromEntries(
              submitted.captions
                .filter((caption) => input.channels.includes(caption.channel))
                .map((caption) => [caption.channel, caption.text.trim()])
            ),
          }
          return { ok: true }
        },
        inputSchema: submission,
      }),
    },
  })
  if (!accepted) throw new Error('The captions did not come back within the limits. Try again.')
  return accepted
}
