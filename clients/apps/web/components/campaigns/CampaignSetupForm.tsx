'use client'

import { useRouter } from 'next/navigation'
import { type FormEvent, type ReactNode, useRef, useState } from 'react'
import { Group, Row, Section } from '@/components/platform-ui'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { getErrorMessage } from '@/components/workspace/settings-client'
import { trackEvent } from '@/lib/analytics'
import { useTRPCClient } from '@/lib/trpc/react'
import { briefValidationMessage, normalizeProductUrl } from '@/lib/campaigns/brief-form'
import { useUnsavedCampaignChanges } from '@/components/campaigns/useUnsavedCampaignChanges'
import {
  productSurfaceCreateSchema,
  releaseCreateSchema,
  productEnvironments,
} from '@/lib/tenant/schemas'
import {
  Select as UiSelect,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select'

/**
 * The short path from "what shipped" to a saved campaign draft: a title and
 * why it matters, with everything else optional and folded away. Each step is persisted before the next runs, and a retry reuses
 * what already exists: a created product is selected, and the release is
 * created with a stable idempotency key, so resubmitting never duplicates.
 */

type Surface = { environment: string; id: string; name: string; url: string }

type CampaignSetupFormProps = {
  canCreate: boolean
  canManageProducts: boolean
  surfaces: Surface[]
}

const NEW_PRODUCT = 'new'

const inputClassName = 'h-10 rounded-lg'
const textareaClassName = 'min-h-24 rounded-lg'
const selectClassName =
  'h-10 w-full rounded-lg border border-input bg-transparent px-3 text-sm disabled:opacity-50 dark:bg-input/30'

/** A label above its control, inside a free-form Row. */
function Field({
  children,
  htmlFor,
  label,
}: {
  children: ReactNode
  htmlFor: string
  label: string
}) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  )
}

function field(data: FormData, name: string): string {
  return String(data.get(name) ?? '').trim()
}

function parseSourceUrls(value: string): string[] {
  return value
    .split(/\s+/)
    .map((url) => url.trim())
    .filter(Boolean)
}

