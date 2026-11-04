'use strict'

/** VS Code language ids that differ from Code Studio's. */
const LANGUAGES = {
  typescriptreact: 'tsx',
  javascriptreact: 'jsx',
  shellscript: 'bash',
  jsonc: 'json',
  plaintext: 'text',
  terraform: 'hcl',
}

/** Code Studio languages; anything else is guessed from the file name. */
const KNOWN = new Set([
  'typescript', 'tsx', 'javascript', 'jsx', 'python', 'go', 'rust', 'java', 'kotlin', 'swift', 'c', 'cpp',
  'csharp', 'php', 'ruby', 'dart', 'elixir', 'scala', 'lua', 'r', 'zig', 'sql', 'graphql', 'prisma', 'json',
  'yaml', 'toml', 'hcl', 'html', 'xml', 'css', 'scss', 'vue', 'svelte', 'markdown', 'bash', 'dockerfile',
  'diff', 'text',
])

const CODE_LIMIT = 100_000

/**
 * The code project a selection becomes: the selected lines (or the whole
 * file), named after the file and its line range.
 * @param {{ fileName: string, languageId: string, text: string, startLine: number, endLine: number, theme?: string }} selection
 */
function codeProjectRequest(selection) {
  const code = selection.text.replace(/\r\n?/g, '\n').replace(/\n$/, '')
  if (!code.trim()) throw new Error('Select some code first.')
  if (code.length > CODE_LIMIT) throw new Error('Select under 100,000 characters.')
  const base = selection.fileName.split(/[\\/]/).pop() || 'snippet'
  const mapped = LANGUAGES[selection.languageId] ?? selection.languageId
  const range = selection.startLine === selection.endLine ? `${selection.startLine}` : `${selection.startLine}-${selection.endLine}`
  return {
    name: `${base}:${range}`.slice(0, 200),
    files: [{ name: base.slice(0, 120), code, ...(KNOWN.has(mapped) ? { lang: mapped } : {}) }],
    ...(selection.theme ? { theme: selection.theme } : {}),
  }
}

/**
 * The origin code is sent to: HTTPS, or a local development server.
 * @param {string} value
 */
function shotsOrigin(value) {
  const url = new URL(value)
  const local = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || (url.protocol !== 'https:' && !local))
    throw new Error('Set shots.origin to an HTTPS Shots origin without a path.')
  return url.origin
}

/**
 * Create the project with the API key; the key never follows a redirect.
 * @param {string} origin @param {string} key @param {ReturnType<typeof codeProjectRequest>} body @param {typeof fetch} [transport]
 * @returns {Promise<{ id: string, url: string }>}
 */
async function createCodeProject(origin, key, body, transport = fetch) {
  const response = await transport(`${shotsOrigin(origin)}/api/v1/code-projects`, {
    method: 'POST',
    redirect: 'error',
    headers: { 'x-api-key': key, 'content-type': 'application/json', 'x-playbook-client': 'vscode' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  const result = await response.json().catch(() => null)
  if (!response.ok) {
    const message = result && (result.message || result.error)
    throw new Error(typeof message === 'string' ? message : `Shots returned ${response.status}.`)
  }
  if (!result || typeof result.url !== 'string') throw new Error('Shots returned an unexpected project.')
  return result
}

module.exports = { codeProjectRequest, createCodeProject, shotsOrigin }
