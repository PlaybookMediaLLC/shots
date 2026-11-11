import 'server-only'

import { generateText, stepCountIs, tool } from 'ai'
import type { WritingContext } from 'screenshot-studio-backend-sdk'
import { z } from 'zod'
import {
  type CaptionChannel,
  captionChannelSchema,
  copyProblems,
  platformLine,
} from '@/lib/captions/channels'
import type { DesignDocument } from '@/lib/design/document'
import { voiceInstructions } from '@/lib/write/voice'
import { models } from '../models'
import { CAPTIONS_INSTRUCTIONS } from '../prompts/captions'

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
 * `voice` is the one brand voice (RFC 024): the publishing identity's merged
 * brand and social-set context, or the workspace's when no set is chosen. It
 * carries what the product is, its calls to action and the prohibited terms
 * of both, which are enforced on every submission.
 */
export async function writeCopy(input: {
  channels: readonly CaptionChannel[]
  /** The set's platform guidance per channel, so each caption follows its own. */
  guidance?: Partial<Record<CaptionChannel, string>>
  document: DesignDocument
  notes?: string
  snapshotJpegBase64: string
  /** The brand voice; null only when the workspace has no brand profile. */
  voice: WritingContext | null
}): Promise<WrittenCopy> {
  let accepted: WrittenCopy | null = null
  const prohibited = input.voice?.prohibitedPhrases ?? []
  const visibleText = input.document.texts.map((text) => text.text).filter(Boolean)
  const context = [
    `<channels>${input.channels.join(',')}</channels>`,
    ...input.channels.map((channel) => platformLine(channel, input.guidance?.[channel])),
    `<visible-text>${visibleText.length ? visibleText.join(' | ') : '(none)'}</visible-text>`,
    input.notes ? `<notes>${input.notes}</notes>` : '',
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
    // Per-channel guidance sits on each platform line, so the shared voice drops its own.
    system:
      CAPTIONS_INSTRUCTIONS +
      voiceInstructions(
        input.voice && Object.keys(input.guidance ?? {}).length > 0
          ? { ...input.voice, platformGuidance: '' }
          : (input.voice ?? null)
      ),
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
