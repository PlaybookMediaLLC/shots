import { z } from 'zod'
import { activeFile, type CodeDocument, codeSlideSchema, lineMarksSchema } from './document'
import { duplicateSlide, moveSlide, setLayout, updateFile, updateSlide } from './edit'

/** Edits to a code project as data, so the assistant uses the same pure edits as the controls. */

/** The longest file the assistant reads whole, and so may replace. */
export const CODE_EDIT_MAX = 20_000

const slide = z.number().int().min(0).max(49).describe('Slide number, counted from 0.')

export const codeCommandSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('code'),
    slide,
    pane: z.number().int().min(0).max(1).default(0),
    code: z.string().max(CODE_EDIT_MAX).describe('The whole new text of the pane’s open file.'),
    marks: lineMarksSchema.optional().describe('Line ranges to highlight, focus, or blur.'),
  }),
  z.object({ type: z.literal('duplicate-slide'), slide }),
  z.object({ type: z.literal('move-slide'), slide, by: z.union([z.literal(-1), z.literal(1)]) }),
  z.object({
    type: z.literal('update-slide'),
    slide,
    // No defaults: a field left out must stay as it is.
    patch: z.object({
      caption: codeSlideSchema.shape.caption.unwrap().optional(),
      duration: codeSlideSchema.shape.duration.unwrap().optional(),
      transition: codeSlideSchema.shape.transition.unwrap().optional(),
      transitionDuration: codeSlideSchema.shape.transitionDuration.unwrap().optional(),
    }),
  }),
  z.object({ type: z.literal('layout'), slide, layout: codeSlideSchema.shape.layout }),
])

/** One of {@link codeCommandSchema}. */
export type CodeCommand = z.infer<typeof codeCommandSchema>

/** The document after a command. A command that names nothing throws. */
export function applyCodeCommand(document: CodeDocument, command: CodeCommand): CodeDocument {
  if (!document.slides[command.slide]) throw new Error(`There is no slide ${command.slide}.`)
  switch (command.type) {
    case 'code': {
      const pane = document.slides[command.slide]!.panes[command.pane]
      if (!pane) throw new Error(`Slide ${command.slide} has no pane ${command.pane}.`)
      if (activeFile(pane).code.length > CODE_EDIT_MAX)
        throw new Error('This file is too long to replace as a whole.')
      return updateFile(
        document,
        { slide: command.slide, pane: pane.id, file: activeFile(pane).id },
        { code: command.code, ...(command.marks ? { marks: command.marks } : {}) }
      )
    }
    case 'duplicate-slide':
      return duplicateSlide(document, command.slide)
    case 'move-slide':
      return moveSlide(document, command.slide, command.by)
    case 'update-slide':
      // A key left out must stay as it is; defaults would reset it.
      return updateSlide(document, command.slide, command.patch)
    case 'layout':
      return setLayout(document, command.slide, command.layout)
  }
}
