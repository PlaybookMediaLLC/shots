import { expect, type Locator } from '@playwright/test'
import { contrastRatio } from '@/lib/launch/brand'

/**
 * Pick an option of a Select (the design system's, on Radix): open it, then
 * click the option by its visible name, as a person would. Native
 * `selectOption` does not work on it.
 */
export async function chooseOption(select: Locator, name: string | RegExp): Promise<void> {
  await select.click()
  const option = select.page().getByRole('option', { exact: typeof name === 'string', name })
  await option.click()
  // Closed again: other listboxes on the page are not this select's.
  await expect(option).toBeHidden()
}

/**
 * WCAG contrast of an element's text against the first opaque background
 * behind it, from computed styles: what a reader actually sees.
 */
export async function contrastOf(element: Locator): Promise<number> {
  const [text, background] = await element.evaluate((node) => {
    const hex = (color: string) => {
      const [r, g, b, a = 1] = (color.match(/[\d.]+/g) ?? []).map(Number)
      return {
        a,
        hex: `#${[r, g, b]
          .map((part) =>
            Math.round(part ?? 0)
              .toString(16)
              .padStart(2, '0')
          )
          .join('')}`,
      }
    }
    let surface: Element | null = node
    let fill = hex('rgb(255, 255, 255)')
    while (surface) {
      const color = hex(getComputedStyle(surface).backgroundColor)
      if (color.a === 1) {
        fill = color
        break
      }
      surface = surface.parentElement
    }
    return [hex(getComputedStyle(node).color).hex, fill.hex]
  })
  return contrastRatio(text, background)
}
