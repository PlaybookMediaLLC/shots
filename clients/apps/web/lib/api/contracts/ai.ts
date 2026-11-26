import { z } from 'zod'
import { defineContract } from '@/lib/api/contract'
import { onlyInlineFiles } from '@/lib/assistant/attachments'
import { INTERNAL_HREF_MAX, pageContextSchema } from '@/lib/assistant/page-context'

/** Roles the browser may send. It may not inject system or operator messages. */
export const editorMessageRoleSchema = z.enum(['user', 'assistant', 'tool'])

/** Roles the model's response messages carry. */
export const editorResponseRoleSchema = z.enum(['assistant', 'tool'])

/** Most messages one workspace assistant request may carry. */
export const MAX_ASSISTANT_MESSAGES = 80

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
    .refine(onlyInlineFiles, 'Attach images inline: JPEG, PNG, or WebP.'),
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
