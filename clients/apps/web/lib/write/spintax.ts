/**
 * Caption variations for a batch: `{Hello|Hi} there` gives each post one
 * alternative of each group, picked at random, so posts may repeat a variation.
 *
 * The grammar is small on purpose. A group is braces holding at least one `|`;
 * braces without a `|` stay literal text, so `{name}` survives. A backslash
 * makes the next `{`, `}`, `|` or `\` literal. Groups do not nest.
 */

/** A source that cannot be expanded, with what to fix. */
export class SpintaxError extends Error {}

type Part = string | string[]

function parse(source: string): Part[] {
  const parts: Part[] = []
  let text = ''
  let i = 0
  const escaped = (at: number) => source[at] === '\\' && '{}|\\'.includes(source[at + 1] ?? ' ')
  while (i < source.length) {
    if (escaped(i)) {
      text += source[i + 1]
      i += 2
    } else if (source[i] === '{') {
      const group = readGroup(source, i, escaped)
      if (group) {
        if (text) parts.push(text)
        text = ''
        parts.push(group.alternatives)
        i = group.end
      } else {
        text += source[i++]
      }
    } else {
      text += source[i++]
    }
  }
  if (text) parts.push(text)
  return parts
}

/** The group opening at `start`, or null when these braces are literal text. */
function readGroup(source: string, start: number, escaped: (at: number) => boolean) {
  const alternatives = ['']
  for (let i = start + 1; i < source.length; i++) {
    if (escaped(i)) {
      alternatives[alternatives.length - 1] += source[++i]
    } else if (source[i] === '|') {
      alternatives.push('')
    } else if (source[i] === '{') {
      if (alternatives.length > 1)
        throw new SpintaxError(
          'Caption variations cannot be nested. Flatten the inner { | } group.'
        )
      return null
    } else if (source[i] === '}') {
      return alternatives.length > 1 ? { alternatives, end: i + 1 } : null
    } else {
      alternatives[alternatives.length - 1] += source[i]
    }
  }
  return null
}

/**
 * What a source can produce: how many variations, the longest by `measure`
 * (for a channel's own count), and one sample. Throws {@link SpintaxError}.
 */
export function analyzeSpintax(
  source: string,
  measure: (text: string) => number = (t) => t.length
) {
  const parts = parse(source)
  const pick = (choose: (group: string[]) => string) =>
    parts.map((part) => (typeof part === 'string' ? part : choose(part))).join('')
  return {
    longest: pick((group) =>
      group.reduce((best, option) => (measure(option) > measure(best) ? option : best))
    ),
    sample: pick((group) => group[0]!),
    variations: parts.reduce(
      (total, part) => total * (typeof part === 'string' ? 1 : part.length),
      1
    ),
  }
}

/** One expansion of a source. `random` returns a number in [0, 1). */
export function expandSpintax(source: string, random: () => number = Math.random): string {
  return parse(source)
    .map((part) => (typeof part === 'string' ? part : part[Math.floor(random() * part.length)]!))
    .join('')
}
