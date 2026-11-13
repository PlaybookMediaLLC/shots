import { z } from 'zod'
import { platformCaptionLength } from '@/lib/content-drafts/serialize'

/**
 * Social captions per platform: each platform's length limit and the
 * conventions a caption should follow there. Lengths count characters the
 * way the platform does: X counts every link as 23 characters.
 */

/** Platforms captions are written for. */
export const captionChannelSchema = z.enum([
  'x',
  'linkedin',
  'instagram',
  'threads',
  'bluesky',
  'facebook',
])
/** A caption platform. */
export type CaptionChannel = z.infer<typeof captionChannelSchema>

/** Each platform's name, hard limit, and writing conventions. */
export const CAPTION_CHANNELS: Record<
  CaptionChannel,
  { conventions: string; limit: number; name: string }
> = {
  bluesky: {
    conventions: 'Conversational, one or two short sentences, at most one hashtag.',
    limit: 300,
    name: 'Bluesky',
  },
  facebook: {
    conventions: 'Friendly, two to four sentences, a clear call to action, no hashtag stuffing.',
    limit: 2000,
    name: 'Facebook',
  },
  instagram: {
    conventions:
      'Hook in the first line, short paragraphs, then 3 to 8 relevant hashtags on the last line. Links are not clickable in captions.',
    limit: 2200,
    name: 'Instagram',
  },
  linkedin: {
    conventions:
      'Professional, a strong first line, short paragraphs, the benefit for the reader, at most three hashtags at the end.',
    limit: 3000,
    name: 'LinkedIn',
  },
  threads: {
    conventions: 'Casual and brief, one idea, at most one hashtag.',
    limit: 500,
    name: 'Threads',
  },
  x: {
    conventions: 'Punchy, one idea, at most two hashtags; leave room for a link.',
    limit: 280,
    name: 'X',
  },
}

/** A caption's length as its platform counts it: the composer's rule, UTF-16 units on Facebook. */
export function captionLength(text: string, channel: CaptionChannel): number {
  return channel === 'facebook' ? text.length : platformCaptionLength(channel, text)
}

/**
 * The writer's line for one platform: its limit and conventions, then the
 * social set's guidance for that channel when it has some. Guidance is the
 * set owner's text, so tags that could close this line or the voice's fences
 * are removed before it is quoted.
 */
export function platformLine(channel: CaptionChannel, guidance?: string): string {
  const { conventions, limit, name } = CAPTION_CHANNELS[channel]
  const own = guidance?.replace(/<\/?(?:platform|sample|writing_context)\b[^>]*>/gi, '').trim()
  return `<platform id="${channel}">${name}: at most ${limit} characters. ${conventions}${own ? ` Voice for this channel: ${own}` : ''}</platform>`
}

/** Alt text should stay short enough for screen readers to read in one go. */
export const ALT_TEXT_LIMIT = 250

/** Generated captions and alt text for a design. */
export const designCopySchema = z.object({
  altText: z.string().trim().max(1000).optional(),
  captions: z.partialRecord(captionChannelSchema, z.string().trim().max(3000)).default({}),
})
/** A design's generated copy. */
export type DesignCopy = z.infer<typeof designCopySchema>

/** Problems with a submission, for the model to fix; empty when it is acceptable. */
export function copyProblems(
  input: { altText: string; captions: ReadonlyArray<{ channel: CaptionChannel; text: string }> },
  channels: readonly CaptionChannel[],
  prohibitedTerms: readonly string[]
): string[] {
  const problems: string[] = []
  if (!input.altText.trim()) problems.push('The alt text is empty.')
  if (input.altText.length > ALT_TEXT_LIMIT) {
    problems.push(
      `The alt text is ${input.altText.length} characters; keep it under ${ALT_TEXT_LIMIT}.`
    )
  }
  for (const channel of channels) {
    const caption = input.captions.find((entry) => entry.channel === channel)
    if (!caption?.text.trim()) {
      problems.push(`Missing the ${CAPTION_CHANNELS[channel].name} caption.`)
      continue
    }
    const length = captionLength(caption.text, channel)
    const { limit, name } = CAPTION_CHANNELS[channel]
    if (length > limit)
      problems.push(`The ${name} caption is ${length} characters; the limit is ${limit}.`)
  }
  const everything = [input.altText, ...input.captions.map((caption) => caption.text)]
    .join('\n')
    .toLowerCase()
  for (const term of prohibitedTerms) {
    if (term.trim() && everything.includes(term.trim().toLowerCase())) {
      problems.push(`"${term}" is a prohibited term for this brand.`)
    }
  }
  return problems
}
