/** What `shots code` was asked to do. */
export const USAGE = `Usage: shots code <file> [options]

Creates a Code Studio project from a file (or part of it) and prints its link.

Options:
  --lines <a-b>    Only these lines, such as 10-20 (1-based, inclusive)
  --name <name>    Project name (default: the file name)
  --theme <id>     A theme, such as midnight, sunset or noir
  --aspect <ratio> auto, 16:9, 1.91:1, 1:1, 4:5 or 9:16
  --light          Light mode instead of dark
  --png <path>     Also render the first slide and save it as a PNG
  --scale <1-3>    PNG scale (default 2)
  --open           Open the project in your browser

Environment:
  SHOTS_API_KEY    A workspace API key (asset:write, artifact:read)
  SHOTS_ORIGIN     The Shots origin (default https://shots.playbookmedia.io)`

const ASPECTS = new Set(['auto', '16:9', '1.91:1', '1:1', '4:5', '9:16'])

/**
 * Parse `code <file> [options]` into a request; throws a message for the user.
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const [command, file, ...rest] = argv
  if (command !== 'code' || !file || file.startsWith('--')) throw new Error(USAGE)
  /** @type {{ file: string, lines?: [number, number], name?: string, theme?: string, aspect?: string, dark: boolean, png?: string, scale: 1 | 2 | 3, open: boolean }} */
  const options = { file, dark: true, scale: 2, open: false }
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index]
    const value = () => {
      const next = rest[++index]
      if (next === undefined || next.startsWith('--')) throw new Error(`${flag} needs a value.\n\n${USAGE}`)
      return next
    }
    switch (flag) {
      case '--lines': {
        const match = /^(\d+)(?:-(\d+))?$/.exec(value())
        const start = Number(match?.[1])
        const end = Number(match?.[2] ?? match?.[1])
        if (!match || start < 1 || end < start) throw new Error('--lines takes a range such as 10-20.')
        options.lines = [start, end]
        break
      }
      case '--name':
        options.name = value().slice(0, 200)
        break
      case '--theme':
        options.theme = value()
        break
      case '--aspect': {
        const aspect = value()
        if (!ASPECTS.has(aspect)) throw new Error(`--aspect takes one of ${[...ASPECTS].join(', ')}.`)
        options.aspect = aspect
        break
      }
      case '--light':
        options.dark = false
        break
      case '--png':
        options.png = value()
        break
      case '--scale': {
        const scale = Number(value())
        if (scale !== 1 && scale !== 2 && scale !== 3) throw new Error('--scale takes 1, 2 or 3.')
        options.scale = scale
        break
      }
      case '--open':
        options.open = true
        break
      default:
        throw new Error(`Unknown option ${flag}.\n\n${USAGE}`)
    }
  }
  return options
}

/**
 * The lines of a file a range selects.
 * @param {string} text @param {[number, number] | undefined} lines
 */
export function selectLines(text, lines) {
  if (!lines) return text
  const all = text.replace(/\r\n?/g, '\n').split('\n')
  if (lines[0] > all.length) throw new Error(`The file has ${all.length} lines.`)
  return all.slice(lines[0] - 1, lines[1]).join('\n')
}
