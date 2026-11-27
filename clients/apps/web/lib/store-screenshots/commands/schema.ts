import { z } from 'zod'
import {
  assetSchema,
  backgroundSchema,
  deviceFrameSchema,
  freePlacementSchema,
  idSchema,
  imageFiltersSchema,
  imageFramingSchema,
  layerSchema,
  layoutIdSchema,
  placementSchema,
  richTextSchema,
  slideSchema,
  statusBarSchema,
  textRoleSchema,
  textStyleOverridesSchema,
  textStyleSchema,
  themeSchema,
  transformSchema,
  translationStatusSchema,
  animationSettingsSchema,
  fontSourceSchema,
} from '../document/schema'
import { brandKitPartsSchema, brandKitSchema } from '../brand-kits'
import { templateSchema } from '../templates'

/**
 * Editor commands: every document mutation the editor can make, as data.
 *
 * Commands are validated, serializable, and applied by one pure reducer
 * (`apply.ts`), so undo/redo, autosave, and future collaboration all see
 * the same named operations. UI components dispatch commands; they never
 * edit the document directly.
 */

/** Which container owns a layer: a slide or a panorama group. */
export const layerOwnerSchema = z.object({
  kind: z.enum(['slide', 'panorama']),
  id: idSchema,
})

/** Layer owner. */
export type LayerOwner = z.infer<typeof layerOwnerSchema>

/** Property groups that "Apply to slides" can copy. */
export const styleGroupSchema = z.enum([
  'background',
  'layout',
  'typography',
  'textColors',
  'textPosition',
  'deviceFrame',
  'devicePlacement',
  'screenFraming',
])

/** Style group. */
export type StyleGroup = z.infer<typeof styleGroupSchema>

/** Layer stacking moves. */
export const arrangeSchema = z.enum(['forward', 'backward', 'front', 'back'])

/** Layer stacking move. */
export type ArrangeMove = z.infer<typeof arrangeSchema>


/** Text reset scopes. */
export const textResetScopeSchema = z.enum(['position', 'style', 'all'])

/** Text reset scope. */
export type TextResetScope = z.infer<typeof textResetScopeSchema>

/** Which slides a bulk action applies to: the active one, the selection, or all. */
export const slideScopeSchema = z.enum(['active', 'selected', 'all'])

/** One {@link slideScopeSchema} value. */
export type SlideScope = z.infer<typeof slideScopeSchema>

/** Partial update to a layer. Nested objects merge; `style: null` clears overrides. */
export const layerPatchSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  hidden: z.boolean().optional(),
  locked: z.boolean().optional(),
  opacity: z.number().min(0).max(1).optional(),
  groupId: idSchema.nullable().optional(),
  transform: transformSchema.partial().optional(),
  placement: placementSchema.optional(),
  // Text
  content: richTextSchema.optional(),
  role: textRoleSchema.optional(),
  style: textStyleOverridesSchema.nullable().optional(),
  // Device
  assetId: idSchema.nullable().optional(),
  frame: deviceFrameSchema.partial().optional(),
  image: imageFramingSchema.partial().optional(),
  filters: imageFiltersSchema.partial().optional(),
  statusBar: statusBarSchema.partial().optional(),
  // Annotation, callout, image
  props: z.record(z.string(), z.unknown()).optional(),
})

/** Layer patch. */
export type LayerPatch = z.infer<typeof layerPatchSchema>

const slideIds = z.array(idSchema).min(1).max(30)

