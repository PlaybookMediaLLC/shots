import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { founderHubShareWorkspaceSchema } from 'screenshot-studio-backend-sdk'
import { settingsRequest } from '@/lib/settings/client'
import { useFounderHubUserId } from '../settings-context'
import { listSharedResources, type SharedResourceType } from './client'

export function sharedResourcesQueryKey(
  userId: string | null | undefined,
  resourceType: SharedResourceType
) {
  return ['shared-resources', userId ?? '', resourceType] as const
}
export function useSharedResources(resourceType: SharedResourceType) {
  const userId = useFounderHubUserId()
  return useQuery({
    queryKey: sharedResourcesQueryKey(userId, resourceType),
    retry: false,
    queryFn: () => listSharedResources(resourceType),
  })
}
export function useAvailableShareWorkspaces(userId: string) {
  return useQuery({
    queryKey: ['founder-hub-share-workspaces', userId],
    retry: false,
    queryFn: ({ signal }) =>
      settingsRequest(
        '/api/founder-hub/resources/workspaces',
        z.array(founderHubShareWorkspaceSchema),
        { signal }
      ),
  })
}
