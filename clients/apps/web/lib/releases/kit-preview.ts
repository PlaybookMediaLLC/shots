import sharp from 'sharp'
import { z } from 'zod'
import { kitArtifactPreviewSchema, kitPreviewSchema } from 'screenshot-studio-backend-sdk'

/** Keep draft previews visibly distinct from approved, hash-pinned exports. */
export async function watermarkKitPreview(
  input: z.infer<typeof kitArtifactPreviewSchema>
): Promise<z.infer<typeof kitPreviewSchema>> {
  const watermark = 'PREVIEW — NOT APPROVED FOR DISTRIBUTION' as const
  const bytes = Buffer.from(input.body, 'base64')
  if (input.mediaType.startsWith('text/'))
    return { kind: 'text', content: `${watermark}\n\n${bytes.toString('utf8')}`, watermark }
  const image = sharp(bytes, { limitInputPixels: 40_000_000 })
  const metadata = await image.metadata()
  if (!metadata.width || !metadata.height) throw new Error('The preview image is unavailable.')
  const width = Math.min(metadata.width, 1600)
  const height = Math.max(1, Math.round((metadata.height * width) / metadata.width))
  const fontSize = Math.max(8, Math.min(24, Math.floor(width / 29)))
  const band = Math.min(height, fontSize * 3)
  const overlay = Buffer.from(
    `<svg width="${width}" height="${height}"><rect y="${Math.max(0, (height - band) / 2)}" width="${width}" height="${band}" fill="black" fill-opacity="0.75"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-family="sans-serif" font-size="${fontSize}" fill="white">${watermark}</text></svg>`
  )
  const output = await image
    .resize({ width })
    .composite([{ input: overlay }])
    .png()
    .toBuffer()
  return { kind: 'image', content: `data:image/png;base64,${output.toString('base64')}`, watermark }
}
