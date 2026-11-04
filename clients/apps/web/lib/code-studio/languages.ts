/**
 * Languages Code Studio highlights (RFC 053). `id` is the Shiki grammar;
 * `hljs` is the highlight.js name auto-detection guesses with.
 */
export const CODE_LANGUAGES = [
  { id: 'typescript', label: 'TypeScript', extensions: ['ts', 'mts', 'cts'], hljs: 'typescript' },
  { id: 'tsx', label: 'TSX', extensions: ['tsx'], hljs: null },
  { id: 'javascript', label: 'JavaScript', extensions: ['js', 'mjs', 'cjs'], hljs: 'javascript' },
  { id: 'jsx', label: 'JSX', extensions: ['jsx'], hljs: null },
  { id: 'python', label: 'Python', extensions: ['py'], hljs: 'python' },
  { id: 'go', label: 'Go', extensions: ['go'], hljs: 'go' },
  { id: 'rust', label: 'Rust', extensions: ['rs'], hljs: 'rust' },
  { id: 'java', label: 'Java', extensions: ['java'], hljs: 'java' },
  { id: 'kotlin', label: 'Kotlin', extensions: ['kt', 'kts'], hljs: 'kotlin' },
  { id: 'swift', label: 'Swift', extensions: ['swift'], hljs: 'swift' },
  { id: 'c', label: 'C', extensions: ['c', 'h'], hljs: 'c' },
  { id: 'cpp', label: 'C++', extensions: ['cpp', 'cc', 'hpp'], hljs: 'cpp' },
  { id: 'csharp', label: 'C#', extensions: ['cs'], hljs: 'csharp' },
  { id: 'php', label: 'PHP', extensions: ['php'], hljs: 'php' },
  { id: 'ruby', label: 'Ruby', extensions: ['rb'], hljs: 'ruby' },
  { id: 'dart', label: 'Dart', extensions: ['dart'], hljs: 'dart' },
  { id: 'elixir', label: 'Elixir', extensions: ['ex', 'exs'], hljs: 'elixir' },
  { id: 'scala', label: 'Scala', extensions: ['scala'], hljs: 'scala' },
  { id: 'lua', label: 'Lua', extensions: ['lua'], hljs: 'lua' },
  { id: 'r', label: 'R', extensions: ['r'], hljs: 'r' },
  { id: 'zig', label: 'Zig', extensions: ['zig'], hljs: null },
  { id: 'sql', label: 'SQL', extensions: ['sql'], hljs: 'sql' },
  { id: 'graphql', label: 'GraphQL', extensions: ['graphql', 'gql'], hljs: null },
  { id: 'prisma', label: 'Prisma', extensions: ['prisma'], hljs: null },
  { id: 'json', label: 'JSON', extensions: ['json'], hljs: 'json' },
  { id: 'yaml', label: 'YAML', extensions: ['yml', 'yaml'], hljs: 'yaml' },
  { id: 'toml', label: 'TOML', extensions: ['toml'], hljs: 'ini' },
  { id: 'hcl', label: 'HCL', extensions: ['tf', 'hcl'], hljs: null },
  { id: 'html', label: 'HTML', extensions: ['html', 'htm'], hljs: 'xml' },
  { id: 'xml', label: 'XML', extensions: ['xml', 'svg'], hljs: null },
  { id: 'css', label: 'CSS', extensions: ['css'], hljs: 'css' },
  { id: 'scss', label: 'SCSS', extensions: ['scss'], hljs: 'scss' },
  { id: 'vue', label: 'Vue', extensions: ['vue'], hljs: null },
  { id: 'svelte', label: 'Svelte', extensions: ['svelte'], hljs: null },
  { id: 'markdown', label: 'Markdown', extensions: ['md', 'mdx'], hljs: 'markdown' },
  { id: 'bash', label: 'Shell', extensions: ['sh', 'bash', 'zsh'], hljs: 'bash' },
  { id: 'shellsession', label: 'Terminal', extensions: [], hljs: 'shell' },
  { id: 'dockerfile', label: 'Dockerfile', extensions: ['dockerfile'], hljs: 'dockerfile' },
  { id: 'diff', label: 'Diff', extensions: ['diff', 'patch'], hljs: 'diff' },
  { id: 'text', label: 'Plain text', extensions: ['txt'], hljs: null },
] as const

