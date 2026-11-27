import { z } from 'zod'
import { defineContract } from '@/lib/api/contract'
import { contentDraftIdSchema } from '@/lib/api/contracts/content-draft-list'
import { onlyInlineFiles } from '@/lib/assistant/attachments'
import { INTERNAL_HREF_MAX, pageContextSchema } from '@/lib/assistant/page-context'
import { measureMessageChars } from '@/lib/assistant/snapshots'
import { draftChannelSchema } from '@/lib/write/document'

/** Roles the browser may send. It may not inject system or operator messages. */
export const editorMessageRoleSchema = z.enum(['user', 'assistant', 'tool'])

/** Roles the model's response messages carry. */
export const editorResponseRoleSchema = z.enum(['assistant', 'tool'])

/** Most messages one workspace assistant request may carry. */
export const MAX_ASSISTANT_MESSAGES = 80

/** Most total text characters one workspace assistant request may carry (excluding inline media). */
export const MAX_ASSISTANT_MESSAGES_CHARS = 400_000

/** Most client-side surface tool names one assistant turn may declare. */
export const MAX_ASSISTANT_CLIENT_TOOLS = 32

/** A pending tool call the browser surface adapter must execute and return. */
export const assistantPendingToolCallSchema = z.object({
  input: z.unknown(),
  toolCallId: z.string(),
  toolName: z.string(),
})

/** One pending tool call returned by the unified assistant. */
export type AssistantPendingToolCall = z.infer<typeof assistantPendingToolCallSchema>

/**
 * One turn (or tool-continuation step) of the unified assistant: the
 * conversation so far, the page and active editing surface, optional selection
 * scope, and which client-executed surface tools are available right now.
 */
export const workspaceAssistantRequestSchema = z.object({
  clientTools: z.array(z.string().max(64)).max(MAX_ASSISTANT_CLIENT_TOOLS).default([]),
  messages: z
    .array(z.looseObject({ role: editorMessageRoleSchema }))
    .min(1)
    .max(MAX_ASSISTANT_MESSAGES)
    .refine(onlyInlineFiles, 'Attach images inline: JPEG, PNG, or WebP.')
    .refine(
      (messages) =>
        measureMessageChars(messages, {
          allowInlineFileData: true,
          limit: MAX_ASSISTANT_MESSAGES_CHARS,
        }) <= MAX_ASSISTANT_MESSAGES_CHARS,
      'Conversation history is too large. Start a new thread.'
    ),
  page: pageContextSchema,
  selection: z.string().max(200).nullable().default(null),
})

/** A place in the app the assistant offers to open. */
export const assistantLinkSchema = z.object({
  href: z.string().max(INTERNAL_HREF_MAX),
  label: z.string().max(120),
})

/** Characters of one post the assistant drafts. */
export const ASSISTANT_POST_MAX = 3_000
/** Posts one reply may draft. */
export const ASSISTANT_POSTS_MAX = 2

/** A post the assistant wrote, offered to open as a draft. */
export const assistantPostSchema = z.object({ text: z.string().min(1).max(ASSISTANT_POST_MAX) })

/**
 * The assistant's reply, any pending client-side surface tool calls, server
 * tool steps taken, the places it offers, the posts it wrote, and the turn's
 * AI SDK messages, which the browser keeps and sends with its next step.
 */
export const workspaceAssistantResponseSchema = z.object({
  // Defaulted, so a browser newer than the server mid-deploy still reads the reply.
  done: z.boolean().default(true),
  links: z.array(assistantLinkSchema),
  messages: z.array(z.looseObject({ role: editorResponseRoleSchema })),
  pendingToolCalls: z.array(assistantPendingToolCallSchema).default([]),
  posts: z.array(assistantPostSchema).max(ASSISTANT_POSTS_MAX).default([]),
  text: z.string(),
  toolSteps: z.array(z.string().max(160)).default([]),
})

/** One line of the reply stream while the model works. */
export const assistantProgressSchema = z.discriminatedUnion('type', [
  z.object({ text: z.string(), type: z.literal('text') }),
  z.object({ name: z.string(), type: z.literal('tool') }),
])

/** One progress line of the assistant stream. */
export type AssistantProgress = z.infer<typeof assistantProgressSchema>

