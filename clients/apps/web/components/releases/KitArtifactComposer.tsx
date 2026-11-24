'use client'

import { useState } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import {
  kitArtifactInputSchema,
  releaseMaterialSchema,
  type KitArtifactInput,
  type ReleaseClaim,
  type ReleaseQualification,
} from 'screenshot-studio-backend-sdk'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Combobox } from '@/components/ui/combobox'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { MediaThumb } from '@/components/write/composer/media-thumb'
import { useTRPC } from '@/lib/trpc/react'
import { listContentDraftsContract } from '@/lib/api/contracts/content-drafts'
import { settingsRequest, settingsErrorMessage } from '@/lib/settings/client'

type NewArtifact = Exclude<KitArtifactInput, { existingArtifactId: string }>

/** Native stable node identities, so a person maps each assertion without editing JSON. */
function assertionNodes(document: unknown): { value: string; label: string }[] {
  const nodes = new Map<string, string>()
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    if (!value || typeof value !== 'object') return
    const row = value as Record<string, unknown>
    if (typeof row.id === 'string') {
      const text =
        typeof row.text === 'string'
          ? row.text
          : JSON.stringify(row.children ?? row.name ?? row.type ?? 'Image or layer')
      nodes.set(row.id, `${text.slice(0, 80)} · ${row.id.slice(0, 8)}`)
    }
    Object.values(row).forEach(visit)
  }
  visit(document)
  return [...nodes].map(([value, label]) => ({ value, label }))
}

