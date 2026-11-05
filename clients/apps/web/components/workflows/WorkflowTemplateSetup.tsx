'use client'

import Link from 'next/link'
import { useState } from 'react'
import { DesignTemplatePreview } from '@/components/design/DesignTemplatePreview'
import { Group, Row } from '@/components/platform-ui'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type {
  AutomationGraph,
  AutomationLayout,
  AutomationOverview,
} from '@/lib/api/contracts/release-automation'
import { actionAvailability, connectedSources } from '@/lib/workflows/actions'
import {
  buildWorkflowTemplate,
  defaultTemplateInput,
  type WorkflowTemplate,
  type WorkflowTemplateInput,
} from '@/lib/workflows/templates'
import { DeploymentHint } from './workflow-ui'

const EMPTY = '__empty_option__'
const DEFAULT_CREDIT_LIMIT = 25

/** Template options in the editor: each change rebuilds the draft's steps, and undo reverses it. */
export function WorkflowTemplateSetup({
  onChange,
  onSource,
  overview,
  sourceId,
  template,
}: {
  onChange: (next: { graph: AutomationGraph; layout: AutomationLayout }) => void
  onSource: (sourceId: string) => void
  overview: AutomationOverview
  sourceId: string
  template: WorkflowTemplate
}) {
  const [input, setInput] = useState(() => defaultTemplateInput(template, overview))
  const returnTo = encodeURIComponent(`/workflows/new?template=${template.id}`)
  const generation = actionAvailability(overview, 'generate_copy')
  const relevance = actionAvailability(overview, 'classify')
  const rendering = actionAvailability(overview, 'render_creatives')
  const capturing = actionAvailability(overview, 'capture_product')
  const canvases = actionAvailability(overview, 'create_canvas')

  function update(patch: Partial<WorkflowTemplateInput>) {
    const next = { ...input, ...patch }
    setInput(next)
    onChange(
      buildWorkflowTemplate(template.id, {
        ...next,
        branch: next.branch.trim() || 'main',
        capture: next.capture && {
          surfaceId: next.capture.surfaceId,
          versionPath: next.capture.versionPath?.trim() || undefined,
        },
      })
    )
  }

  return (
    <div className="space-y-4">
      <p className="text-xs leading-5 text-muted-foreground">
        These choices rebuild the steps on the canvas; ⌘Z undoes one. Every step stays editable, and
        nothing runs until you activate it.
      </p>
      {template.family === 'deployment.succeeded' ? <DeploymentHint /> : null}
      <Group>
        <Row
          description="Workflows run for one watched repository."
          label="Repository"
          layout="stacked"
        >
          <Select onValueChange={onSource} value={sourceId}>
            <SelectTrigger aria-label="Repository" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {connectedSources(overview).map((source) => (
                <SelectItem key={source.id} value={source.id}>
                  {source.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>
        {template.id === 'feature-announcement' ? (
          <Row
            description="Only pull requests merged into this branch qualify."
            label="Branch"
            layout="stacked"
          >
            <Input
              aria-label="Pull request base branch"
              onChange={(event) => update({ branch: event.target.value })}
              value={input.branch}
            />
          </Row>
        ) : null}
        <Row
          description="Drafts use this published visual brand kit."
          label="Visual brand kit"
          layout="stacked"
        >
          {overview.brands.length === 0 ? (
            <Link
              className="text-sm underline"
              href={`/settings/brand-kit?returnTo=${returnTo}`}
              rel="noopener noreferrer"
              target="_blank"
            >
              Create and publish a brand kit (new tab)
            </Link>
          ) : (
            <Select
              onValueChange={(next) => update({ brandKitId: next === EMPTY ? '' : next })}
              value={input.brandKitId || EMPTY}
            >
              <SelectTrigger aria-label="Visual brand kit" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={EMPTY}>Select a published brand kit</SelectItem>
                {overview.brands.map((brand) => (
                  <SelectItem key={brand.id} value={brand.id}>
                    {brand.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </Row>
        <Row description="One draft post per destination." label="Destinations" layout="stacked">
          {overview.destinations.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Connect a destination in{' '}
              <Link className="underline" href={`/settings/channels?returnTo=${returnTo}`}>
                Channels
              </Link>{' '}
              first.
            </p>
          ) : (
            <div className="flex flex-wrap gap-4">
              {overview.destinations.map((destination) => (
                <Label className="flex items-center gap-2 text-sm" key={destination.id}>
                  <Checkbox
                    checked={input.destinationIds.includes(destination.id)}
                    onCheckedChange={(checked) =>
                      update({
                        destinationIds:
                          checked === true
                            ? [...input.destinationIds, destination.id]
                            : input.destinationIds.filter((id) => id !== destination.id),
                      })
                    }
                  />
                  {destination.name}
                </Label>
              ))}
            </div>
          )}
        </Row>
        <Row
          description={
            generation.available
              ? 'Rewrites each draft for its channel in your brand voice. Spends AI credits, at most the limit, once per run.'
              : `Unavailable: ${generation.reason}`
          }
          label="AI channel copy"
          layout="stacked"
        >
          <div className="flex flex-wrap items-center gap-4">
            <Label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={input.creditLimit > 0}
                disabled={!generation.available}
                onCheckedChange={(checked) =>
                  update({ creditLimit: checked === true ? DEFAULT_CREDIT_LIMIT : 0 })
                }
              />
              Generate copy with AI
            </Label>
            {input.creditLimit > 0 ? (
              <Label className="flex items-center gap-2 text-sm">
                Credit limit
                <Input
                  className="w-24"
                  max={500}
                  min={1}
                  onChange={(event) =>
                    update({ creditLimit: Math.trunc(Number(event.target.value)) || 1 })
                  }
                  type="number"
                  value={input.creditLimit}
                />
              </Label>
            ) : null}
          </div>
        </Row>
        {template.versioned ? (
          <Row
            description="Patch releases (x.y.1) and prereleases are skipped. Tags that are not versions ask for attention."
            label="What counts as a release"
            layout="stacked"
          >
            <Label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={input.majorMinorOnly}
                onCheckedChange={(checked) => update({ majorMinorOnly: checked === true })}
              />
              Only major and minor versions
            </Label>
          </Row>
        ) : null}
        <Row
          description={
            relevance.available
              ? 'Replaces the rule-based check with an AI judgment of whether customers would care, under criteria you can edit. A few credits per event.'
              : `Unavailable: ${relevance.reason}`
          }
          label="AI relevance check"
          layout="stacked"
        >
          <Label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={input.aiRelevance}
              disabled={!relevance.available}
              onCheckedChange={(checked) => update({ aiRelevance: checked === true })}
            />
            Let AI judge whether this is worth marketing
          </Label>
        </Row>
        <Row
          description={
            rendering.available
              ? 'Fills design templates with your latest product capture and the release headline, in your brand kit. Designs stay drafts until approved.'
              : `Unavailable: ${rendering.reason}`
          }
          label="Rendered creatives"
          layout="stacked"
        >
          <div className="grid w-full gap-3">
            {(overview.templates ?? []).map((design) => (
              <Label className="grid gap-2 rounded-lg border p-3 text-sm" key={design.id}>
                <DesignTemplatePreview id={design.id} />
                <Checkbox
                  checked={input.renderTemplateIds.includes(design.id)}
                  disabled={
                    !rendering.available ||
                    (!input.renderTemplateIds.includes(design.id) &&
                      input.renderTemplateIds.length >= 3)
                  }
                  onCheckedChange={(checked) =>
                    update({
                      renderTemplateIds:
                        checked === true
                          ? [...input.renderTemplateIds, design.id]
                          : input.renderTemplateIds.filter((id) => id !== design.id),
                    })
                  }
                />
                {design.name} · {design.aspectRatio.replace('_', ':')}
              </Label>
            ))}
          </div>
        </Row>
        {template.family === 'deployment.succeeded' ? (
          <Row
            description={
              capturing.available
                ? 'Captures one product page for this deployment after your app reports the deployed commit, so creatives never show an older image.'
                : `Unavailable: ${capturing.reason}`
            }
            label="Deployment capture"
            layout="stacked"
          >
            <div className="grid w-full gap-3">
              <Label className="grid gap-1 text-sm">
                Product page
                <Select
                  disabled={!capturing.available}
                  onValueChange={(next) =>
                    update({
                      capture:
                        next === EMPTY
                          ? undefined
                          : {
                              surfaceId: next,
                              versionPath: input.capture?.versionPath ?? '/api/version',
                            },
                    })
                  }
                  value={input.capture?.surfaceId ?? EMPTY}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={EMPTY}>Don&apos;t capture</SelectItem>
                    {(overview.surfaces ?? []).map((surface) => (
                      <SelectItem key={surface.id} value={surface.id}>
                        {surface.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Label>
              {input.capture ? (
                <Label className="grid gap-1 text-sm">
                  Path that reports the deployed commit
                  <Input
                    maxLength={256}
                    onChange={(event) =>
                      update({
                        capture: input.capture && {
                          ...input.capture,
                          versionPath: event.target.value,
                        },
                      })
                    }
                    value={input.capture.versionPath ?? ''}
                  />
                </Label>
              ) : null}
            </div>
          </Row>
        ) : null}
        <Row
          description={
            canvases.available
              ? 'Lays out a feature announcement and social formats from the release on a new canvas, quoting only the release record. Your team refines and exports it.'
              : `Unavailable: ${canvases.reason}`
          }
          label="Canvas"
          layout="stacked"
        >
          <Label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={input.canvas}
              disabled={!canvases.available}
              onCheckedChange={(checked) => update({ canvas: checked === true })}
            />
            Lay out a canvas from the release
          </Label>
        </Row>
      </Group>
    </div>
  )
}