/** Every command. */
export const commandSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('slides.add'),
    slides: z.array(slideSchema).min(1).max(30),
    assets: z.array(assetSchema).max(60),
    index: z.number().int().min(0).optional(),
  }),
  z.object({ type: z.literal('slides.duplicate'), slideIds }),
  z.object({ type: z.literal('slides.delete'), slideIds }),
  z.object({ type: z.literal('slides.move'), slideIds, toIndex: z.number().int().min(0) }),
  z.object({ type: z.literal('slides.reorder'), order: z.array(idSchema).min(1).max(30) }),
  z.object({
    type: z.literal('slides.patch'),
    slideIds,
    patch: z.object({
      name: z.string().min(1).max(80).optional(),
      background: backgroundSchema.nullable().optional(),
    }),
  }),
  z.object({ type: z.literal('slides.setLayout'), slideIds, layout: layoutIdSchema.nullable() }),
  z.object({
    type: z.literal('slides.applyStyle'),
    sourceSlideId: idSchema,
    slideIds,
    groups: z.array(styleGroupSchema).min(1),
  }),
  z.object({
    type: z.literal('slides.patchText'),
    slideIds,
    roles: z.array(textRoleSchema).min(1),
    style: textStyleOverridesSchema,
  }),
  z.object({
    type: z.literal('slides.patchDevices'),
    slideIds,
    frame: deviceFrameSchema.partial().optional(),
    transform: transformSchema.partial().optional(),
  }),
  z.object({ type: z.literal('layers.add'), owner: layerOwnerSchema, layers: z.array(layerSchema).min(1), index: z.number().int().min(0).optional() }),
  z.object({ type: z.literal('layers.patch'), owner: layerOwnerSchema, layerIds: z.array(idSchema).min(1), patch: layerPatchSchema }),
  z.object({
    type: z.literal('layers.setTransforms'),
    owner: layerOwnerSchema,
    /** Absolute transform values per layer id, e.g. from a multi-layer drag. */
    transforms: z.record(z.string(), transformSchema.partial()),
    /** Write to this export target's overrides instead of the shared design. */
    targetId: z.string().min(1).max(60).nullable(),
  }),
  z.object({
    type: z.literal('layers.duplicate'),
    owner: layerOwnerSchema,
    layerIds: z.array(idSchema).min(1),
    /** Placement for each copy, keyed by source layer id, so copies land beside the original. */
    placements: z.record(z.string(), freePlacementSchema),
  }),
  z.object({ type: z.literal('layers.delete'), owner: layerOwnerSchema, layerIds: z.array(idSchema).min(1) }),
  z.object({ type: z.literal('layers.arrange'), owner: layerOwnerSchema, layerIds: z.array(idSchema).min(1), move: arrangeSchema }),
  z.object({ type: z.literal('layers.reorder'), owner: layerOwnerSchema, order: z.array(idSchema).min(1) }),
  z.object({ type: z.literal('layers.group'), owner: layerOwnerSchema, layerIds: z.array(idSchema).min(2), groupId: idSchema }),
  z.object({ type: z.literal('layers.ungroup'), owner: layerOwnerSchema, layerIds: z.array(idSchema).min(1) }),
  z.object({ type: z.literal('reset.devices'), owner: layerOwnerSchema, layerIds: z.array(idSchema).min(1) }),
  z.object({ type: z.literal('reset.text'), owner: layerOwnerSchema, layerIds: z.array(idSchema).min(1), scope: textResetScopeSchema }),
  z.object({ type: z.literal('reset.layer'), owner: layerOwnerSchema, layerId: idSchema }),
  z.object({ type: z.literal('reset.slide'), slideId: idSchema }),
  z.object({
    type: z.literal('targetOverride.set'),
    slideId: idSchema,
    targetId: z.string().min(1).max(60),
    layerId: idSchema,
    transform: transformSchema.partial().nullable(),
  }),
  z.object({ type: z.literal('theme.patch'), patch: themeSchema.omit({ textStyles: true }).partial() }),
  z.object({
    type: z.literal('theme.patchText'),
    role: textRoleSchema,
    style: textStyleSchema.partial(),
    /** Also remove the same properties from per-layer overrides on every slide. */
    clearOverrides: z.boolean(),
  }),
  z.object({ type: z.literal('assets.add'), assets: z.array(assetSchema).min(1).max(60) }),
  z.object({ type: z.literal('assets.patch'), assetId: idSchema, patch: assetSchema.omit({ id: true }).partial() }),
  z.object({
    type: z.literal('text.translate'),
    entries: z
      .array(
        z.object({
          slideId: idSchema,
          layerId: idSchema,
          locale: z.string().min(2).max(16),
          content: richTextSchema,
          status: translationStatusSchema,
        })
      )
      .min(1)
      .max(600),
  }),
  z.object({
    type: z.literal('text.setTranslationStatus'),
    slideId: idSchema,
    layerId: idSchema,
    locale: z.string().min(2).max(16),
    status: translationStatusSchema.nullable(),
  }),
  z.object({
    type: z.literal('text.setLocaleOverride'),
    slideId: idSchema,
    layerId: idSchema,
    locale: z.string().min(2).max(16),
    style: textStyleOverridesSchema.optional(),
    offsetX: z.number().optional(),
    offsetY: z.number().optional(),
  }),
  z.object({ type: z.literal('locales.set'), locales: z.array(z.string().min(2).max(16)).max(40) }),
  z.object({ type: z.literal('panorama.create'), slideIds: z.array(idSchema).min(2).max(3) }),
  z.object({ type: z.literal('panorama.patch'), panoramaId: idSchema, background: backgroundSchema }),
  z.object({ type: z.literal('panorama.detach'), panoramaId: idSchema }),
  z.object({ type: z.literal('panorama.remove'), panoramaId: idSchema }),
  z.object({
    type: z.literal('project.patch'),
    patch: z.object({
      name: z.string().min(1).max(120).optional(),
      productBrief: z.string().max(4000).optional(),
      animation: animationSettingsSchema.partial().optional(),
      templateId: z.string().min(1).max(80).optional(),
      brandKitId: idSchema.nullable().optional(),
      fonts: z.array(fontSourceSchema).max(20).optional(),
    }),
  }),
  z.object({
    type: z.literal('copy.remember'),
    suggestions: z
      .array(
        z.object({
          id: idSchema,
          slideId: idSchema,
          locale: z.string().max(16),
          headline: z.string().max(200),
          subheadline: z.string().max(300),
          tone: z.string().max(40),
        })
      )
      .min(1)
      .max(40),
  }),
  z.object({
    type: z.literal('copy.apply'),
    suggestionId: idSchema,
  }),
  z.object({ type: z.literal('template.apply'), template: templateSchema }),
  z.object({
    type: z.literal('brandKit.apply'),
    kit: brandKitSchema,
    /** Null applies to the whole project. */
    slideIds: z.array(idSchema).min(1).nullable(),
    parts: brandKitPartsSchema,
  }),
])