/** Select from existing authoring owners; the kit never becomes another editor. */
export function KitArtifactComposer({
  qualification,
  claims,
  scope,
  disabled,
  onAdd,
}: {
  qualification: ReleaseQualification
  claims: ReleaseClaim[]
  scope: { userId: string; workspaceId: string }
  disabled: boolean
  onAdd: (input: NewArtifact, label: string) => void
}) {
  const trpc = useTRPC()
  const [sourceKind, setSourceKind] = useState<NewArtifact['sourceKind']>('TEMPLATE')
  const [kind, setKind] = useState<NewArtifact['kind']>('FACT_SHEET')
  const [audienceId, setAudienceId] = useState(
    qualification.current?.facts.requirements[0]?.id ?? ''
  )
  const [sourceId, setSourceId] = useState('')
  const [outputId, setOutputId] = useState('')
  const [selected, setSelected] = useState<Record<string, string>>({})
  const [cleared, setCleared] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const drafts = useInfiniteQuery({
    queryKey: ['kit-drafts', scope.workspaceId, scope.userId],
    enabled: sourceKind === 'DRAFT',
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      settingsRequest(
        `/api/v1/content-drafts?limit=50${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`,
        listContentDraftsContract.output,
        { scope, signal }
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  })
  const assets = useInfiniteQuery(
    trpc.asset.list.infiniteQueryOptions(
      { limit: 50, type: 'image', sort: 'newest' },
      { enabled: sourceKind === 'ASSET', getNextPageParam: (page) => page.nextCursor }
    )
  )
  const creatives = useInfiniteQuery(
    trpc.creativeSet.list.infiniteQueryOptions(
      { limit: 50, sort: 'updated' },
      { enabled: sourceKind === 'CREATIVE', getNextPageParam: (page) => page.nextCursor }
    )
  )
  const creative = useQuery(
    trpc.creativeSet.get.queryOptions(
      { creativeSetId: sourceId },
      { enabled: sourceKind === 'CREATIVE' && Boolean(sourceId) }
    )
  )
  const draftRows = drafts.data?.pages.flatMap((page) => [...page.pinned, ...page.items]) ?? []
  const assetRows = assets.data?.pages.flatMap((page) => page.assets) ?? []
  const creativeRows =
    creatives.data?.pages.flatMap((page) => page.items).filter((set) => set.kind === 'story-set') ??
    []
  const draft = draftRows.find((item) => item.id === sourceId)
  const asset = assetRows.find((item) => item.id === sourceId)
  const nodes =
    sourceKind === 'ASSET'
      ? [{ value: 'image', label: 'Visible screenshot content' }]
      : assertionNodes(
          sourceKind === 'DRAFT'
            ? draft?.body
            : creative.data?.document.outputs.find((output) => output.id === outputId)?.document
        )
  const sourceOptions =
    sourceKind === 'DRAFT'
      ? [...new Map(draftRows.map((item) => [item.id, item])).values()].map((item) => ({
          value: item.id,
          label: item.title || 'Untitled draft',
          description: `Saved version ${item.version}`,
        }))
      : sourceKind === 'ASSET'
        ? assetRows
            .filter((item) => ['image/png', 'image/jpeg', 'image/webp'].includes(item.mediaType))
            .map((item) => ({
              value: item.id,
              label: item.fileName || 'Uploaded image',
              disabled: !item.sha256,
            }))
        : creativeRows.map((item) => ({
            value: item.id,
            label: item.name,
            description: `Saved version ${item.revision}`,
          }))
  const listing = sourceKind === 'DRAFT' ? drafts : sourceKind === 'ASSET' ? assets : creatives
  const add = () => {
    try {
      const input = kitArtifactInputSchema.parse({
        existingArtifactId: null,
        kind,
        audienceId,
        classification: cleared ? 'CUSTOMER_CLEARED' : 'INTERNAL_MATERIAL',
        sourceKind,
        sourceId,
        expectedNativeRevision:
          sourceKind === 'DRAFT'
            ? String(draft?.version ?? '')
            : sourceKind === 'ASSET'
              ? (asset?.sha256 ?? '')
              : sourceKind === 'CREATIVE'
                ? String(creative.data?.revision ?? '')
                : '',
        outputId,
        claims: Object.entries(selected).map(([claimVersionId, nodeId]) => ({
          claimVersionId,
          nodeId: sourceKind === 'TEMPLATE' ? `claim-${claimVersionId}` : nodeId,
        })),
      })
      if ('kind' in input)
        onAdd(
          input,
          `${kind.replaceAll('_', ' ')} · ${sourceOptions.find((item) => item.value === sourceId)?.label ?? 'Verified facts template'}`
        )
      setError(null)
    } catch (failure) {
      setError(settingsErrorMessage(failure))
    }
  }
  return (
    <fieldset disabled={disabled} className="space-y-4 rounded-xl border p-4">
      <legend className="px-2 text-sm font-medium">Add material</legend>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="kit-audience">Audience</Label>
          <Combobox
            id="kit-audience"
            value={audienceId}
            disabled={disabled}
            onValueChange={setAudienceId}
            options={(qualification.current?.facts.requirements ?? []).map((item) => ({
              value: item.id,
              label: item.label || item.kind.replaceAll('_', ' '),
            }))}
          />
        </div>
        <div>
          <Label htmlFor="kit-material">Material</Label>
          <Select
            value={kind}
            disabled={disabled}
            onValueChange={(value) => {
              const next = releaseMaterialSchema.parse(value)
              setKind(next)
              setSourceKind(next === 'SCREENSHOT' ? 'ASSET' : 'TEMPLATE')
              setSourceId('')
              setSelected({})
            }}
          >
            <SelectTrigger id="kit-material">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {releaseMaterialSchema.options.map((value) => (
                <SelectItem key={value} value={value}>
                  {value.replaceAll('_', ' ')}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label htmlFor="kit-source-kind">Start from</Label>
          <Select
            value={sourceKind}
            disabled={disabled}
            onValueChange={(value) => {
              setSourceKind(value as NewArtifact['sourceKind'])
              setSourceId('')
              setOutputId('')
              setSelected({})
            }}
          >
            <SelectTrigger id="kit-source-kind">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(kind === 'SCREENSHOT'
                ? [
                    ['ASSET', 'Library image'],
                    ['CREATIVE', 'Saved Story Set output'],
                  ]
                : [
                    ['TEMPLATE', 'Verified facts template'],
                    ['DRAFT', 'Saved Write draft'],
                  ]
              ).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {sourceKind !== 'TEMPLATE' ? (
          <div>
            <Label htmlFor="kit-native-source">Saved source</Label>
            <Combobox
              id="kit-native-source"
              disabled={disabled || listing.isPending}
              value={sourceId}
              onValueChange={(id) => {
                setSourceId(id)
                setOutputId('')
                setSelected({})
              }}
              options={sourceOptions}
            />
            {listing.isError ? (
              <Button variant="outline" onClick={() => void listing.refetch()}>
                Retry sources
              </Button>
            ) : null}
            {listing.hasNextPage ? (
              <Button
                variant="ghost"
                disabled={listing.isFetchingNextPage}
                onClick={() => void listing.fetchNextPage()}
              >
                More sources
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      {sourceKind === 'CREATIVE' && creative.data ? (
        <div>
          <Label htmlFor="kit-creative-output">Output</Label>
          <Combobox
            id="kit-creative-output"
            value={outputId}
            disabled={disabled}
            onValueChange={(id) => {
              setOutputId(id)
              setSelected({})
            }}
            options={creative.data.document.outputs.map((output) => ({
              value: output.id,
              label: `${output.format} · ${creative.data.document.stories.find((story) => story.id === output.storyId)?.headline ?? 'Story'}`,
            }))}
          />
          <p className="text-xs text-muted-foreground">
            Use a bundled font. Save changes in Create before freezing this output.
          </p>
        </div>
      ) : null}
      {creative.isError && sourceKind === 'CREATIVE' ? (
        <p role="alert">The saved creative could not load.</p>
      ) : null}
      {sourceKind === 'ASSET' && asset ? (
        <MediaThumb video={false} assetId={asset.id} className="max-h-48 object-contain" />
      ) : null}
      {sourceKind === 'DRAFT' && draft ? (
        <p className="max-h-48 overflow-auto whitespace-pre-wrap text-sm">{draft.plainText}</p>
      ) : null}
      <p className="text-sm">
        Select every factual claim used here. For saved content, select the block or layer that
        contains it. Add non-factual context in Write; confirm its coverage during review.
      </p>
      <ul className="space-y-3">
        {claims
          .filter((claim) => claim.state === 'SUPPORTED')
          .map((claim) => {
            const version = claim
            return (
              <li key={claim.id} className="space-y-2">
                <div className="flex items-start gap-2">
                  <Checkbox
                    id={`kit-claim-${claim.id}`}
                    disabled={disabled}
                    checked={version.versionId in selected}
                    onCheckedChange={(checked) =>
                      setSelected((current) => {
                        const next = { ...current }
                        if (checked === true) next[version.versionId] = ''
                        else delete next[version.versionId]
                        return next
                      })
                    }
                  />
                  <Label htmlFor={`kit-claim-${claim.id}`}>{version.text}</Label>
                </div>
                {sourceKind !== 'TEMPLATE' && version.versionId in selected ? (
                  <Combobox
                    aria-label={`Assertion block for ${version.text}`}
                    disabled={disabled}
                    value={selected[version.versionId]}
                    onValueChange={(nodeId) =>
                      setSelected((current) => ({ ...current, [version.versionId]: nodeId }))
                    }
                    options={nodes}
                  />
                ) : null}
              </li>
            )
          })}
      </ul>
      <div className="flex items-start gap-2">
        <Checkbox
          id="kit-customer-cleared"
          disabled={disabled}
          checked={cleared}
          onCheckedChange={(value) => setCleared(value === true)}
        />
        <Label htmlFor="kit-customer-cleared">
          This material is safe for customer distribution. Its evidence also needs explicit
          clearance for this audience.
        </Label>
      </div>
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
      <Button
        variant="outline"
        disabled={
          disabled ||
          !audienceId ||
          (sourceKind !== 'TEMPLATE' && !sourceId) ||
          (sourceKind === 'CREATIVE' && !outputId)
        }
        onClick={add}
      >
        Add to candidate
      </Button>
    </fieldset>
  )
}
