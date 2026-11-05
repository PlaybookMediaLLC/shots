'use client'

import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { registerNavigationGuard } from '@/lib/platform/navigation-guard'
import { guardWorkflowNavigation } from '@/lib/workflows/navigation-guard'
import { WorkflowArchiveButton } from './WorkflowArchiveButton'
import { TRPCClientError } from '@trpc/client'
import { useQueryClient } from '@tanstack/react-query'
import type { AppRouter } from '@/lib/trpc/router'
import { WarningCircleIcon as AlertCircle } from '@phosphor-icons/react/dist/ssr/WarningCircle'
import { ArrowLeftIcon as ArrowLeft } from '@phosphor-icons/react/dist/ssr/ArrowLeft'
import { CheckIcon as Check } from '@phosphor-icons/react/dist/ssr/Check'
import { CaretRightIcon as ChevronRight } from '@phosphor-icons/react/dist/ssr/CaretRight'
import { CopyIcon as Copy } from '@phosphor-icons/react/dist/ssr/Copy'
import { GitPullRequestIcon as GitPullRequest } from '@phosphor-icons/react/dist/ssr/GitPullRequest'
import { SpinnerGapIcon as Loader2 } from '@phosphor-icons/react/dist/ssr/SpinnerGap'
import { PlayIcon as Play } from '@phosphor-icons/react/dist/ssr/Play'
import { PlusIcon as Plus } from '@phosphor-icons/react/dist/ssr/Plus'
import { ArrowUUpRightIcon as Redo2 } from '@phosphor-icons/react/dist/ssr/ArrowUUpRight'
import { FloppyDiskIcon as Save } from '@phosphor-icons/react/dist/ssr/FloppyDisk'
import { ShieldCheckIcon as ShieldCheck } from '@phosphor-icons/react/dist/ssr/ShieldCheck'
import { TrashIcon as Trash2 } from '@phosphor-icons/react/dist/ssr/Trash'
import { ArrowUUpLeftIcon as Undo2 } from '@phosphor-icons/react/dist/ssr/ArrowUUpLeft'
import { LightningIcon as Zap } from '@phosphor-icons/react/dist/ssr/Lightning'
import { Background, Controls, ReactFlow, type Connection } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type {
  AutomationDefinition,
  AutomationGraph,
  AutomationHistoryItem,
  AutomationLayout,
  AutomationNode,
  AutomationOverview,
  AutomationPreview,
} from '@/lib/api/contracts/release-automation'
import type { AutomationVersion } from '@/lib/api/contracts/workflow-runs'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Label } from '@/components/ui/label'
import {
  Select as UiSelect,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select'
import { Table, TableBody, TableCaption, TableCell, TableHead, TableRow } from '@/components/ui/table'
import { cn } from '@/lib/utils'
import { useTRPC, useTRPCClient } from '@/lib/trpc/react'
import { actionAvailability, graphSchemaVersion, savedGraph } from '@/lib/workflows/actions'
import { releaseExample } from '@/lib/workflows/examples'
import { getErrorMessage } from '@/components/workspace/settings-client'
import { ActionEditor } from './ActionEditor'
import { ClassifyEditor, DEFAULT_CLASSIFY } from './ClassifyEditor'
import { automationSelectClass, ConditionEditor } from './ConditionEditor'
import {
  canvasEdges,
  canvasNodes,
  FAMILY_NAMES,
  nodeLabel,
  workflowNodeTypes,
} from './workflow-canvas'

type Snapshot = { graph: AutomationGraph; layout: AutomationLayout }

const HISTORY_LIMIT = 50

/** The canvas authors a server-validated graph; it never executes actions. */
export function WorkflowEditor({
  definition,
  overview,
  history,
  onSaved,
  onClose,
  readOnly = false,
  initialNode,
  presentation = 'dialog',
}: {
  definition: AutomationDefinition
  overview: AutomationOverview
  history: AutomationHistoryItem[]
  onSaved: (value: AutomationDefinition) => void
  onClose: () => void
  /** Members inspect workflows; only owner/admin sessions edit them. */
  readOnly?: boolean
  initialNode?: string
  presentation?: 'dialog' | 'page'
}) {
  const client = useTRPCClient()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [record, setRecord] = useState(definition)
  const [graph, setGraph] = useState<AutomationGraph>(definition.draft)
  const [layout, setLayout] = useState<AutomationLayout>(definition.layout)
  const [past, setPast] = useState<Snapshot[]>([])
  const [future, setFuture] = useState<Snapshot[]>([])
  const [name, setName] = useState(definition.name)
  const [description, setDescription] = useState(definition.description)
  const [priority, setPriority] = useState(String(definition.priority))
  const [selected, setSelected] = useState(initialNode ?? 'condition')
  const [panel, setPanel] = useState('node')
  const [mobilePanel, setMobilePanel] = useState<'canvas' | 'inspector'>(
    initialNode ? 'inspector' : 'canvas'
  )
  const inspector = useRef<HTMLElement>(null)
  const [confirmClose, setConfirmClose] = useState(false)
  const pendingLeave = useRef<(() => void) | null>(null)
  const [sample, setSample] = useState('example:match')
  const [assumeIrrelevant, setAssumeIrrelevant] = useState(false)
  const [preview, setPreview] = useState<AutomationPreview | null>(null)
  const [versions, setVersions] = useState<AutomationVersion[] | null>(null)
  const [issues, setIssues] = useState(definition.issues)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [conflict, setConflict] = useState(false)
  const [fieldErrors, setFieldErrors] = useState<{ field: string; message: string }[]>([])
  const fieldError = (field: string) => fieldErrors.find((issue) => issue.field === field)?.message
  const [dirty, setDirty] = useState(!definition.id)
  const source = overview.sources.find((item) => item.id === record.sourceAppId)
  const selectedNode = graph.nodes.find((node) => node.id === selected)
  const fields = overview.fields[graph.family]
  const recorded = history.filter(
    (item) =>
      item.event.snapshot.family === graph.family && item.event.sourceAppId === record.sourceAppId
  )
  const capabilityOf = (node: AutomationNode) =>
    node.type === 'classify' ? 'classify' : node.action ? node.action.type : null
  const unavailable = graph.nodes.flatMap((node) => {
    const capability = capabilityOf(node)
    const availability = capability ? actionAvailability(overview, capability) : null
    return availability && !availability.available ? [availability] : []
  })
  const usesAI = graph.nodes.some((node) => node.type === 'classify')

  const priorityError =
    !/^\d+$/.test(priority) || Number(priority) > 9999
      ? 'Priority must be a whole number from 0 to 9999.'
      : null
  const priorityMessage = priorityError ?? fieldError('priority')
  useEffect(() => {
    if (!dirty || readOnly) return
    return guardWorkflowNavigation((leave) => {
      pendingLeave.current = leave
      setConfirmClose(true)
    })
  }, [dirty, readOnly])

  useEffect(() => {
    if (panel !== 'versions' || !record.id || versions) return
    client.releaseAutomation.versions
      .query({ id: record.id })
      .then((result) => setVersions(result.items))
      .catch((failure) => setError(getErrorMessage(failure)))
  }, [client, panel, record.id, versions])

  useEffect(
    () =>
      registerNavigationGuard(() => {
        if (busy) throw new Error('Wait for the workflow operation to finish.')
        if (dirty && !readOnly)
          throw new Error('Save or discard workflow changes before switching workspace.')
      }),
    [busy, dirty, readOnly]
  )

  function closeEditor() {
    if (busy) return
    if (dirty && !readOnly) {
      pendingLeave.current = onClose
      setConfirmClose(true)
    } else onClose()
  }
  function selectNode(id: string) {
    setSelected(id)
    setPanel('node')
    setMobilePanel('inspector')
  }
  function markDirty(note = 'Unsaved draft changes.') {
    setDirty(true)
    setPreview(null)
    setIssues([])
    setMessage(note)
  }
  function remember() {
    setPast((items) => [...items.slice(1 - HISTORY_LIMIT), { graph, layout }])
    setFuture([])
  }
  function changeGraph(next: AutomationGraph, nextLayout: AutomationLayout = layout) {
    if (readOnly) return
    remember()
    setGraph(next)
    setLayout(nextLayout)
    markDirty()
  }
  function travel(
    from: Snapshot[],
    to: Snapshot[],
    setFrom: typeof setPast,
    setTo: typeof setPast
  ) {
    const target = from.at(-1)
    if (!target || readOnly) return
    setFrom(from.slice(0, -1))
    setTo([...to, { graph, layout }])
    setGraph(target.graph)
    setLayout(target.layout)
    markDirty()
  }
  const undo = () => travel(past, future, setPast, setFuture)
  const redo = () => travel(future, past, setFuture, setPast)
  function changeNode(next: AutomationNode) {
    changeGraph({ ...graph, nodes: graph.nodes.map((node) => (node.id === next.id ? next : node)) })
  }
  function connect(from: string, to: string, branch: string) {
    changeGraph({
      ...graph,
      edges: [
        ...graph.edges.filter((edge) => edge.from !== from || edge.branch !== branch),
        ...(to ? [{ from, to, branch }] : []),
      ],
    })
  }
  function drawConnection(connection: Connection) {
    if (connection.source && connection.target)
      connect(connection.source, connection.target, connection.sourceHandle ?? 'next')
  }
  function insertNode(node: AutomationNode, near?: { x: number; y: number }) {
    changeGraph(
      { ...graph, nodes: [...graph.nodes, node] },
      {
        ...layout,
        [node.id]: near
          ? { x: near.x + 40, y: near.y + 60 }
          : { x: 300, y: graph.nodes.length * 50 },
      }
    )
    selectNode(node.id)
  }
  function addNode(type: AutomationNode['type']) {
    insertNode({
      id: `${type === 'classify' ? 'ai' : type}_${crypto.randomUUID().slice(0, 8)}`,
      type,
      ...(type === 'condition'
        ? { condition: { field: 'event.family', operator: 'eq', values: [graph.family] } }
        : {}),
      ...(type === 'classify' ? { classify: { ...DEFAULT_CLASSIFY } } : {}),
      ...(type === 'action' ? { action: { type: 'create_release' as const } } : {}),
      ...(type === 'end' ? { outcome: 'completed' } : {}),
    })
  }
  /** A copy keeps its configuration and drops its connections. */
  function duplicateNode(id: string) {
    const node = graph.nodes.find((candidate) => candidate.id === id)
    if (!node || node.type === 'trigger' || graph.nodes.length >= 64) return
    insertNode(
      { ...structuredClone(node), id: `${node.type}_${crypto.randomUUID().slice(0, 8)}` },
      layout[id]
    )
  }
  function removeNode(id: string) {
    changeGraph({
      ...graph,
      nodes: graph.nodes.filter((node) => node.id !== id),
      edges: graph.edges.filter((edge) => edge.from !== id && edge.to !== id),
    })
    setSelected('')
  }
  function canvasKeys(event: KeyboardEvent) {
    if (readOnly || busy) return
    const mod = event.metaKey || event.ctrlKey
    const key = event.key.toLowerCase()
    if (mod && key === 'z') {
      event.preventDefault()
      if (event.shiftKey) redo()
      else undo()
    } else if (mod && key === 'y') {
      event.preventDefault()
      redo()
    } else if (mod && key === 'd' && selected) {
      event.preventDefault()
      duplicateNode(selected)
    } else if ((event.key === 'Delete' || event.key === 'Backspace') && selectedNode) {
      event.preventDefault()
      removeNode(selectedNode.id)
    }
  }

  async function save(): Promise<AutomationDefinition> {
    if (priorityError) {
      setPanel('workflow')
      setMobilePanel('inspector')
      requestAnimationFrame(() =>
        inspector.current?.querySelector<HTMLInputElement>('[aria-invalid="true"]')?.focus()
      )
      throw new Error(priorityError)
    }
    const saved = await client.releaseAutomation.save.mutate({
      id: record.id,
      sourceAppId: record.sourceAppId,
      name,
      description,
      priority: Number(priority),
      expectedRevision: record.id ? record.revision : 0,
      graph: savedGraph(graph),
      layout,
    })
    setPriority(String(saved.priority))
    setName(saved.name)
    setConflict(false)
    setRecord(saved)
    setGraph(saved.draft)
    setIssues(saved.issues)
    setDirty(false)
    void queryClient.invalidateQueries({ queryKey: trpc.releaseAutomation.overview.queryKey() })
    onSaved(saved)
    setMessage(
      saved.issues.length
        ? 'Draft saved with validation errors. Activation is blocked.'
        : 'Draft saved and validated by the backend.'
    )
    return saved
  }
  async function reloadLatest() {
    const latest = (await client.releaseAutomation.overview.query()).definitions.find(
      (item) => item.id === record.id
    )
    if (!latest) throw new Error('This workflow no longer exists in this workspace.')
    setRecord(latest)
    setGraph(latest.draft)
    setLayout(latest.layout)
    setName(latest.name)
    setDescription(latest.description)
    setPriority(String(latest.priority))
    setIssues(latest.issues)
    setPast([])
    setFuture([])
    setPreview(null)
    setVersions(null)
    setDirty(false)
    setConflict(false)
    setFieldErrors([])
    void queryClient.invalidateQueries({ queryKey: trpc.releaseAutomation.overview.queryKey() })
    onSaved(latest)
    setMessage(`Loaded revision ${latest.revision}.`)
  }
  async function perform(action: () => Promise<void>) {
    setBusy(true)
    setError(null)
    setFieldErrors([])
    try {
      await action()
    } catch (failure) {
      const rpcError =
        failure instanceof TRPCClientError ? (failure as TRPCClientError<AppRouter>) : null
      if (rpcError?.data?.code === 'CONFLICT') {
        setConflict(true)
        setError(
          'This workflow was changed elsewhere. Reload to see the latest version. Your unsaved changes will be discarded when you reload.'
        )
      } else {
        const errors = rpcError?.data?.fieldErrors ?? []
        setFieldErrors(errors)
        if (errors.some((issue) => issue.field === 'priority' || issue.field === 'description')) {
          setPanel('workflow')
          setMobilePanel('inspector')
        }
        setError(
          errors.length
            ? errors.map((issue) => `${issue.field}: ${issue.message}`).join(' ')
            : getErrorMessage(failure)
        )
      }
    } finally {
      setBusy(false)
    }
  }
  async function testDraft() {
    const result = await client.releaseAutomation.preview.mutate(
      sample.startsWith('example:')
        ? {
            sourceAppId: record.sourceAppId,
            graph: savedGraph(graph),
            example: releaseExample(graph.family, source?.repositoryId ?? '1', sample.slice(8)),
            assumeIrrelevant,
          }
        : {
            sourceAppId: record.sourceAppId,
            graph: savedGraph(graph),
            eventId: sample,
            assumeIrrelevant,
          }
    )
    setPreview(result)
    setIssues(result.issues)
    setPanel('test')
  }

  const path = preview?.steps.map((step) => step.nodeId) ?? null
  const nodes = canvasNodes(graph, layout, {
    selected,
    path: new Set(path),
    invalid: new Set(issues.map((issue) => issue.nodeId)),
    sourceName: source?.name,
  })
  const edges = canvasEdges(graph, path)
  const latest = recorded[0]?.event
  const latestFields = latest ? { ...latest.snapshot.fields, ...latest.enrichment } : {}

  return (
    <>
      <WorkflowFrame presentation={presentation} onClose={closeEditor}>
        <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border bg-card px-4 py-3 lg:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <Button
              variant="ghost"
              size="icon"
              type="button"
              aria-label="Close editor"
              disabled={busy}
              onClick={closeEditor}
            >
              <ArrowLeft className="size-4" aria-hidden="true" />
            </Button>
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <h1 id="workflow-heading" className="text-xs font-medium">
                  Workflow editor
                </h1>
                <ChevronRight className="size-3" aria-hidden="true" />
                <span className={record.enabled ? 'text-emerald-600 dark:text-emerald-400' : ''}>
                  {record.enabled ? 'Active version' : 'Draft'}
                </span>
                {readOnly ? <span>· Read only</span> : null}
                {dirty && !readOnly ? (
                  <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-400">
                    Unsaved
                  </span>
                ) : null}
              </div>
              <Input
                aria-label="Definition name"
                aria-invalid={Boolean(fieldError('name'))}
                aria-describedby={fieldError('name') ? 'workflow-name-error' : undefined}
                disabled={busy || readOnly}
                className="-ml-2 mt-1 h-8 w-[min(26rem,65vw)] border-transparent bg-transparent px-2 text-base font-semibold shadow-none hover:border-border md:text-base"
                value={name}
                onChange={(event) => {
                  setName(event.target.value)
                  setDirty(true)
                  setMessage('')
                }}
              />
              {fieldError('name') ? (
                <p id="workflow-name-error" className="text-xs text-destructive">
                  {fieldError('name')}
                </p>
              ) : null}
              <p id="workflow-description" className="sr-only">
                Build a workflow on the canvas. Configure nodes in the side panel, test a path, then
                activate a saved version.
              </p>
            </div>
          </div>
          {readOnly ? null : (
            <div className="flex flex-wrap items-center gap-2">
              {record.id ? (
                <WorkflowArchiveButton definition={record} disabled={busy} onChanged={onClose} />
              ) : null}
              <Button
                disabled={busy}
                type="button"
                variant="outline"
                onClick={() =>
                  void perform(async () => {
                    await save()
                  })
                }
              >
                <Save className="size-3.5" aria-hidden="true" /> Save draft
              </Button>
              <Button
                disabled={busy}
                type="button"
                variant="outline"
                onClick={() => {
                  setPanel('test')
                  setMobilePanel('inspector')
                  void perform(testDraft)
                }}
              >
                <Play className="size-3.5" aria-hidden="true" /> Test draft
              </Button>
              <Button
                disabled={
                  busy ||
                  !!priorityError ||
                  (!dirty && issues.length > 0) ||
                  !overview.executorAvailable ||
                  unavailable.length > 0
                }
                title={unavailable[0]?.reason}
                type="button"
                onClick={() =>
                  void perform(async () => {
                    const saved = dirty ? await save() : record
                    const active = await client.releaseAutomation.activate.mutate({
                      id: saved.id,
                      revision: saved.revision,
                    })
                    setRecord(active)
                    setVersions(null)
                    void queryClient.invalidateQueries({
                      queryKey: trpc.releaseAutomation.overview.queryKey(),
                    })
                    onSaved(active)
                    setMessage(
                      'Version activated for future events. Previously accepted events retain their versions.'
                    )
                  })
                }
              >
                <Zap className="size-3.5" aria-hidden="true" /> Activate version
              </Button>
            </div>
          )}
        </header>
        <div aria-label="Workflow view" className="flex shrink-0 gap-2 border-b p-2 lg:hidden">
          <Button
            variant={mobilePanel === 'canvas' ? 'secondary' : 'ghost'}
            aria-pressed={mobilePanel === 'canvas'}
            onClick={() => setMobilePanel('canvas')}
          >
            Canvas
          </Button>
          <Button
            variant={mobilePanel === 'inspector' ? 'secondary' : 'ghost'}
            aria-pressed={mobilePanel === 'inspector'}
            onClick={() => setMobilePanel('inspector')}
          >
            Inspector
          </Button>
        </div>
        <div className="grid min-h-0 flex-1 grid-rows-1 lg:grid-cols-[minmax(0,1fr)_360px] xl:grid-cols-[minmax(0,1fr)_380px]">
          <section
            className={cn(
              'relative min-h-0 min-w-0 flex-col bg-muted/20 lg:flex',
              mobilePanel === 'canvas' ? 'flex' : 'hidden'
            )}
            aria-label="Workflow canvas"
            onKeyDown={canvasKeys}
          >
            <div className="z-10 flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border bg-card/80 px-4 py-2.5">
              <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                <GitPullRequest className="size-3.5 shrink-0" aria-hidden="true" />
                <span className="truncate">{source?.name}</span>
              </span>
              {readOnly ? null : (
                <div aria-label="Node palette" className="flex flex-wrap gap-1">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2"
                    aria-label="Undo"
                    title="Undo (⌘Z)"
                    disabled={busy || past.length === 0}
                    onClick={undo}
                  >
                    <Undo2 className="size-3.5" aria-hidden="true" />
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2"
                    aria-label="Redo"
                    title="Redo (⇧⌘Z)"
                    disabled={busy || future.length === 0}
                    onClick={redo}
                  >
                    <Redo2 className="size-3.5" aria-hidden="true" />
                  </Button>
                  {(['trigger', 'condition', 'classify', 'action', 'end'] as const).map((type) => (
                    <Button
                      key={type}
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-7 gap-1 px-2 text-xs"
                      disabled={
                        busy ||
                        graph.nodes.length >= 64 ||
                        (type === 'trigger' && graph.nodes.some((node) => node.type === 'trigger'))
                      }
                      onClick={() => addNode(type)}
                    >
                      <Plus className="size-3" aria-hidden="true" /> Add{' '}
                      {type === 'classify' ? 'AI check' : type}
                    </Button>
                  ))}
                </div>
              )}
            </div>
            <div className="min-h-0 flex-1">
              <ReactFlow
                nodes={nodes}
                edges={edges}
                nodeTypes={workflowNodeTypes}
                onConnect={drawConnection}
                fitView
                fitViewOptions={{ padding: 0.15 }}
                minZoom={0.15}
                maxZoom={1.5}
                nodesDraggable={!busy && !readOnly}
                nodesConnectable={!busy && !readOnly}
                deleteKeyCode={null}
                onNodeClick={(_, node) => selectNode(node.id)}
                onNodeDragStart={remember}
                onNodesChange={(changes) => {
                  const positions = { ...layout }
                  let moved = false
                  for (const change of changes) {
                    if (change.type === 'position' && change.position && !readOnly) {
                      positions[change.id] = change.position
                      moved = true
                    }
                    if (change.type === 'select' && change.selected) selectNode(change.id)
                  }
                  if (moved) {
                    setLayout(positions)
                    setDirty(true)
                    setMessage('')
                  }
                }}
                className="[--xy-controls-button-background-color:var(--card)] [--xy-controls-button-background-color-hover:var(--muted)] [--xy-controls-button-color:var(--foreground)] [--xy-controls-button-border-color:var(--border)]"
              >
                <Background gap={20} size={1} color="var(--border)" />
                <Controls
                  showInteractive={false}
                  className="!overflow-hidden !rounded-lg !border !border-border !shadow-sm"
                />
              </ReactFlow>
            </div>
            <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border bg-card/70 px-4 py-2 text-[11px] text-muted-foreground">
              <span>
                {graph.nodes.length} nodes · {graph.edges.length} connections
              </span>
              <span>
                {preview
                  ? 'Preview path highlighted'
                  : readOnly
                    ? 'Select a node to inspect it'
                    : 'Drag to connect · ⌘Z undo · ⌘D duplicate · Delete removes'}
              </span>
            </div>
          </section>
          <aside
            aria-label="Workflow inspector"
            ref={inspector}
            tabIndex={-1}
            className={cn(
              'min-h-0 flex-col border-t border-border bg-card lg:flex lg:border-t-0 lg:border-s',
              mobilePanel === 'inspector' ? 'flex' : 'hidden'
            )}
          >
            <Tabs value={panel} onValueChange={setPanel} className="min-h-0 flex-1 gap-0">
              <TabsList
                aria-label="Workflow inspector panels"
                className="mx-4 my-3 grid w-auto shrink-0 grid-cols-4"
              >
                <TabsTrigger value="node">Node</TabsTrigger>
                <TabsTrigger value="workflow">Workflow</TabsTrigger>
                <TabsTrigger value="test" disabled={readOnly}>
                  Test {preview ? <span className="size-1.5 rounded-full bg-emerald-500" /> : null}
                </TabsTrigger>
                <TabsTrigger value="versions" disabled={!record.id}>
                  Versions
                </TabsTrigger>
              </TabsList>
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-5">
                <fieldset disabled={busy || readOnly} className="min-w-0">
                  <TabsContent value="node" className="space-y-5">
                    <div>
                      <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                        Step configuration
                      </p>
                      <h3 className="mt-1 text-lg font-semibold">
                        {selectedNode ? nodeLabel(selectedNode, graph.family) : 'Select a node'}
                      </h3>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">
                        Changes stay in your draft until you activate a version.
                      </p>
                    </div>
                    <Label className="grid gap-1 text-sm">
                      Configure node
                      <UiSelect
                        value={String(selected) || '__empty_option__'}
                        onValueChange={(nextValue) =>
                          selectNode(nextValue === '__empty_option__' ? '' : nextValue)
                        }
                      >
                        <SelectTrigger className={automationSelectClass}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={'__empty_option__'}>Select a node</SelectItem>
                          {graph.nodes.map((node) => (
                            <SelectItem key={node.id} value={node.id}>
                              {nodeLabel(node, graph.family)} · {node.id}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </UiSelect>
                    </Label>
                    {selectedNode ? (
                      <div className="space-y-5">
                        {selectedNode.type === 'condition' ? (
                          <ConditionEditor
                            label="Node condition"
                            fields={fields}
                            value={
                              selectedNode.condition ?? {
                                field: 'event.family',
                                operator: 'exists',
                              }
                            }
                            onChange={(condition) => changeNode({ ...selectedNode, condition })}
                          />
                        ) : null}
                        {selectedNode.type === 'classify' ? (
                          <ClassifyEditor
                            node={selectedNode}
                            overview={overview}
                            onChange={(classify) => changeNode({ ...selectedNode, classify })}
                          />
                        ) : null}
                        {selectedNode.type === 'action' ? (
                          <ActionEditor
                            node={selectedNode}
                            graph={graph}
                            overview={overview}
                            sourceAppId={record.sourceAppId}
                            onChange={(action) => changeNode({ ...selectedNode, action })}
                          />
                        ) : null}
                        {selectedNode.type === 'trigger' ? (
                          <div className="space-y-3">
                            <p className="text-sm">
                              This trigger is bound to {FAMILY_NAMES[graph.family]}. A different
                              event family needs another definition.
                            </p>
                            <Table
                              aria-label="Event fields"
                              className="w-full caption-top text-left text-xs"
                            >
                              <TableCaption className="mt-0 mb-2 text-left text-xs text-muted-foreground">
                                Fields conditions can test.{' '}
                                {latest
                                  ? `Values from the latest recorded event, “${latest.snapshot.title}”.`
                                  : 'No event has been recorded for this repository yet.'}
                              </TableCaption>
                              <TableBody>
                                {Object.entries(fields).map(([field, kind]) => {
                                  const value = latestFields[field]
                                  return (
                                    <TableRow key={field} className="border-t border-border">
                                      <TableHead
                                        scope="row"
                                        className="py-1 pr-2 font-mono font-normal"
                                      >
                                        {field}
                                      </TableHead>
                                      <TableCell className="py-1 pr-2 text-muted-foreground">
                                        {kind}
                                      </TableCell>
                                      <TableCell className="max-w-32 truncate py-1 text-muted-foreground">
                                        {!value
                                          ? '—'
                                          : value.state !== 'available'
                                            ? value.state
                                            : value.boolean !== undefined
                                              ? String(value.boolean)
                                              : (value.values ?? []).join(', ') || '(empty)'}
                                      </TableCell>
                                    </TableRow>
                                  )
                                })}
                              </TableBody>
                            </Table>
                          </div>
                        ) : null}
                        {selectedNode.type === 'end' ? (
                          <Label className="grid gap-1 text-sm">
                            Outcome
                            <UiSelect
                              value={selectedNode.outcome ?? ''}
                              onValueChange={(nextValue) =>
                                changeNode({ ...selectedNode, outcome: nextValue })
                              }
                            >
                              <SelectTrigger className={automationSelectClass}>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="completed">Completed</SelectItem>
                                <SelectItem value="skipped">Intentionally skipped</SelectItem>
                              </SelectContent>
                            </UiSelect>
                          </Label>
                        ) : null}
                        {(selectedNode.type === 'condition' || selectedNode.type === 'classify'
                          ? ['true', 'false']
                          : selectedNode.type === 'end'
                            ? []
                            : ['next']
                        ).map((branch) => (
                          <Label key={branch} className="grid gap-1 text-sm">
                            {branch.charAt(0).toUpperCase() + branch.slice(1)} connection
                            <UiSelect
                              value={
                                String(
                                  graph.edges.find(
                                    (edge) =>
                                      edge.from === selectedNode.id && edge.branch === branch
                                  )?.to ?? ''
                                ) || '__empty_option__'
                              }
                              onValueChange={(nextValue) =>
                                connect(
                                  selectedNode.id,
                                  nextValue === '__empty_option__' ? '' : nextValue,
                                  branch
                                )
                              }
                            >
                              <SelectTrigger
                                aria-label={`${selectedNode.id} ${branch.charAt(0).toUpperCase() + branch.slice(1)} connection`}
                                className={automationSelectClass}
                              >
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value={'__empty_option__'}>Unconnected</SelectItem>
                                {graph.nodes
                                  .filter(
                                    (node) => node.id !== selectedNode.id && node.type !== 'trigger'
                                  )
                                  .map((node) => (
                                    <SelectItem key={node.id} value={node.id}>
                                      {nodeLabel(node, graph.family)} · {node.id}
                                    </SelectItem>
                                  ))}
                              </SelectContent>
                            </UiSelect>
                          </Label>
                        ))}
                        {readOnly ? null : (
                          <div className="flex flex-wrap gap-2">
                            {selectedNode.type !== 'trigger' ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                type="button"
                                onClick={() => duplicateNode(selectedNode.id)}
                              >
                                <Copy className="size-3.5" aria-hidden="true" /> Duplicate{' '}
                                {selectedNode.id}
                              </Button>
                            ) : null}
                            <Button
                              variant="ghost"
                              size="sm"
                              type="button"
                              onClick={() => removeNode(selectedNode.id)}
                            >
                              <Trash2 className="size-3.5" aria-hidden="true" /> Remove{' '}
                              {selectedNode.id}
                            </Button>
                          </div>
                        )}
                      </div>
                    ) : null}

                    {!selectedNode ? (
                      <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
                        Choose a node on the canvas or add a step to get started.
                      </p>
                    ) : null}
                  </TabsContent>
                  <TabsContent value="workflow" className="space-y-5">
                    <div>
                      <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                        Workflow settings
                      </p>
                      <h3 className="mt-1 text-lg font-semibold">When should this run?</h3>
                    </div>
                    <div className="rounded-lg border border-border bg-muted/20 p-3">
                      <p className="text-xs text-muted-foreground">GitHub event</p>
                      <p className="mt-1 text-ui-lg font-medium">{FAMILY_NAMES[graph.family]}</p>
                      <p className="mt-1 break-words text-xs text-muted-foreground">
                        {source?.name}
                        {source?.branch ? ` · watching ${source.branch}` : ''}
                      </p>
                    </div>
                    <Label className="grid gap-1.5 text-sm">
                      Description
                      <Input
                        aria-invalid={Boolean(fieldError('description'))}
                        aria-describedby={
                          fieldError('description') ? 'workflow-description-error' : undefined
                        }
                        value={description}
                        placeholder="Describe what this workflow does"
                        onChange={(event) => {
                          setDescription(event.target.value)
                          setDirty(true)
                          setMessage('')
                        }}
                      />
                      {fieldError('description') ? (
                        <span id="workflow-description-error" className="text-xs text-destructive">
                          {fieldError('description')}
                        </span>
                      ) : null}
                    </Label>
                    <Label className="grid gap-1.5 text-sm">
                      Priority
                      <Input
                        type="text"
                        inputMode="numeric"
                        aria-invalid={!!priorityMessage}
                        aria-describedby={priorityMessage ? 'workflow-priority-error' : undefined}
                        value={priority}
                        onChange={(event) => {
                          setPriority(event.target.value)
                          setDirty(true)
                          setMessage('')
                        }}
                      />
                    </Label>
                    {priorityMessage ? (
                      <p
                        id="workflow-priority-error"
                        role="alert"
                        className="text-sm text-destructive"
                      >
                        {priorityMessage}
                      </p>
                    ) : null}
                    <p className="text-xs leading-5 text-muted-foreground">
                      Lower numbers run first for this repository and event. Ties use the definition
                      ID. The first matching workflow wins.
                    </p>
                    <ConditionEditor
                      label="Qualification"
                      value={graph.qualification}
                      fields={fields}
                      onChange={(qualification) => changeGraph({ ...graph, qualification })}
                    />
                    <div className="flex gap-2 rounded-lg bg-muted/40 p-3 text-xs leading-5 text-muted-foreground">
                      <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                      <p>
                        Drafts use recorded source text, and AI copy treats it as evidence only. A
                        person must approve and schedule content after review.
                      </p>
                    </div>
                    <p className="text-xs leading-5 text-muted-foreground">
                      Draft revision {record.revision || 'new'} · language v
                      {graphSchemaVersion(graph)}
                      {record.updatedAt
                        ? ` · Saved ${new Date(record.updatedAt).toLocaleString()}`
                        : ''}
                    </p>
                    {record.enabled && !readOnly ? (
                      <Button
                        disabled={busy}
                        variant="outline"
                        type="button"
                        onClick={() =>
                          void perform(async () => {
                            await client.releaseAutomation.disable.mutate({
                              id: record.id,
                              revision: record.revision,
                            })
                            const disabled = {
                              ...record,
                              enabled: false,
                              revision: record.revision + 1,
                            }
                            setRecord(disabled)
                            void queryClient.invalidateQueries({
                              queryKey: trpc.releaseAutomation.overview.queryKey(),
                            })
                            onSaved(disabled)
                            setMessage(
                              'Disabled. Cancellation requested; source stays in automation mode and history is kept.'
                            )
                          })
                        }
                      >
                        Deactivate
                      </Button>
                    ) : null}
                  </TabsContent>
                  <TabsContent value="test" className="space-y-5">
                    <div>
                      <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                        Dry run
                      </p>
                      <h3 className="mt-1 text-lg font-semibold">Follow the evidence</h3>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">
                        See which path an event takes. Testing creates no releases, notifications,
                        or posts, and never calls a model.
                      </p>
                    </div>
                    <Label className="grid gap-1 text-sm">
                      Test evidence
                      <UiSelect
                        value={sample}
                        onValueChange={(nextValue) => {
                          setSample(nextValue)
                          setPreview(null)
                        }}
                      >
                        <SelectTrigger className={automationSelectClass}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="example:match">Example: matching event</SelectItem>
                          <SelectItem value="example:else">
                            Example: else / no-match event
                          </SelectItem>
                          {graph.family === 'pull_request.merged' ? (
                            <SelectItem value="example:pending">
                              Example: file enrichment pending
                            </SelectItem>
                          ) : null}
                          {recorded.map((item) => (
                            <SelectItem key={item.event.id} value={item.event.id}>
                              Recorded: {item.event.snapshot.title} ·{' '}
                              {new Date(item.event.receivedAt).toLocaleString()}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </UiSelect>
                    </Label>

                    <p className="text-xs text-muted-foreground">
                      {recorded.length
                        ? `${recorded.length} recent recorded events are available in Test evidence, alongside the examples.`
                        : 'No matching events have been recorded for this repository yet. Use an example until an event arrives.'}
                    </p>

                    {usesAI ? (
                      <Label className="grid gap-1 text-sm">
                        AI checks in this preview
                        <UiSelect
                          value={assumeIrrelevant ? 'irrelevant' : 'relevant'}

                          onValueChange={(nextValue) => {
                            setAssumeIrrelevant(nextValue === 'irrelevant')

                            setPreview(null)
                          }}
                        >
                          <SelectTrigger className={automationSelectClass}>
                            <SelectValue />
                          </SelectTrigger>

                          <SelectContent>
                            <SelectItem value="relevant">Assume worth marketing</SelectItem>

                            <SelectItem value="irrelevant">Assume not worth marketing</SelectItem>
                          </SelectContent>
                        </UiSelect>
                        <span className="text-xs font-normal text-muted-foreground">
                          Previews never call the model; runs record its real verdict.
                        </span>
                      </Label>
                    ) : null}

                    {preview ? (
                      <div className="space-y-4" aria-live="polite">
                        <div
                          className={cn(
                            'rounded-lg border p-3',
                            ['completed', 'skipped'].includes(preview.outcome)
                              ? 'border-emerald-500/25 bg-emerald-500/5'
                              : 'border-amber-500/30 bg-amber-500/5'
                          )}
                        >
                          <h3 className="flex items-center gap-2 text-ui-lg font-semibold">
                            {['completed', 'skipped'].includes(preview.outcome) ? (
                              <Check className="size-4" aria-hidden="true" />
                            ) : (
                              <AlertCircle className="size-4" aria-hidden="true" />
                            )}
                            Preview: {preview.outcome}
                          </h3>
                          <p className="mt-1 text-xs leading-5 text-muted-foreground">
                            {preview.evidence}
                          </p>
                          <p className="mt-2 text-xs">
                            Qualification: {preview.qualification.status}{' '}
                            {preview.qualification.reason}
                          </p>
                        </div>
                        <ol className="space-y-1">
                          {preview.steps.map((step, index) => (
                            <li key={step.nodeId}>
                              <Button
                                variant="custom"
                                size={null}
                                type="button"
                                onClick={() => selectNode(step.nodeId)}
                                className="group flex w-full items-start gap-3 rounded-lg px-2 py-2.5 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
                              >
                                <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-border font-mono text-[10px] text-muted-foreground">
                                  {String(index + 1).padStart(2, '0')}
                                </span>
                                <span className="min-w-0 flex-1">
                                  <span className="block text-xs font-medium">
                                    {nodes.find((node) => node.id === step.nodeId)?.data.label ??
                                      step.nodeId}
                                  </span>
                                  <span className="mt-1 block text-[11px] leading-4 text-muted-foreground">
                                    {step.decision
                                      ? `${step.decision.status !== 'evaluated' && step.decision.status !== 'assumed' ? 'No branch' : step.decision.match ? 'True' : 'False'}${step.decision.status === 'assumed' ? ' (assumed)' : ''} · ${step.decision.reason}`
                                      : (step.outcome ??
                                        (step.type === 'trigger'
                                          ? 'Event received'
                                          : 'Expected action'))}
                                  </span>
                                </span>
                                <ChevronRight
                                  className="mt-1 size-3.5 shrink-0 text-muted-foreground"
                                  aria-hidden="true"
                                />
                              </Button>
                            </li>
                          ))}
                        </ol>
                        <p className="text-xs leading-5 text-muted-foreground">
                          Output references resolve during execution. This preview does not create
                          output IDs.
                        </p>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => setPreview(null)}
                        >
                          Clear preview
                        </Button>
                      </div>
                    ) : (
                      <div className="rounded-lg border border-dashed border-border px-5 py-8 text-center">
                        <Play className="mx-auto size-6 text-muted-foreground" aria-hidden="true" />
                        <p className="mt-3 text-ui-lg font-medium">Ready for a test run</p>
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">
                          Choose evidence, then select Test draft above. The result will highlight a
                          path on the canvas.
                        </p>
                      </div>
                    )}
                  </TabsContent>
                </fieldset>
                <TabsContent value="versions" className="space-y-4">
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                      Activated versions
                    </p>
                    <h3 className="mt-1 text-lg font-semibold">Immutable history</h3>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      Each run keeps the version it was accepted with. Editing the draft never
                      changes a version or a run in flight.
                    </p>
                  </div>
                  {versions === null ? (
                    <p role="status" className="text-sm text-muted-foreground">
                      Loading versions…
                    </p>
                  ) : versions.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      Not activated yet. Activate a saved draft to create version 1.
                    </p>
                  ) : (
                    <ol aria-label="Versions" className="space-y-2">
                      {versions.map((version) => (
                        <li
                          key={version.id}
                          className="space-y-1 rounded-lg border border-border p-3 text-sm"
                        >
                          <p className="flex items-center justify-between gap-2 font-medium">
                            Revision {version.revision}
                            {version.id === record.activeVersionId ? (
                              <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-700 dark:text-emerald-300">
                                {record.enabled ? 'Active' : 'Last active'}
                              </span>
                            ) : null}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {version.createdAt
                              ? `Activated ${new Date(version.createdAt).toLocaleString()}`
                              : ''}{' '}
                            · v{version.graph.schemaVersion} · {version.graph.nodes.length} nodes
                          </p>
                          <div className="flex flex-wrap gap-3 text-xs">
                            <Link
                              className="underline"
                              href={`/workflows/runs?versionId=${encodeURIComponent(version.id)}`}
                            >
                              Runs on revision {version.revision}
                            </Link>
                            {readOnly ? null : (
                              <Button
                                variant="custom"
                                size={null}
                                type="button"
                                className="underline"
                                onClick={() => changeGraph(structuredClone(version.graph))}
                              >
                                Load revision {version.revision} into draft
                              </Button>
                            )}
                          </div>
                        </li>
                      ))}
                    </ol>
                  )}
                </TabsContent>
                <div className="mt-5">
                  <div
                    aria-label="Workflow validation"
                    className="space-y-2 rounded-lg border border-border bg-muted/20 p-3"
                    aria-live="polite"
                  >
                    <h3 className="font-medium">Validation</h3>
                    {issues.length ? (
                      <ul className="space-y-1">
                        {issues.map((issue, index) => (
                          <li key={`${issue.code}-${index}`}>
                            <Button
                              variant="custom"
                              size={null}
                              type="button"
                              className="text-left text-sm text-destructive underline"
                              onClick={() => {
                                if (issue.nodeId) selectNode(issue.nodeId)
                                else setPanel('workflow')
                                setMobilePanel('inspector')
                                requestAnimationFrame(() => inspector.current?.focus())
                              }}
                            >
                              {issue.nodeId ? `${issue.nodeId}: ` : ''}
                              {issue.message}
                            </Button>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        {dirty
                          ? 'Save or test this draft for current server validation.'
                          : 'The saved graph is valid.'}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            </Tabs>
          </aside>
        </div>
        <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border bg-card px-5 py-2.5 text-xs">
          <div className="flex min-w-0 items-center gap-2">
            {busy ? (
              <Loader2
                className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : (
              <span
                className={cn(
                  'size-1.5 shrink-0 rounded-full',
                  dirty ? 'bg-amber-500' : 'bg-emerald-500'
                )}
              />
            )}
            <p role="status">
              {message || (dirty ? 'Unsaved draft changes.' : 'All changes saved.')}
            </p>
          </div>
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <ShieldCheck className="size-3.5" aria-hidden="true" />
            Human approval before publishing
          </span>
          {!overview.executorAvailable ? (
            <p className="w-full text-amber-600 dark:text-amber-400">
              No compatible executor is available. You can save and test; activation is unavailable.
            </p>
          ) : unavailable.length && !readOnly ? (
            <p className="w-full text-amber-600 dark:text-amber-400">
              Activation is blocked: {unavailable[0]?.reason}
            </p>
          ) : null}
          {!dirty && issues.length ? (
            <p className="w-full text-amber-600 dark:text-amber-400">
              Activation is blocked: {issues[0]?.message}. Select the validation issue to fix it.
            </p>
          ) : null}
          {conflict ? (
            <Button
              disabled={busy}
              size="sm"
              variant="outline"
              onClick={() => void perform(reloadLatest)}
            >
              Reload
            </Button>
          ) : null}
          {error ? (
            <p role="alert" className="w-full text-destructive">
              {error}
            </p>
          ) : null}
        </footer>
      </WorkflowFrame>
      <AlertDialog open={confirmClose} onOpenChange={setConfirmClose}>
        <AlertDialogContent>
          <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
          <AlertDialogDescription>
            Your latest edits have not been saved. Keep editing to save them, or close and discard
            these changes.
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setDirty(false)
                ;(pendingLeave.current ?? onClose)()
              }}
            >
              Discard changes
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

/** Durable definitions stay inside the shell; short template edits may still use a dialog. */
function WorkflowFrame({
  presentation,
  onClose,
  children,
}: {
  presentation: 'dialog' | 'page'
  onClose: () => void
  children: ReactNode
}) {
  if (presentation === 'page')
    return (
      <main
        aria-labelledby="workflow-heading"
        className="flex h-[calc(100dvh-3.5rem)] min-h-[600px] min-w-0 flex-col overflow-hidden md:h-[calc(100dvh-1rem)]"
      >
        {children}
      </main>
    )
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent
        aria-labelledby="workflow-heading"
        aria-describedby="workflow-description"
        showCloseButton={false}
        className="top-0 left-0 flex h-[100dvh] w-full max-w-full translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none p-0 sm:max-w-full"
        onInteractOutside={(event) => event.preventDefault()}
      >
        {children}
      </DialogContent>
    </Dialog>
  )
}
