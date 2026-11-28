/** Usage summary for the Shots CLI. */
export const USAGE = `Usage: shots <command> [options]

Commands:
  setup --key <key> [--origin <url>]   Verify and save a workspace API key (0600)
  whoami [--json]                      Show the active workspace and granted scopes
  accounts list [--json]               List shared social sets and connected accounts
  posts list [--json]                  List scheduled posts
  posts create [options]               Write and schedule or publish a post (post:publish)
  drafts list [--json]                 List content drafts
  releases list [--json]               List workspace releases
  code <file> [options]                Turn code into a Shots Code Studio project

Code options:
  --lines <a-b>    Only these lines, such as 10-20 (1-based, inclusive)
  --name <name>    Project name (default: the file name)
  --theme <id>     A theme, such as midnight, sunset or noir
  --aspect <ratio> auto, 16:9, 1.91:1, 1:1, 4:5 or 9:16
  --light          Light mode instead of dark
  --png <path>     Also render the first slide and save it as a PNG
  --scale <1-3>    PNG scale (default 2)
  --open           Open the project in your browser

Post create options:
  --account <id>           Target channel connection ID (repeatable)
  --text <copy>            Post text (repeatable for thread parts)
  --now                    Publish immediately
  --at <ISO-8601>          Schedule for a specific UTC timestamp
  --queue                  Use the social set's next free queue slot
  --idempotency-key <key>  Stable 16–128 char key for safe retries
  --json                   Output raw JSON

Environment:
  SHOTS_API_KEY    Overrides the saved key (recommended for CI)
  SHOTS_ORIGIN     The Shots origin (default https://shots.playbookmedia.io)`

const ASPECTS = new Set(['auto', '16:9', '1.91:1', '1:1', '4:5', '9:16'])

/**
 * Parse `code <file> [options]` into a request; throws a message for the user.
 * Kept exported for backward compatibility.
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
 * Parse only `--json` (rejecting unknown flags) for read-only list/whoami commands.
 * @param {string[]} args
 */
function parseJsonOnlyFlags(args) {
  let json = false
  for (const flag of args) {
    if (flag === '--json') json = true
    else if (flag === '--help' || flag === '-h') return { help: true, json: false }
    else throw new Error(`Unknown option ${flag}.\n\n${USAGE}`)
  }
  return { help: false, json }
}

/**
 * Parse any Shots CLI command.
 * @param {string[]} argv
 */
export function parseCommand(argv) {
  const [command, sub, ...rest] = argv
  if (!command || command === '--help' || command === '-h') {
    return { command: 'help', options: {} }
  }

  if (command === 'code') {
    if (argv.slice(1).includes('--help') || argv.slice(1).includes('-h')) {
      return { command: 'help', options: {} }
    }
    return { command: 'code', options: parseArgs(argv) }
  }

  if (command === 'setup') {
    const args = argv.slice(1)
    /** @type {{ key: string, origin?: string, json: boolean }} */
    const options = { key: '', json: false }
    for (let i = 0; i < args.length; i++) {
      const flag = args[i]
      if (flag === '--help' || flag === '-h') return { command: 'help', options: {} }
      if (flag === '--json') {
        options.json = true
        continue
      }
      if (flag === '--key' || flag === '--origin') {
        const next = args[++i]
        if (next === undefined || next.startsWith('--')) throw new Error(`${flag} needs a value.\n\n${USAGE}`)
        const trimmed = next.trim()
        if (!trimmed) throw new Error(`${flag} needs a non-empty value.\n\n${USAGE}`)
        if (flag === '--key') options.key = trimmed
        else options.origin = trimmed
        continue
      }
      throw new Error(`Unknown option ${flag}.\n\n${USAGE}`)
    }
    if (!options.key) throw new Error(`setup requires --key <YOUR_API_KEY>.\n\n${USAGE}`)
    return { command: 'setup', options }
  }

  if (command === 'whoami') {
    const parsed = parseJsonOnlyFlags(argv.slice(1))
    if (parsed.help) return { command: 'help', options: {} }
    return { command: 'whoami', options: { json: parsed.json } }
  }

  if (
    (command === 'accounts' || command === 'drafts' || command === 'releases' || command === 'posts') &&
    sub === 'list'
  ) {
    const parsed = parseJsonOnlyFlags(rest)
    if (parsed.help) return { command: 'help', options: {} }
    return { command: `${command}:list`, options: { json: parsed.json } }
  }

  if (command === 'posts' && sub === 'create') {
    /** @type {{ accounts: string[], texts: string[], publishNow: boolean, scheduledFor?: string, queue: boolean, idempotencyKey?: string, json: boolean }} */
    const options = { accounts: [], texts: [], publishNow: false, queue: false, json: false }
    for (let i = 0; i < rest.length; i++) {
      const flag = rest[i]
      if (flag === '--help' || flag === '-h') return { command: 'help', options: {} }
      if (flag === '--now') {
        options.publishNow = true
        continue
      }
      if (flag === '--queue') {
        options.queue = true
        continue
      }
      if (flag === '--json') {
        options.json = true
        continue
      }
      if (flag === '--text') {
        const next = rest[++i]
        if (next === undefined) throw new Error(`${flag} needs a value.\n\n${USAGE}`)
        options.texts.push(next)
        continue
      }
      if (flag === '--account' || flag === '--at' || flag === '--idempotency-key') {
        const next = rest[++i]
        if (next === undefined || next.startsWith('--')) throw new Error(`${flag} needs a value.\n\n${USAGE}`)
        const trimmed = next.trim()
        if (!trimmed) throw new Error(`${flag} needs a non-empty value.\n\n${USAGE}`)
        if (flag === '--account') options.accounts.push(trimmed)
        else if (flag === '--at') options.scheduledFor = trimmed
        else options.idempotencyKey = trimmed
        continue
      }
      throw new Error(`Unknown option ${flag}.\n\n${USAGE}`)
    }
    if (options.accounts.length === 0) throw new Error('posts create requires at least one --account <id>.')
    if (options.texts.length === 0) throw new Error('posts create requires at least one --text <copy>.')
    const modes = Number(options.publishNow) + Number(Boolean(options.scheduledFor)) + Number(options.queue)
    if (modes !== 1) throw new Error('Choose exactly one of --now, --at <ISO-8601>, or --queue.')
    return { command: 'posts:create', options }
  }

  throw new Error(USAGE)
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
