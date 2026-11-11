import { z } from 'zod'
import { founderHubTemplateContentSchema } from 'screenshot-studio-backend-sdk'
import type { UserTemplate } from './queries'
import { normalizeTemplateIcon } from './template-icon'

export { ResourceShareButton } from '../resource-sharing/share-dialog'
export { SharedResourceLibrarySection } from '../resource-sharing/library'

const payloadSchema = z.object({ version: z.literal(1), template: founderHubTemplateContentSchema })
export function sharedTemplatePayload(template: UserTemplate): Record<string, unknown> {
  const { title, description, category, icon, targets, sections } = template
  return payloadSchema.parse({
    version: 1,
    template: { title, description, category, icon, targets, sections },
  })
}
export function parseSharedTemplatePayload(value: Record<string, unknown>) {
  const legacy = z
    .object({ version: z.literal(1), template: z.record(z.string(), z.unknown()) })
    .parse(value)
  return founderHubTemplateContentSchema.parse({
    category: '',
    targets: [],
    ...legacy.template,
    icon: normalizeTemplateIcon(legacy.template.icon),
  })
}
