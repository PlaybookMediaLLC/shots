'use client'

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'

import type {
  AutomationAction,
  AutomationActionType,
  AutomationGraph,
  AutomationNode,
  AutomationOverview,
} from '@/lib/api/contracts/release-automation'
import { DesignTemplatePreview } from '@/components/design/DesignTemplatePreview'
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
import {
  actionAvailability,
  producersOf,
  workflowActionTypes,
  WORKFLOW_ACTIONS,
} from '@/lib/workflows/actions'
import { automationSelectClass } from './ConditionEditor'
import { CANVAS_RECIPES, canvasRecipeSchema } from '@/lib/canvas/recipes'

const EMPTY = '__empty_option__'

/** A fresh configuration for a newly chosen action type. */
function blankAction(type: AutomationActionType): AutomationAction {
  if (type === 'generate_copy') return { type, creditLimit: 25 }
  if (type === 'render_creatives') return { type, templateIds: ['layout-browser-launch'] }
  if (type === 'create_canvas') return { type, recipeIds: ['feature-announcement', 'social-pack'] }
  if (type === 'render_code_visual') return { type, readSourceCode: false }
  return { type }
}

/** Action-specific inputs, driven by the registry and the backend's availability. */
export function ActionEditor({
  node,
  graph,
  overview,
  onChange,
}: {
  node: AutomationNode
  graph: AutomationGraph
  overview: AutomationOverview
  onChange: (action: AutomationAction) => void
}) {
  const pathname = usePathname()
  const params = useSearchParams()
  const back = new URLSearchParams(params.toString())
  back.set('node', node.id)
  const returnTo = encodeURIComponent(`${pathname}?${back}`)
  const action = node.action ?? blankAction('create_release')
  const spec = WORKFLOW_ACTIONS[action.type]
  const availability = actionAvailability(overview, action.type)
  const producers = producersOf(action.type)
  return (
    <div className="space-y-3">
      <Label className="grid gap-1 text-sm">
        Action
        <Select
          value={action.type}
          onValueChange={(nextValue) => onChange(blankAction(nextValue as AutomationActionType))}
        >
          <SelectTrigger className={automationSelectClass}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {workflowActionTypes.map((type) => (
              <SelectItem key={type} value={type}>
                {WORKFLOW_ACTIONS[type].label}
                {actionAvailability(overview, type).available ? '' : ' (unavailable)'}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Label>
      <p className="text-xs leading-5 text-muted-foreground">{spec.description}</p>
      {availability.available ? null : (
        <p
          role="note"
          className="rounded-lg bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-300"
        >
          Not executable yet: {availability.reason}
        </p>
      )}
      {action.type !== 'create_release' && spec.input ? (
        <Label className="grid gap-1 text-sm">
          Input from action
          <Select
            value={action.input?.nodeId || EMPTY}
            onValueChange={(nextValue) =>
              onChange({
                ...action,
                input: { nodeId: nextValue === EMPTY ? '' : nextValue, output: spec.input },
              })
            }
          >
            <SelectTrigger className={automationSelectClass}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={EMPTY}>Choose an output</SelectItem>
              {graph.nodes
                .filter(
                  (candidate) =>
                    candidate.id !== node.id &&
                    candidate.action &&
                    producers.includes(candidate.action.type)
                )
                .map((candidate) => (
                  <SelectItem key={candidate.id} value={candidate.id}>
                    {candidate.id}.{spec.input}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </Label>
      ) : null}
      {action.type === 'create_campaign' ? (
        <>
          <Label className="grid gap-1 text-sm">
            Visual brand kit
            <Select
              value={action.brandKitId || EMPTY}
              onValueChange={(nextValue) =>
                onChange({ ...action, brandKitId: nextValue === EMPTY ? '' : nextValue })
              }
            >
              <SelectTrigger className={automationSelectClass}>
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
          </Label>
          {overview.brands.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Create and publish a brand kit, then return to this tab.{' '}
              <Link
                className="underline"
                href={`/workspace/brand-kit?returnTo=${returnTo}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                Create brand kit (new tab)
              </Link>
            </p>
          ) : null}
          <fieldset className="space-y-2">
            <legend className="text-sm">Draft destinations</legend>
            {overview.destinations.map((destination) => (
              <Label key={destination.id} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={action.destinationIds?.includes(destination.id) ?? false}
                  disabled={
                    !action.destinationIds?.includes(destination.id) &&
                    (action.destinationIds?.length ?? 0) >= 10
                  }
                  onCheckedChange={(checked) =>
                    onChange({
                      ...action,
                      destinationIds:
                        checked === true
                          ? [...(action.destinationIds ?? []), destination.id]
                          : action.destinationIds?.filter((id) => id !== destination.id),
                    })
                  }
                />
                {destination.name}
              </Label>
            ))}
            {overview.destinations.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Connect a destination in{' '}
                <Link
                  className="underline"
                  href={`/workspace/channels?returnTo=${returnTo}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  workspace Channels (new tab)
                </Link>
                , then return to this tab.
              </p>
            ) : null}
          </fieldset>
          <Label className="grid gap-1 text-sm">
            Call to action
            <Input
              value={action.callToAction ?? ''}
              onChange={(event) => onChange({ ...action, callToAction: event.target.value })}
            />
          </Label>
        </>
      ) : null}
      {action.type === 'create_release' ? (
        <Label className="grid gap-1 text-sm">
          Release contents
          <Select
            value={action.include ?? 'event'}
            onValueChange={(nextValue) =>
              onChange({
                ...action,
                include: nextValue === 'unreleased' ? 'unreleased' : undefined,
              })
            }
          >
            <SelectTrigger className={automationSelectClass}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="event">What this event references</SelectItem>
              <SelectItem value="unreleased">
                Plus every merged PR since the last release
              </SelectItem>
            </SelectContent>
          </Select>
          <span className="text-xs leading-5 font-normal text-muted-foreground">
            {action.include === 'unreleased'
              ? 'Bundles every collected merged pull request not yet in a release that merged before this event. Keep the repository collecting unmatched merged PRs.'
              : 'Takes the merged PR itself, PRs the notes or commit message reference, or a milestone’s assigned PRs.'}
          </span>
        </Label>
      ) : null}
      {action.type === 'render_creatives' ? (
        <>
          <fieldset className="space-y-2">
            <legend className="text-sm">Design templates (1–3)</legend>
            {(overview.templates ?? []).map((template) => (
              <Label key={template.id} className="grid gap-2 rounded-lg border p-3 text-sm">
                <DesignTemplatePreview id={template.id} />
                <Checkbox
                  checked={action.templateIds?.includes(template.id) ?? false}
                  disabled={
                    !action.templateIds?.includes(template.id) &&
                    (action.templateIds?.length ?? 0) >= 3
                  }
                  onCheckedChange={(checked) =>
                    onChange({
                      ...action,
                      templateIds:
                        checked === true
                          ? [...(action.templateIds ?? []), template.id]
                          : action.templateIds?.filter((id) => id !== template.id),
                    })
                  }
                />
                {template.name} · {template.aspectRatio.replace('_', ':')}
              </Label>
            ))}
          </fieldset>
          <Label className="grid gap-1 text-sm">
            Product capture
            <Select
              value={action.surfaceId || EMPTY}
              onValueChange={(nextValue) =>
                onChange({ ...action, surfaceId: nextValue === EMPTY ? undefined : nextValue })
              }
            >
              <SelectTrigger className={automationSelectClass}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={EMPTY}>Latest capture of any product page</SelectItem>
                {(overview.surfaces ?? []).map((surface) => (
                  <SelectItem key={surface.id} value={surface.id}>
                    {surface.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Label>
          <p className="text-xs leading-5 text-muted-foreground">
            Creatives are drafts on the campaign. A reviewer approves a design before it can be
            scheduled with a post.
          </p>
        </>
      ) : null}
      {action.type === 'render_code_visual' ? (
        <>
          <Label className="flex items-start gap-2 text-sm font-normal">
            <Checkbox
              checked={action.readSourceCode === true}
              onCheckedChange={(checked) => onChange({ ...action, readSourceCode: checked === true })}
            />
            <span>
              Allow this action to read the merged pull request’s code. Shots reads the diff only
              when this workflow runs, and keeps it only in the Code Studio project it makes.
            </span>
          </Label>
          <p className="text-xs leading-5 text-muted-foreground">
            Runs on the pull request trigger. The image is a draft on the campaign; a reviewer
            approves it before it is posted.
          </p>
        </>
      ) : null}
      {action.type === 'create_canvas' ? (
        <>
          <fieldset className="space-y-2">
            <legend className="text-sm">Canvas templates (1–3)</legend>
            {canvasRecipeSchema.options.map((recipe) => (
              <Label key={recipe} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={action.recipeIds?.includes(recipe) ?? false}
                  disabled={
                    !action.recipeIds?.includes(recipe) && (action.recipeIds?.length ?? 0) >= 3
                  }
                  onCheckedChange={(checked) =>
                    onChange({
                      ...action,
                      recipeIds:
                        checked === true
                          ? [...(action.recipeIds ?? []), recipe]
                          : action.recipeIds?.filter((id) => id !== recipe),
                    })
                  }
                />
                {CANVAS_RECIPES[recipe].name} · {CANVAS_RECIPES[recipe].artboards}
              </Label>
            ))}
          </fieldset>
          <Label className="grid gap-1 text-sm">
            Screenshot when the release has none
            <Select
              value={action.surfaceId || EMPTY}
              onValueChange={(nextValue) =>
                onChange({ ...action, surfaceId: nextValue === EMPTY ? undefined : nextValue })
              }
            >
              <SelectTrigger className={automationSelectClass}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={EMPTY}>Latest capture of any product page</SelectItem>
                {(overview.surfaces ?? []).map((surface) => (
                  <SelectItem key={surface.id} value={surface.id}>
                    {surface.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Label>
          <p className="text-xs leading-5 text-muted-foreground">
            The canvas is a draft in Canvas. Nothing from it is published until someone exports or
            hands it to a campaign.
          </p>
        </>
      ) : null}
      {action.type === 'create_campaign' || action.type === 'create_release' ? (
        <Label className="grid gap-1 text-sm">
          Audience
          <Input
            value={action.audience ?? ''}
            onChange={(event) => onChange({ ...action, audience: event.target.value })}
          />
        </Label>
      ) : null}
      {action.type === 'generate_copy' ? (
        <>
          <Label className="grid gap-1 text-sm">
            AI credit limit
            <Input
              type="number"
              min={1}
              max={500}
              value={action.creditLimit ?? 0}
              onChange={(event) =>
                onChange({ ...action, creditLimit: Math.trunc(Number(event.target.value)) || 0 })
              }
            />
          </Label>
          <p className="text-xs leading-5 text-muted-foreground">
            The run starts only when the workspace has this many credits. It charges what the model
            actually cost, never more than this limit, and never twice for one run.
          </p>
        </>
      ) : null}
      {action.type === 'submit_review' ? (
        <p className="text-sm text-muted-foreground">
          Uses the existing review queue and notifications. This node must connect directly to an
          end node. Approval stays with a person.
        </p>
      ) : null}
      <dl className="grid gap-1 rounded-lg bg-muted/40 p-3 text-xs text-muted-foreground">
        <div>
          <dt className="inline font-medium">Needs: </dt>
          <dd className="inline">{[spec.entitlement, ...spec.integrations].join(' · ')}</dd>
        </div>
        <div>
          <dt className="inline font-medium">Retries: </dt>
          <dd className="inline">{spec.retry}</dd>
        </div>
        <div>
          <dt className="inline font-medium">Configured by: </dt>
          <dd className="inline">{spec.permission}</dd>
        </div>
      </dl>
    </div>
  )
}
