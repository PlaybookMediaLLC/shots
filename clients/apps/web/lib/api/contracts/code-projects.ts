import { z } from 'zod'
import { defineContract } from '@/lib/api/contract'
import { workspaceDocs } from '@/lib/api/contracts/workspace-docs'
import { CODE_ASPECTS, CODE_FILE_LIMIT, codeDocumentSchema } from '@/lib/code-studio/document'
import { CODE_LANGUAGE_IDS } from '@/lib/code-studio/languages'

/** Path parameters naming one code project. */
export const codeProjectParamsSchema = z.object({ projectId: z.string().cuid() })

const notFound = 'No code project with that id exists in this workspace.'

/** One file to start a code project with; the language is guessed from the name when omitted. */
export const codeProjectFileInputSchema = z.strictObject({
  code: z.string().max(CODE_FILE_LIMIT),
  lang: z.enum(CODE_LANGUAGE_IDS).optional(),
  name: z.string().trim().max(120).optional(),
})

/** `POST /api/v1/code-projects` body: code to turn into a Code Studio project. */
export const createCodeProjectBodySchema = z.strictObject({
  aspect: z.enum(CODE_ASPECTS).optional(),
  dark: z.boolean().optional(),
  files: z.array(codeProjectFileInputSchema).min(1).max(10),
  name: z.string().trim().min(1).max(200).optional(),
  theme: z.string().trim().max(80).optional(),
  title: z.string().max(60).optional(),
})

/** A code project as the API returns it. */
export const codeProjectSchema = z.object({
  createdAt: z.coerce.date(),
  document: codeDocumentSchema,
  id: z.string(),
  name: z.string(),
  revision: z.number().int(),
  updatedAt: z.coerce.date(),
  /** Where a member opens it in Code Studio. */
  url: z.string().url(),
})

/** `POST /api/v1/code-projects` */
export const createCodeProjectContract = defineContract({
  access: {
    apiKeyScope: 'asset:write',
    feature: 'workspace:paid',
    permission: 'artifact:edit',
    quota: 'api:write:minute',
  },
  body: createCodeProjectBodySchema,
  docs: workspaceDocs({
    description:
      'Creates a Code Studio project from code, as a CLI or editor extension does with a selection. The project opens in Code Studio for styling, exporting and posting; render it with the render operation.',
    operationId: 'createCodeProject',
    outputName: 'CodeProject',
    responses: { '201': 'The new code project.', '400': 'The code or settings are not valid.' },
    tag: 'Assets',
  }),
  method: 'POST',
  name: 'code-projects.create',
  output: codeProjectSchema,
  path: '/api/v1/code-projects',
  status: 201,
  summary: 'Create a code project',
})

/** `GET /api/v1/code-projects/{projectId}` */
export const getCodeProjectContract = defineContract({
  access: { apiKeyScope: 'artifact:read', feature: 'workspace:paid', permission: 'artifact:read' },
  docs: workspaceDocs({
    description: "Reads a Code Studio project's document: its slides, files and style.",
    operationId: 'getCodeProject',
    outputName: 'CodeProject',
    responses: { '200': 'The code project.', '404': notFound },
    tag: 'Assets',
  }),
  method: 'GET',
  name: 'code-projects.get',
  output: codeProjectSchema,
  params: codeProjectParamsSchema,
  path: '/api/v1/code-projects/{projectId}',
  summary: 'Get a code project',
})

/** `POST /api/v1/code-projects/{projectId}/render` body. */
export const renderCodeProjectBodySchema = z.strictObject({
  scale: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(2),
  slide: z.number().int().min(0).max(49).default(0),
})

/** A rendered slide, stored as a workspace export. */
export const renderedCodeSchema = z.object({
  assetId: z.string(),
  height: z.number().int(),
  mediaType: z.literal('image/png'),
  width: z.number().int(),
})

/** `POST /api/v1/code-projects/{projectId}/render` */
export const renderCodeProjectContract = defineContract({
  access: {
    apiKeyScope: 'artifact:read',
    feature: 'workspace:paid',
    permission: 'artifact:read',
    quota: 'api:write:minute',
  },
  body: renderCodeProjectBodySchema,
  docs: workspaceDocs({
    description:
      'Renders one slide as a PNG on the server, exactly as Code Studio exports it, and stores it as a workspace asset. Download it with the asset download URL operation. Renders count against the workspace render limit.',
    operationId: 'renderCodeProject',
    outputName: 'RenderedCode',
    responses: {
      '200': 'The stored image.',
      '404': notFound,
      '429': 'The workspace is rendering too fast.',
    },
    tag: 'Assets',
  }),
  method: 'POST',
  name: 'code-projects.render',
  output: renderedCodeSchema,
  params: codeProjectParamsSchema,
  path: '/api/v1/code-projects/{projectId}/render',
  summary: 'Render a code project slide',
})