export function CampaignSetupForm({
  canCreate,
  canManageProducts,
  surfaces: initialSurfaces,
}: CampaignSetupFormProps) {
  const router = useRouter()
  const trpcClient = useTRPCClient()
  const startedAt = useRef(Date.now())
  const [idempotencyKey] = useState(() => crypto.randomUUID())
  const [surfaces, setSurfaces] = useState(initialSurfaces)
  // A campaign needs what shipped, not a product: one can be added here or later.
  const [surfaceChoice, setSurfaceChoice] = useState(initialSurfaces[0]?.id ?? '')
  const [error, setError] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [values, setValues] = useState<Record<string, string>>({})
  const [dirty, setDirty] = useState(false)
  useUnsavedCampaignChanges(dirty)
  const isNewProduct = surfaceChoice === NEW_PRODUCT

  async function createProduct(data: FormData, created: string[]): Promise<string> {
    const name = field(data, 'productName')
    const { productSurface } = await trpcClient.productSurface.create.mutate({
      environment: field(data, 'environment') as (typeof productEnvironments)[number],
      name,
      url: normalizeProductUrl(field(data, 'appUrl')),
    })
    created.push(productSurface.id)
    setSurfaces((current) => [...current, productSurface])
    setSurfaceChoice(productSurface.id)
    const marketingUrl = normalizeProductUrl(field(data, 'marketingUrl'))
    if (marketingUrl) {
      const marketing = await trpcClient.productSurface.create.mutate({
        name: `${name} marketing site`,
        url: marketingUrl,
      })
      created.push(marketing.productSurface.id)
    }
    trackEvent('product_surface_created', { source: 'campaign_setup' })
    // Select the new surface so a retry after a later failure reuses it
    // instead of colliding with the name it just took.
    return productSurface.id
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setError(null)
    setIsSaving(true)
    const data = new FormData(event.currentTarget)
    const createdProducts: string[] = []
    let releaseSaved = false
    try {
      const title = field(data, 'title')
      const benefitStatement = field(data, 'benefitStatement')
      const audience = field(data, 'audience')
      const parsed = releaseCreateSchema.safeParse({
        audience: audience || undefined,
        benefitStatement,
        description: field(data, 'description') || undefined,
        sourceUrls: parseSourceUrls(field(data, 'sourceUrls')),
        title,
      })
      if (!parsed.success) throw new Error(briefValidationMessage(parsed.error))
      if (!benefitStatement && !parsed.data.sourceUrls?.length) {
        throw new Error('Why it matters: enter a benefit or add a source link.')
      }
      if (isNewProduct) {
        const product = productSurfaceCreateSchema.safeParse({
          name: field(data, 'productName'),
          url: normalizeProductUrl(field(data, 'appUrl')),
          environment: field(data, 'environment'),
        })
        if (!product.success) throw new Error(briefValidationMessage(product.error))
        const marketingUrl = normalizeProductUrl(field(data, 'marketingUrl'))
        if (marketingUrl) {
          const marketing = productSurfaceCreateSchema.safeParse({
            name: `${product.data.name} marketing site`,
            url: marketingUrl,
          })
          if (!marketing.success)
            throw new Error(`Marketing site: ${briefValidationMessage(marketing.error)}`)
        }
      }
      const productSurfaceId = isNewProduct
        ? await createProduct(data, createdProducts)
        : surfaceChoice || undefined
      const { release } = await trpcClient.release.create.mutate({
        ...parsed.data,
        idempotencyKey,
        productSurfaceId,
      })
      releaseSaved = true
      trackEvent('release_created', { source: 'campaign_setup' })
      const { campaign } = await trpcClient.campaign.create.mutate({
        audience: audience || undefined,
        idempotencyKey,
        name: title,
        // The release may skip why it matters when sources are linked; a
        // campaign still needs an objective, so the title stands in.
        objective: benefitStatement || title,
        releaseId: release.id,
      })
      trackEvent('campaign_draft_created', {
        elapsedSeconds: Math.round((Date.now() - startedAt.current) / 1_000),
      })
      setDirty(false)
      router.push(`/campaigns/${campaign.id}`)
    } catch (requestError) {
      const cleanupFailures: string[] = []
      if (!releaseSaved) {
        for (const surfaceId of createdProducts.toReversed()) {
          try {
            await trpcClient.productSurface.delete.mutate({ surfaceId })
            setSurfaces((current) => current.filter((surface) => surface.id !== surfaceId))
            setSurfaceChoice((current) => (current === surfaceId ? NEW_PRODUCT : current))
          } catch {
            cleanupFailures.push(surfaceId)
          }
        }
      }
      setError(
        getErrorMessage(requestError) +
          (cleanupFailures.length ? ' The product was kept; select it when retrying.' : '')
      )
      setIsSaving(false)
    }
  }

  if (!canCreate) {
    return (
      <p className="text-sm text-muted-foreground">
        Your role cannot create campaigns. Ask a workspace admin for creator access.
      </p>
    )
  }

  return (
    <form
      className="flex flex-col gap-10"
      onChange={(event) => {
        setDirty(true)
        const target = event.target
        if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)
          setValues((current) => ({ ...current, [target.name]: target.value }))
      }}
      onSubmit={handleSubmit}
    >
      <Section description="What did you ship? This becomes the campaign brief." title="Release">
        <Group>
          <Row>
            <Field htmlFor="campaign-release-title" label="Release title (required)">
              <Input
                className={inputClassName}
                id="campaign-release-title"
                maxLength={160}
                name="title"
                required
              />
            </Field>
            <Field htmlFor="campaign-benefit" label="Why it matters">
              <Input
                aria-describedby="campaign-benefit-hint"
                className={inputClassName}
                id="campaign-benefit"
                maxLength={500}
                name="benefitStatement"
                placeholder="One sentence on what this changes for your users"
              />
              <p className="text-xs text-muted-foreground" id="campaign-benefit-hint">
                Or add a source link, and the AI drafts it from your sources.
              </p>
            </Field>
            <Field htmlFor="campaign-sources" label="Source links (optional)">
              <Textarea
                className={textareaClassName}
                id="campaign-sources"
                name="sourceUrls"
                placeholder="Changelog, pull request, or docs URLs, one per line"
              />
            </Field>
          </Row>
        </Group>
      </Section>

      <Disclosure>
        <DisclosureTrigger className="py-2 text-sm font-medium text-foreground">
          More details
        </DisclosureTrigger>
        <DisclosureContent className="flex flex-col gap-10 pt-4">
          <Section
            description="The app this campaign captures and promotes. You can add it later."
            title="Product"
          >
            <Group>
              <Row>
                <Field htmlFor="campaign-product" label="Product">
                  <UiSelect
                    onValueChange={(nextValue) =>
                      setSurfaceChoice(nextValue === '__empty_option__' ? '' : nextValue)
                    }
                    value={String(surfaceChoice) || '__empty_option__'}
                  >
                    <SelectTrigger className={selectClassName} id="campaign-product">
                      <SelectValue>
                        {isNewProduct
                          ? 'Add a product…'
                          : (surfaces.find((surface) => surface.id === surfaceChoice)?.name ??
                            'No product')}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {surfaces.map((surface) => (
                        <SelectItem key={surface.id} value={surface.id}>
                          {surface.name} ({surface.environment})
                        </SelectItem>
                      ))}
                      {canManageProducts ? (
                        <SelectItem value={NEW_PRODUCT}>Add a product…</SelectItem>
                      ) : null}
                      <SelectItem value={'__empty_option__'}>No product</SelectItem>
                    </SelectContent>
                  </UiSelect>
                </Field>
              </Row>
              {isNewProduct ? (
                <Row>
                  <Field htmlFor="campaign-product-name" label="Product name (required)">
                    <Input
                      className={inputClassName}
                      id="campaign-product-name"
                      maxLength={160}
                      name="productName"
                      defaultValue={values.productName ?? ''}
                      required
                    />
                  </Field>
                  <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
                    <Field htmlFor="campaign-app-url" label="App URL (required)">
                      <Input
                        className={inputClassName}
                        id="campaign-app-url"
                        name="appUrl"
                        defaultValue={values.appUrl ?? ''}
                        placeholder="https://app.example.com"
                        required
                        type="text"
                        inputMode="url"
                        onBlur={(event) => {
                          const value = normalizeProductUrl(event.target.value)
                          event.target.value = value
                          const name = event.target.name
                          setValues((current) => ({ ...current, [name]: value }))
                        }}
                      />
                    </Field>
                    <Field htmlFor="campaign-environment" label="Environment">
                      <UiSelect defaultValue="production" name="environment">
                        <SelectTrigger className={selectClassName} id="campaign-environment">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {productEnvironments.map((environment) => (
                            <SelectItem key={environment} value={environment}>
                              {environment}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </UiSelect>
                    </Field>
                  </div>
                  <Field htmlFor="campaign-marketing-url" label="Marketing site URL (optional)">
                    <Input
                      className={inputClassName}
                      id="campaign-marketing-url"
                      name="marketingUrl"
                      defaultValue={values.marketingUrl ?? ''}
                      placeholder="https://example.com"
                      type="text"
                      inputMode="url"
                      onBlur={(event) => {
                        const value = normalizeProductUrl(event.target.value)
                        event.target.value = value
                        const name = event.target.name
                        setValues((current) => ({ ...current, [name]: value }))
                      }}
                    />
                  </Field>
                </Row>
              ) : null}
            </Group>
          </Section>

          <Section title="Brief">
            <Group>
              <Row>
                <Field htmlFor="campaign-description" label="Description (optional)">
                  <Textarea
                    className={textareaClassName}
                    id="campaign-description"
                    maxLength={10_000}
                    name="description"
                    placeholder="What changed, in your own words. Plain text."
                  />
                </Field>
                <Field htmlFor="campaign-audience" label="Target audience (optional)">
                  <Input
                    className={inputClassName}
                    id="campaign-audience"
                    maxLength={1_000}
                    name="audience"
                    placeholder="Who should hear about this?"
                  />
                </Field>
              </Row>
            </Group>
          </Section>
        </DisclosureContent>
      </Disclosure>

      {error ? (
        <Alert
          className="rounded-xl border-0 bg-red-500/5 ring-1 ring-red-500/20"
          variant="destructive"
        >
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="flex justify-end">
        <Button className="h-10 rounded-lg px-5" disabled={isSaving} type="submit">
          {isSaving ? 'Creating…' : 'Create campaign'}
        </Button>
      </div>
    </form>
  )
}