/** A language Code Studio highlights. */
export type CodeLanguageId = (typeof CODE_LANGUAGES)[number]['id']

/** Every language id, for schemas. */
export const CODE_LANGUAGE_IDS = CODE_LANGUAGES.map((language) => language.id) as [
  CodeLanguageId,
  ...CodeLanguageId[],
]

/** The display name of a language. */
export function languageLabel(id: string): string {
  return CODE_LANGUAGES.find((language) => language.id === id)?.label ?? 'Plain text'
}

/** The language a file name implies, or null when its extension is unknown. */
export function languageForFileName(name: string): CodeLanguageId | null {
  const base = name.trim().toLowerCase().split('/').pop() ?? ''
  if (base === 'dockerfile') return 'dockerfile'
  const extension = base.includes('.') ? base.split('.').pop() : undefined
  if (!extension) return null
  const found = CODE_LANGUAGES.find((language) =>
    (language.extensions as readonly string[]).includes(extension)
  )
  return found?.id ?? null
}

/** The old /code editor's language ids, mapped onto Shiki's. */
export function languageFromLegacy(id: string | undefined): CodeLanguageId {
  if (id === 'auto' || !id) return 'typescript'
  const found = CODE_LANGUAGES.find((language) => language.id === id)
  return found?.id ?? 'text'
}

/**
 * Guess a snippet's language from its text with highlight.js, limited to the
 * languages Code Studio highlights. Loaded only when a guess is needed.
 */
export async function detectLanguage(code: string): Promise<CodeLanguageId | null> {
  if (code.trim().length < 12) return null
  const [{ default: hljs }, ...modules] = await Promise.all([
    import('highlight.js/lib/core'),
    import('highlight.js/lib/languages/typescript'),
    import('highlight.js/lib/languages/javascript'),
    import('highlight.js/lib/languages/python'),
    import('highlight.js/lib/languages/go'),
    import('highlight.js/lib/languages/rust'),
    import('highlight.js/lib/languages/java'),
    import('highlight.js/lib/languages/kotlin'),
    import('highlight.js/lib/languages/swift'),
    import('highlight.js/lib/languages/cpp'),
    import('highlight.js/lib/languages/csharp'),
    import('highlight.js/lib/languages/php'),
    import('highlight.js/lib/languages/ruby'),
    import('highlight.js/lib/languages/sql'),
    import('highlight.js/lib/languages/json'),
    import('highlight.js/lib/languages/yaml'),
    import('highlight.js/lib/languages/xml'),
    import('highlight.js/lib/languages/css'),
    import('highlight.js/lib/languages/markdown'),
    import('highlight.js/lib/languages/bash'),
    import('highlight.js/lib/languages/dockerfile'),
    import('highlight.js/lib/languages/diff'),
  ])
  const names = [
    'typescript',
    'javascript',
    'python',
    'go',
    'rust',
    'java',
    'kotlin',
    'swift',
    'cpp',
    'csharp',
    'php',
    'ruby',
    'sql',
    'json',
    'yaml',
    'xml',
    'css',
    'markdown',
    'bash',
    'dockerfile',
    'diff',
  ]
  names.forEach((name, index) => {
    if (!hljs.getLanguage(name)) hljs.registerLanguage(name, modules[index]!.default)
  })
  const guess = hljs.highlightAuto(code, names)
  if (!guess.language || guess.relevance < 5) return null
  const found = CODE_LANGUAGES.find((language) => language.hljs === guess.language)
  return found?.id ?? null
}
