import { expect, type Locator } from '@playwright/test'
import { contrastRatio } from '@/lib/launch/brand'

/**
 * Pick an option of a Select or Combobox (the design system's): open it, then
 * click the option by its visible name, as a person would. Native
 * `selectOption` does not work on them.
 */
export async function chooseOption(
  select: Locator,
  name: string | RegExp,
  /** Typed into a Combobox's search field first, as a person narrows a long list. */
  search?: string
): Promise<void> {
  await select.click()
  if (search) await select.page().keyboard.type(search)
  const option = select.page().getByRole('option', { exact: typeof name === 'string', name })
  await option.click()
  // Closed again: other listboxes on the page are not this select's.
  await expect(option).toBeHidden()
}

/**
 * The colors an element's text and border show against the first opaque
 * background behind it, as hex. Colors go through a canvas, so oklab and
 * color-mix values read the same as rgb ones.
 */
async function paintedColors(
  element: Locator
): Promise<{ background: string; border: string; text: string }> {
  return element.evaluate((node) => {
    const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!
    const read = (color: string) => {
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = color
      context.fillRect(0, 0, 1, 1)
      const [r = 0, g = 0, b = 0, a = 0] = context.getImageData(0, 0, 1, 1).data
      return { a, hex: `#${[r, g, b].map((part) => part.toString(16).padStart(2, '0')).join('')}` }
    }
    let surface: Element | null = node.parentElement
    let background = '#ffffff'
    while (surface) {
      const color = read(getComputedStyle(surface).backgroundColor)
      if (color.a === 255) {
        background = color.hex
        break
      }
      surface = surface.parentElement
    }
    const style = getComputedStyle(node)
    return { background, border: read(style.borderTopColor).hex, text: read(style.color).hex }
  })
}

/** WCAG contrast of an element's text against what is behind it: what a reader sees. */
export async function contrastOf(element: Locator): Promise<number> {
  const { background, text } = await paintedColors(element)
  return contrastRatio(text, background)
}

/** WCAG contrast of an element's border against what is behind it, as for a checkbox's edge. */
export async function borderContrastOf(element: Locator): Promise<number> {
  const { background, border } = await paintedColors(element)
  return contrastRatio(border, background)
}

/** Open the Disclosure section a control sits in, as a person clicks its title row. */
export async function openDisclosureFor(control: Locator): Promise<void> {
  await control
    .locator('xpath=ancestor::*[@data-slot="disclosure"][1]/*[@data-slot="disclosure-trigger"]')
    .click()
}
