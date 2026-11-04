import { z } from 'zod'

const account = z.object({ id: z.string(), platform: z.string(), health: z.string() }).passthrough()
export const socialSet = z.object({ id: z.string(), name: z.string(), visibility: z.enum(['WORKSPACE', 'PRIVATE']), defaultPlatforms: z.array(z.string()), accounts: z.array(account) }).passthrough()
export const draft = z.object({ id: z.string(), title: z.string(), plainText: z.string(), version: z.number(), status: z.string(), socialSetId: z.string().nullable(), plannedFor: z.string().nullable() }).passthrough()
export type SocialSet = z.infer<typeof socialSet>
export type Draft = z.infer<typeof draft>

/** Workspace API client. Credentials never follow redirects or leave the configured origin. */
export class ShotsClient {
  readonly origin: string
  constructor(baseUrl: string, private readonly key: string, private readonly transport: typeof fetch = fetch) {
    const url = new URL(baseUrl)
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('Use an HTTPS Shots origin without credentials, a path, or a query.')
    if (!key.trim()) throw new Error('Set your workspace API key in extension preferences.')
    this.origin = url.origin
  }
  async request(path: string, method = 'GET', body?: unknown): Promise<unknown> {
    if (!path.startsWith('/api/v1/') || path.includes('://')) throw new Error('Invalid API path.')
    const response = await this.transport(this.origin + path, {method, redirect: 'error', headers: {'x-api-key': this.key, 'content-type': 'application/json'}, signal: AbortSignal.timeout(20_000), ...(body === undefined ? {} : {body: JSON.stringify(body)})})
    const result: unknown = response.status === 204 ? null : await response.json().catch(() => { throw new Error(`Shots returned ${response.status} without a readable response. Retry with the same request ID.`) })
    if (!response.ok) {
      const error = z.object({message: z.string().optional(), error: z.string().optional()}).passthrough().safeParse(result)
      throw new Error(error.success ? error.data.message ?? error.data.error ?? `Shots returned ${response.status}.` : `Shots returned ${response.status}.`)
    }
    return result
  }
  async sets(): Promise<SocialSet[]> { return z.object({items: z.array(socialSet)}).parse(await this.request('/api/v1/social-sets')).items }
  async list(input: {search?: string; socialSetId?: string; view?: string} = {}): Promise<Draft[]> {
    const view = z.enum(['drafts', 'scheduled', 'posted', 'archived']).optional().parse(input.view)
    const query = new URLSearchParams({limit: '100', ...Object.fromEntries(Object.entries({...input, view: view === 'scheduled' ? 'drafts' : view, status: view === 'scheduled' ? 'scheduled' : undefined}).filter(([, value]) => value))})
    const page = z.object({items: z.array(draft), pinned: z.array(draft).default([])}).parse(await this.request(`/api/v1/content-drafts?${query}`))
    return [...new Map([...page.pinned, ...page.items].map((item) => [item.id, item])).values()]
  }
  async get(id: string): Promise<Draft> { return draft.parse(await this.request(`/api/v1/content-drafts/${encodeURIComponent(id)}`)) }
  async create(input: {requestId: string; socialSetId: string; text: string; platforms?: string[]; title?: string}): Promise<Draft> {
    if (input.requestId.length < 16 || input.requestId.length > 128) throw new Error('Use a stable request ID of 16–128 characters; reuse it after an uncertain response.')
    const set = (await this.sets()).find((set) => set.id === input.socialSetId)
    if (!set) throw new Error('This social set is unavailable to this key.')
    const platforms = input.platforms?.length ? input.platforms : set.defaultPlatforms
    const accounts = platforms.map((platform) => {
      const account = set.accounts.find((account) => account.platform === platform)
      if (!account) throw new Error(`No ${platform} account in this social set.`)
      return account.id
    })
    const posts = input.text.replace(/\r\n?/g, '\n').split(/\n[ \t]*---[ \t]*\n|\n(?:[ \t]*\n){3,}/).map((post) => post.trim()).filter(Boolean)
    if (!posts.length || posts.length > 25 || input.text.length > 100_000) throw new Error('Write 1–25 posts, up to 100,000 characters.')
    // Stable IDs keep a retried import byte-for-byte identical.
    const body = posts.flatMap((text, index) => [{type: 'post_break', id: `import_${index}`, children: [{text: ''}]}, ...text.split('\n').map((text) => ({type: 'p', children: [{text}]}))])
    return draft.parse(await this.request('/api/v1/content-drafts', 'POST', {importKey: input.requestId, socialSetId: set.id, title: input.title?.trim() || posts[0].slice(0, 80), plainText: posts.join('\n\n'), body, channelConnectionIds: accounts}))
  }
  async plan(id: string, plannedFor: string, timeZone: string): Promise<Draft> {
    return draft.parse(await this.request(`/api/v1/content-drafts/${encodeURIComponent(id)}/plan`, 'POST', {plannedFor, timeZone}))
  }
  async duplicate(id: string): Promise<Draft> { return z.object({draft}).parse(await this.request(`/api/v1/content-drafts/${encodeURIComponent(id)}/duplicate`, 'POST')).draft }
  async delete(id: string) { await this.request(`/api/v1/content-drafts/${encodeURIComponent(id)}`, 'DELETE') }
  async posts(id: string) { return this.request(`/api/v1/content-drafts/${encodeURIComponent(id)}/posts`) }
  async queue() {
    const from = new Date(Date.now() - 7 * 86400_000).toISOString()
    const to = new Date(Date.now() + 90 * 86400_000).toISOString()
    return z.object({items: z.array(z.object({id:z.string(),draftId:z.string(),draftTitle:z.string(),caption:z.string(),platform:z.string(),status:z.string(),scheduledFor:z.string()}))}).parse(await this.request(`/api/v1/content-draft-posts?${new URLSearchParams({from, to})}`)).items
  }
  draftURL(id: string) { return `${this.origin}/publish/${encodeURIComponent(id)}` }
}
