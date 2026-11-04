/**
 * A Shots workspace API client for the CLI. The API key never follows a
 * redirect or leaves the configured origin, and only HTTPS (or localhost)
 * origins are accepted.
 */
export class ShotsClient {
  /**
   * @param {string} origin The Shots origin, such as https://shots.playbookmedia.io.
   * @param {string} key A workspace API key with the asset:write and artifact:read scopes.
   * @param {typeof fetch} [transport]
   */
  constructor(origin, key, transport = fetch) {
    const url = new URL(origin)
    const local = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || (url.protocol !== 'https:' && !local))
      throw new Error('Set SHOTS_ORIGIN to an HTTPS Shots origin without credentials, a path or a query.')
    if (!key?.trim()) throw new Error('Set SHOTS_API_KEY to a workspace API key.')
    this.origin = url.origin
    this.key = key.trim()
    this.transport = transport
  }

  /** @param {string} path @param {string} [method] @param {unknown} [body] */
  async request(path, method = 'GET', body) {
    if (!path.startsWith('/api/v1/') || path.includes('://')) throw new Error('Invalid API path.')
    const response = await this.transport(this.origin + path, {
      method,
      redirect: 'error',
      headers: { 'x-api-key': this.key, 'content-type': 'application/json', 'x-playbook-client': 'cli' },
      signal: AbortSignal.timeout(120_000),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const result = await response.json().catch(() => null)
    if (!response.ok) {
      const message = result && typeof result === 'object' ? result.message ?? result.error : undefined
      throw new Error(typeof message === 'string' ? message : `Shots returned ${response.status}.`)
    }
    return result
  }

  /**
   * Create a Code Studio project.
   * @param {{ files: { name?: string, code: string, lang?: string }[], name?: string, theme?: string, aspect?: string, dark?: boolean }} input
   * @returns {Promise<{ id: string, name: string, url: string }>}
   */
  async createCodeProject(input) {
    const project = await this.request('/api/v1/code-projects', 'POST', input)
    if (!project || typeof project.id !== 'string' || typeof project.url !== 'string')
      throw new Error('Shots returned an unexpected project.')
    return project
  }

  /**
   * Render a slide as a PNG and return its bytes.
   * @param {string} projectId @param {{ slide?: number, scale?: 1 | 2 | 3 }} [options]
   * @returns {Promise<Uint8Array>}
   */
  async renderPng(projectId, options = {}) {
    const rendered = await this.request(`/api/v1/code-projects/${encodeURIComponent(projectId)}/render`, 'POST', {
      slide: options.slide ?? 0,
      scale: options.scale ?? 2,
    })
    const { downloadUrl } = await this.request(`/api/v1/assets/${encodeURIComponent(rendered.assetId)}/download-url`)
    // A signed storage URL: no API key goes with it.
    const image = await this.transport(downloadUrl, { redirect: 'follow', signal: AbortSignal.timeout(120_000) })
    if (!image.ok) throw new Error(`The image download returned ${image.status}.`)
    return new Uint8Array(await image.arrayBuffer())
  }
}
