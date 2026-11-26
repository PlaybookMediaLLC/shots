import 'server-only'

import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateText,
  Output,
  streamText,
  type UIMessage,
} from 'ai'
import { z } from 'zod'
import { withAiCredits } from '@/lib/ai/metering'
import { models } from '@/lib/ai/models'
import { productContext } from '@/lib/ai/assistant/product-context'
import {
  DOCUMENT_COPILOT_INSTRUCTIONS,
  DOCUMENT_EDITOR_INSTRUCTIONS,
  DOCUMENT_REVIEW_INSTRUCTIONS,
} from '@/lib/ai/prompts/document-editor'
import {
  type documentChatRequestSchema,
  type documentCopilotRequestSchema,
  documentReviewCommentSchema,
  type documentVoiceQuerySchema,
} from '@/lib/api/contracts/ai'
import type { OrganizationAccess } from '@/lib/auth/access'
import { getWorkspaceVoice } from '@/lib/launch/store'
import { writingContext } from '@/lib/write/ai-route'
import { CAPABILITIES } from '@/lib/write/capabilities'
import { voiceInstructions } from '@/lib/write/voice'

type DocumentChatRequest = z.infer<typeof documentChatRequestSchema>
type DocumentVoiceQuery = z.infer<typeof documentVoiceQuerySchema>

/**
 * The voice the editor's AI writes in: the draft's (its social set's, for the
 * channel being edited) when the caller can see that draft, else the
 * workspace's. It starts loading at once and is awaited inside the credit scope.
 */
export function documentVoice(access: OrganizationAccess, query: DocumentVoiceQuery) {
  const voice = (async () =>
    (query.channel ? await writingContext(access, query.draftId, query.channel) : null) ??
    getWorkspaceVoice(access))()
  voice.catch(() => undefined)
  return voice
}

/** Everything after the task: the voice, the product's facts and the platform's limit. */
async function systemPrompt(
  access: OrganizationAccess,
  instructions: string,
  query: DocumentVoiceQuery
) {
  const voice = documentVoice(access, query)
  const product = productContext(access)
  const limit = query.channel
    ? `\n\nEach post is for ${query.channel} and may hold ${CAPABILITIES[query.channel].captionLimit} characters.`
    : ''
  return [instructions + limit + voiceInstructions(await voice), await product]
    .filter(Boolean)
    .join('\n\n')
}

/** The document goes to the model as content, fenced, never as instructions. */
async function modelMessages(body: DocumentChatRequest) {
  const document = (body.system ?? '').replaceAll('</document_context>', '')
  return [
    { content: `<document_context>\n${document}\n</document_context>`, role: 'user' as const },
    ...(await convertToModelMessages(body.messages as unknown as UIMessage[])),
  ]
}

/**
 * Streams the editor AI menu's answer. The stream opens with the tool the
 * editor asked for: `edit` replaces the selection, `generate` inserts blocks,
 * and `comment` sends one `data-comment` part per review comment. The credit
 * scope stays open until the model finishes, so the whole stream is charged.
 */
export function streamDocumentChat(
  access: OrganizationAccess,
  body: DocumentChatRequest,
  query: DocumentVoiceQuery
): Promise<Response> {
  const toolName = body.ctx?.toolName ?? 'generate'
  if (toolName === 'comment') return reviewDocument(access, body, query)
  return new Promise<Response>((resolve, reject) => {
    withAiCredits(access, async () => {
      const result = streamText({
        messages: await modelMessages(body),
        model: models.languageModel('drafting'),
        system: await systemPrompt(access, DOCUMENT_EDITOR_INSTRUCTIONS, query),
      })
      const stream = createUIMessageStream({
        execute: ({ writer }) => {
          writer.write({ data: toolName, type: 'data-toolName' })
          writer.merge(result.toUIMessageStream({ sendStart: false }))
        },
      })
      resolve(createUIMessageStreamResponse({ stream }))
      await result.consumeStream()
    }).catch(reject)
  })
}

async function reviewDocument(
  access: OrganizationAccess,
  body: DocumentChatRequest,
  query: DocumentVoiceQuery
): Promise<Response> {
  const comments = await withAiCredits(access, async () => {
    const { output } = await generateText({
      messages: await modelMessages(body),
      model: models.languageModel('drafting'),
      output: Output.object({
        schema: z.object({ comments: z.array(documentReviewCommentSchema).max(5) }),
      }),
      system: await systemPrompt(access, DOCUMENT_REVIEW_INSTRUCTIONS, query),
    })
    return output.comments
  })
  const stream = createUIMessageStream({
    execute: ({ writer }) => {
      writer.write({ data: 'comment', type: 'data-toolName' })
      for (const comment of comments) writer.write({ data: comment, type: 'data-comment' })
      writer.write({ data: comments.length, type: 'data-reviewed' })
    },
  })
  return createUIMessageStreamResponse({ stream })
}

/** One inline completion for the editor's copilot. */
export function completeDocumentText(
  access: OrganizationAccess,
  body: z.infer<typeof documentCopilotRequestSchema>,
  query: DocumentVoiceQuery
): Promise<{ text: string }> {
  return withAiCredits(access, async () => {
    const { text } = await generateText({
      model: models.languageModel('fast'),
      prompt: body.prompt,
      system: await systemPrompt(access, DOCUMENT_COPILOT_INSTRUCTIONS, query),
    })
    return { text: text.trim() || '0' }
  })
}