/** A command. */
export type Command = z.infer<typeof commandSchema>

/** Command type names. */
export type CommandType = Command['type']

/** The Store commands the model may send: edits to what exists, never deletes. */
const STORE_MODEL_COMMANDS: ReadonlySet<string> = new Set([
  'slides.duplicate',
  'slides.reorder',
  'slides.patch',
  'slides.setLayout',
  'slides.applyStyle',
  'slides.patchText',
  'slides.patchDevices',
  'layers.patch',
  'layers.arrange',
  'theme.patch',
  'theme.patchText',
  'copy.apply',
])

/** Typed from the editor's own command schema, so the model sees only non-destructive shapes. */
export const storeModelCommandSchema = z.discriminatedUnion(
  'type',
  commandSchema.options.filter((option) =>
    STORE_MODEL_COMMANDS.has(option.shape.type.value)
  ) as unknown as typeof commandSchema.options
)

/** Human labels for undo history. */
export const COMMAND_LABELS: Record<CommandType, string> = {
  'slides.add': 'Add slides',
  'slides.duplicate': 'Duplicate slides',
  'slides.delete': 'Delete slides',
  'slides.move': 'Move slides',
  'slides.reorder': 'Reorder slides',
  'slides.patch': 'Edit slides',
  'slides.setLayout': 'Change layout',
  'slides.applyStyle': 'Apply style to slides',
  'slides.patchText': 'Edit text style on slides',
  'slides.patchDevices': 'Edit devices on slides',
  'layers.add': 'Add layer',
  'layers.patch': 'Edit layer',
  'layers.setTransforms': 'Move layers',
  'layers.duplicate': 'Duplicate layers',
  'layers.delete': 'Delete layers',
  'layers.arrange': 'Arrange layers',
  'layers.reorder': 'Reorder layers',
  'layers.group': 'Group layers',
  'layers.ungroup': 'Ungroup layers',
  'reset.devices': 'Reset device position',
  'reset.text': 'Reset text',
  'reset.layer': 'Reset layer',
  'reset.slide': 'Reset slide',
  'targetOverride.set': 'Adjust for export size',
  'theme.patch': 'Edit theme',
  'theme.patchText': 'Edit typography',
  'assets.add': 'Add images',
  'assets.patch': 'Update image',
  'text.translate': 'Update translations',
  'text.setTranslationStatus': 'Review translation',
  'text.setLocaleOverride': 'Adjust localized text',
  'locales.set': 'Change languages',
  'panorama.create': 'Create panorama',
  'panorama.patch': 'Edit panorama',
  'panorama.detach': 'Detach panorama',
  'panorama.remove': 'Remove panorama',
  'project.patch': 'Edit project',
  'copy.remember': 'Save copy suggestions',
  'copy.apply': 'Apply copy suggestion',
  'template.apply': 'Apply template',
  'brandKit.apply': 'Apply brand kit',
}
