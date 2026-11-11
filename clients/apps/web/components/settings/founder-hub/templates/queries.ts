'use client'

import { useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { toast } from 'sonner'
import {
  founderHubTemplateSchema,
  founderHubTemplateContentSchema,
  founderHubTemplatePageSchema,
  founderHubTemplateUpdateSchema,
} from 'screenshot-studio-backend-sdk'
import { settingsRequest, settingsErrorMessage } from '@/lib/settings/client'
import { useFounderHubUserId } from '../settings-context'
import { DEFAULT_TEMPLATE_ICON } from './template-icon'

export type UserTemplate = z.infer<typeof founderHubTemplateSchema>
export type TemplateSection = z.infer<typeof founderHubTemplateContentSchema>['sections'][number]
export type UserTemplateDraft = Pick<UserTemplate, 'title' | 'description' | 'sections'> &
  Partial<Pick<UserTemplate, 'category' | 'targets' | 'icon'>>

type RetainedDraft = { draft: UserTemplate; baseline: UserTemplate; attempted?: UserTemplate }
const draftsKey = (userId: string) => ['founder-hub-template-drafts', userId]
export function useTemplateDrafts() {
  const userId = useFounderHubUserId()
  return useQuery<Record<string, RetainedDraft>>({
    queryKey: draftsKey(userId),
    initialData: {},
    enabled: false,
    gcTime: Infinity,
  }).data
}
function retainDraft(
  client: ReturnType<typeof useQueryClient>,
  userId: string,
  id: string,
  draft?: RetainedDraft
) {
  client.setQueryDefaults(['founder-hub-template-drafts'], { gcTime: Infinity })
  client.setQueryData<Record<string, RetainedDraft>>(draftsKey(userId), (previous) => {
    const next = { ...previous }
    if (draft) next[id] = draft
    else delete next[id]
    return next
  })
}

export function useTemplatesQuery() {
  const userId = useFounderHubUserId()
  return useQuery({
    queryKey: ['founder-hub-templates', userId],
    queryFn: async ({ signal }) => {
      const items: UserTemplate[] = []
      let cursor = ''
      do {
        const page = await settingsRequest(
          `/api/founder-hub/templates?${new URLSearchParams({ cursor })}`,
          founderHubTemplatePageSchema,
          { signal }
        )
        items.push(...page.items)
        cursor = page.nextCursor
      } while (cursor)
      return items
    },
    refetchInterval: 15_000,
  })
}

export function useUserTemplates() {
  const templates = useTemplatesQuery().data ?? []
  const drafts = useTemplateDrafts()
  return [
    ...templates,
    ...Object.values(drafts)
      .filter(({ draft }) => !templates.some((item) => item.id === draft.id))
      .map(({ draft }) => draft),
  ]
}

function useTemplateMutation() {
  const userId = useFounderHubUserId()
  const client = useQueryClient()
  const queryKey = ['founder-hub-templates', userId]
  return useMutation({
    scope: { id: `founder-hub-templates:${userId}` },
    mutationFn: async ({
      id,
      input,
    }: {
      id: string
      input: z.input<typeof founderHubTemplateUpdateSchema>
    }) =>
      settingsRequest(
        `/api/founder-hub/templates/${encodeURIComponent(id)}`,
        founderHubTemplateSchema,
        { method: 'PATCH', body: input }
      ),
    onSuccess: async (saved) => {
      await client.cancelQueries({ queryKey })
      if (saved.deletedAt) retainDraft(client, userId, saved.id)
      client.setQueryData<UserTemplate[]>(queryKey, (previous) => [
        ...(previous ?? []).filter((item) => item.id !== saved.id),
        ...(!saved.deletedAt ? [saved] : []),
      ])
    },
    onError: async (error) => {
      toast.error(settingsErrorMessage(error))
      await client.invalidateQueries({ queryKey })
    },
  })
}

export function useCreateTemplate() {
  const mutation = useTemplateMutation()
  return async (draft: UserTemplateDraft) => {
    const id = crypto.randomUUID()
    await mutation.mutateAsync({
      id,
      input: {
        baseVersion: 0,
        content: { category: '', targets: [], icon: DEFAULT_TEMPLATE_ICON, ...draft },
      },
    })
    return id
  }
}

function templateContent(template: UserTemplate) {
  return founderHubTemplateContentSchema.parse({
    title: template.title,
    description: template.description,
    category: template.category,
    icon: template.icon,
    targets: template.targets,
    sections: template.sections,
  })
}

export function useSaveTemplate(initialTemplate: UserTemplate) {
  const mutation = useTemplateMutation()
  const client = useQueryClient()
  const userId = useFounderHubUserId()
  const retained = () =>
    client.getQueryData<Record<string, RetainedDraft>>(draftsKey(userId))?.[initialTemplate.id]
  const acknowledged = useRef(retained()?.baseline ?? initialTemplate)
  const attempted = useRef(retained()?.attempted)
  const pending = useRef<Promise<void> | null>(null)
  const latest = useRef<UserTemplate | null>(null)
  return (template: UserTemplate) => {
    retainDraft(client, userId, template.id, {
      draft: template,
      baseline: acknowledged.current,
      attempted: attempted.current,
    })
    latest.current = template
    if (pending.current) return pending.current
    const flush = async () => {
      while (latest.current) {
        const next = latest.current
        latest.current = null
        const current = client
          .getQueryData<UserTemplate[]>(['founder-hub-templates', userId])
          ?.find((item) => item.id === next.id)
        if (
          current &&
          attempted.current &&
          JSON.stringify(templateContent(current)) ===
            JSON.stringify(templateContent(attempted.current))
        ) {
          acknowledged.current = current
          attempted.current = undefined
        }
        if (
          !current ||
          JSON.stringify(templateContent(current)) !==
            JSON.stringify(templateContent(acknowledged.current))
        ) {
          const error = new Error(
            'This template changed elsewhere. Your draft is still here; copy it before reloading to review the other change.'
          )
          toast.error(error.message)
          throw error
        }
        attempted.current = next
        const draftBeforeRequest = retained()?.draft ?? next
        retainDraft(client, userId, next.id, {
          draft: draftBeforeRequest,
          baseline: acknowledged.current,
          attempted: next,
        })
        let saved: UserTemplate
        try {
          saved = await mutation.mutateAsync({
            id: next.id,
            input: { baseVersion: current.version, content: templateContent(next) },
          })
        } catch (error) {
          const readback = client
            .getQueryData<UserTemplate[]>(['founder-hub-templates', userId])
            ?.find((item) => item.id === next.id)
          if (
            !readback ||
            JSON.stringify(templateContent(readback)) !== JSON.stringify(templateContent(next))
          )
            throw error
          saved = readback
        }
        acknowledged.current = saved
        attempted.current = undefined
        const draft = retained()?.draft
        if (
          draft &&
          JSON.stringify(templateContent(draft)) === JSON.stringify(templateContent(saved))
        )
          retainDraft(client, userId, next.id)
        else if (draft) retainDraft(client, userId, next.id, { draft, baseline: saved })
      }
    }
    const save = flush()
    pending.current = save
    void save.then(
      () => {
        pending.current = null
      },
      () => {
        pending.current = null
      }
    )
    return save
  }
}

export function useTemplateInitialValue(template: UserTemplate) {
  return useTemplateDrafts()[template.id]?.draft ?? template
}

export function useRecoverTemplateDraft() {
  const client = useQueryClient()
  const userId = useFounderHubUserId()
  const create = useCreateTemplate()
  return useMutation({
    mutationFn: async ({ id, copy }: { id: string; copy: boolean }) => {
      const saved = client.getQueryData<Record<string, RetainedDraft>>(draftsKey(userId))?.[id]
      if (!saved) throw new Error('This draft is no longer available.')
      const createdId = copy
        ? await create({
            ...templateContent(saved.draft),
            title: getTemplateCopyTitle(saved.draft.title),
          })
        : null
      retainDraft(client, userId, id)
      return createdId
    },
  })
}

export function useDeleteTemplate() {
  const client = useQueryClient()
  const userId = useFounderHubUserId()
  const mutation = useTemplateMutation()
  return async (id: string) => {
    const template = client
      .getQueryData<UserTemplate[]>(['founder-hub-templates', userId])
      ?.find((item) => item.id === id)
    if (!template) throw new Error('Template no longer exists.')
    await mutation.mutateAsync({ id, input: { baseVersion: template.version, deleted: true } })
  }
}

export function useToggleTemplateFavorite() {
  const client = useQueryClient()
  const userId = useFounderHubUserId()
  const mutation = useTemplateMutation()
  return async (id: string) => {
    const template = client
      .getQueryData<UserTemplate[]>(['founder-hub-templates', userId])
      ?.find((item) => item.id === id)
    if (!template) throw new Error('Template no longer exists.')
    await mutation.mutateAsync({
      id,
      input: { baseVersion: template.version, pinned: !template.pinned },
    })
  }
}

export function getTemplateCopyTitle(title: string) {
  const value = title.trim()
  return !value ? 'Untitled (Copy)' : value.endsWith('(Copy)') ? value : `${value} (Copy)`
}
