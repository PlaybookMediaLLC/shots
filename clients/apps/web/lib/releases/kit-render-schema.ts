import { z } from 'zod'

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const safePath = z.string().regex(/^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\.(png|jpg|webp)$/)
/** Exact worker-owned native bytes; no mutable database pointers or remote downloads. */
export const kitRenderRequestSchema = z.strictObject({
  organizationId: id,
  artifactId: id,
  snapshot: z.strictObject({
    kind: z.enum(['DRAFT', 'CREATIVE']),
    sourceId: id,
    revision: z.string().min(1),
    document: z
      .string()
      .min(1)
      .max(1 << 20),
    markdown: z.string(),
    outputId: z.string().max(128),
    assets: z
      .array(
        z.strictObject({
          id,
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
          objectKey: z.string(),
          mediaType: z.enum([
            'image/png',
            'image/jpeg',
            'image/webp',
            'font/woff2',
            'font/woff',
            'application/font-woff',
            'application/x-font-ttf',
            'font/ttf',
            'font/otf',
          ]),
          byteLength: z
            .number()
            .int()
            .positive()
            .max(100 << 20),
        })
      )
      .max(100),
  }),
  assets: z.record(id, z.string().max(140 << 20)),
  assetPaths: z.record(id, safePath),
})
/** Serialized bytes return to Go, which reserves storage and independently hashes them. */
export const kitRenderOutputSchema = z.strictObject({
  body: z.string(),
  mediaType: z.enum(['image/png', 'text/markdown; charset=utf-8']),
  rendererVersion: z.literal('shots-kit-v1'),
})