/**
 * One line of `POST /api/ai/assistant`'s newline-delimited reply: progress,
 * then either the finished reply or why the turn failed.
 */
export const assistantStreamLineSchema = z.discriminatedUnion('type', [
  ...assistantProgressSchema.options,
  z.object({ reply: workspaceAssistantResponseSchema, type: z.literal('reply') }),
  z.object({ error: z.string(), type: z.literal('error') }),
])

/** One line of the assistant stream. */
export type AssistantStreamLine = z.infer<typeof assistantStreamLineSchema>

/** `POST /api/ai/assistant` */
export const workspaceAssistantContract = defineContract({
  body: workspaceAssistantRequestSchema,
  method: 'POST',
  name: 'ai.assistant',
  output: workspaceAssistantResponseSchema,
  path: '/api/ai/assistant',
  summary: 'Answer one turn of the workspace assistant with the page it is asked from',
})

/** Most messages one document-editor AI request may carry. */
export const MAX_DOCUMENT_MESSAGES = 40

/** Most total text characters one document-editor AI request's messages may carry. */
export const MAX_DOCUMENT_MESSAGES_CHARS = 200_000

/** Roles the document editor may send; it may not inject system messages. */
export const documentMessageRoleSchema = z.enum(['user', 'assistant'])

/** What the document AI menu asks for (the editor's tool names). */
export const documentToolNameSchema = z.enum(['comment', 'edit', 'generate'])

/**
 * One document AI menu request, as the AI SDK chat transport posts it.
 * `system` is the editor's rendering of the document and selection: it is
 * untrusted user content, so the server passes it to the model as context and
 * never as instructions.
 */
export const documentChatRequestSchema = z.looseObject({
  ctx: z.looseObject({ toolName: documentToolNameSchema.nullable().optional() }).optional(),
  messages: z
    .array(
      z.looseObject({
        parts: z.array(z.looseObject({ type: z.string() })).max(100),
        role: documentMessageRoleSchema,
      })
    )
    .min(1)
    .max(MAX_DOCUMENT_MESSAGES)
    .refine(
      (messages) =>
        measureMessageChars(messages, {
          allowInlineFileData: false,
          limit: MAX_DOCUMENT_MESSAGES_CHARS,
        }) <= MAX_DOCUMENT_MESSAGES_CHARS,
      'Conversation history is too large.'
    ),
  system: z.string().max(120_000).optional(),
})

/**
 * The draft the document editor writes, and the platform being edited, so the
 * AI writes in that draft's voice (its social set's, for that channel). Without
 * them, or for a draft the caller cannot see, the workspace voice applies.
 */
export const documentVoiceQuerySchema = z.object({
  channel: draftChannelSchema.optional(),
  draftId: contentDraftIdSchema.optional(),
})

/** `POST /api/ai/document`: streams AI SDK UI message parts. */
export const documentChatContract = defineContract({
  body: documentChatRequestSchema,
  method: 'POST',
  name: 'ai.document',
  output: z.never(),
  path: '/api/ai/document',
  query: documentVoiceQuerySchema,
  summary: 'Stream a document editor AI response',
})

/** One inline completion request from the document editor's copilot. */
export const documentCopilotRequestSchema = z.object({
  prompt: z.string().trim().min(1).max(8_000),
})

/** One comment the AI review leaves on a passage it quotes from the post. */
export const documentReviewCommentSchema = z.object({
  comment: z.string().trim().min(1).max(600),
  content: z.string().trim().min(1).max(400),
})

/** One AI review comment. */
export type DocumentReviewComment = z.infer<typeof documentReviewCommentSchema>

/** The completion text, or `0` when the model has nothing worth suggesting. */
export const documentCopilotResponseSchema = z.object({ text: z.string().min(1) })

/** `POST /api/ai/document/copilot` */
export const documentCopilotContract = defineContract({
  body: documentCopilotRequestSchema,
  method: 'POST',
  name: 'ai.document-copilot',
  output: documentCopilotResponseSchema,
  path: '/api/ai/document/copilot',
  query: documentVoiceQuerySchema,
  summary: 'Suggest an inline completion in the document editor',
})
