import { createHash } from 'node:crypto'
import { z } from 'zod'
import { MarkdownKit } from '@shots/platejs-editor/markdown-kit'
import { createSlateEditor, KEYS, type Value } from '@shots/platejs-editor/platejs'
import { threadAsRules } from '@/lib/content-drafts/export'
import { plateBodySchema } from '@/lib/write/document'
import { creativeSetDocumentSchema, materializeOutput } from '@/lib/creative-sets/document'
import { mapDesignSources } from '@/lib/design/document'
import { createDesignRenderer, isDesignRendererAvailable } from '@/lib/design/renderer'

import { kitRenderRequestSchema, kitRenderOutputSchema } from './kit-render-schema'

/** Prepare native output using the editors' existing serializers and renderer. */
export async function renderKitSnapshot(
  input: z.infer<typeof kitRenderRequestSchema>
): Promise<z.infer<typeof kitRenderOutputSchema>> {
  let total = 0
  for (const pin of input.snapshot.assets) {
    const source = input.assets[pin.id]
    const prefix = `data:${pin.mediaType};base64,`
    if (!source?.startsWith(prefix)) throw new Error('A pinned asset is missing.')
    const bytes = Buffer.from(source.slice(prefix.length), 'base64')
    total += bytes.length
    if (
      total > 100 << 20 ||
      bytes.length !== pin.byteLength ||
      createHash('sha256').update(bytes).digest('hex') !== pin.sha256
    )
      throw new Error('A pinned asset changed.')
  }
  const resolve = (reference: string): string => {
    if (!reference.startsWith('asset:')) return reference
    const source = input.assets[reference.slice(6)]
    if (!source) throw new Error('An image was not pinned.')
    return source
  }
  const raw: unknown = JSON.parse(input.snapshot.document)
  if (input.snapshot.kind === 'DRAFT') {
    // Owned images must also be present in this audience's bundle. Relative
    // paths keep exported documents independent of private signed URLs.
    const remap = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(remap)
      if (value && typeof value === 'object')
        return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, remap(child)]))
      if (typeof value === 'string' && value.startsWith('asset:')) {
        const path = input.assetPaths[value.slice(6)]
        if (!path || !input.assets[value.slice(6)])
          throw new Error('Include each draft image as a screenshot for this audience.')
        return path.split('/')[1]
      }
      return value
    }
    const value = threadAsRules(plateBodySchema.parse(remap(raw)) as Value)
    const editor = createSlateEditor({ plugins: MarkdownKit, value })
    const markdown = editor.getApi({ key: KEYS.markdown }).markdown.serialize({ value })
    const bytes = Buffer.from(markdown)
    if (!bytes.length || bytes.length > 1 << 20)
      throw new Error('The prepared document exceeds the kit limit.')
    return {
      body: bytes.toString('base64'),
      mediaType: 'text/markdown; charset=utf-8',
      rendererVersion: 'shots-kit-v1',
    }
  }
  const set = creativeSetDocumentSchema.parse(raw)
  const output = set.outputs.find((candidate) => candidate.id === input.snapshot.outputId)
  if (!output) throw new Error('The selected creative output is missing.')
  const document = mapDesignSources(materializeOutput(set, output), resolve)
  if (document.texts.some((text) => text.fontFamily.startsWith('google:')))
    throw new Error('Choose a bundled font before freezing the creative output.')
  if (!isDesignRendererAvailable()) throw new Error('The native renderer is unavailable.')
  const renderer = await createDesignRenderer()
  try {
    const result = await renderer.renderSnapshot(document)
    return {
      body: result.bytes.toString('base64'),
      mediaType: 'image/png',
      rendererVersion: 'shots-kit-v1',
    }
  } finally {
    await renderer.close()
  }
}
