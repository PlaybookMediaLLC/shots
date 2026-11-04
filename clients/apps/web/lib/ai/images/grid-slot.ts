import 'server-only'

import sharp from 'sharp'
import { z } from 'zod'
import { GRID_HEADLINE_LIMIT, GRID_TOPIC_LIMIT } from '@/lib/api/contracts/content-batches'
import { isScriptedModelEnabled } from '@/lib/ai/models/scripted'
import { callImageModel, scriptedImage } from './background'

/** What one grid video slot shows. */
export const gridSlotRequestSchema = z.object({
  headline: z.string().trim().max(GRID_HEADLINE_LIMIT).optional(),
  topic: z.string().trim().min(2, 'Name this image first.').max(GRID_TOPIC_LIMIT),
})

/** A grid slot request. */
export type GridSlotRequest = z.infer<typeof gridSlotRequestSchema>

const SIZE = { height: 768, width: 1024 }

function gridSlotPrompt({ headline, topic }: GridSlotRequest) {
  return [
    'Create one photo-realistic image for a cell of a four-image social video.',
    `It shows: ${topic}.`,
    headline ? `The video is about: ${headline}.` : '',
    'Natural light and a clear single subject that stays readable at a small size.',
    'No text, letters, logos, watermarks, or recognizable real people.',
  ]
    .filter(Boolean)
    .join('\n')
}

/** Draw a slot's image and return it as a WebP in the cell's shape. */
export async function generateGridSlotImage(input: GridSlotRequest) {
  const request = gridSlotRequestSchema.parse(input)
  const source = isScriptedModelEnabled()
    ? scriptedImage({ palette: [] }, SIZE)
    : await callImageModel(gridSlotPrompt(request), '4:3')
  const body = await sharp(source)
    .resize(SIZE.width, SIZE.height, { fit: 'cover', position: 'attention' })
    .webp({ quality: 90 })
    .toBuffer()
  return { body, ...SIZE }
}
