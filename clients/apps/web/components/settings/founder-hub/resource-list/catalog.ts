import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import templates from '../templates/catalog.json'

export function useWebResources(kind: 'templates') {
  return useQuery({
    queryKey: ['founder-hub-catalog', kind],
    queryFn: async () => z.array(z.record(z.string(), z.unknown())).parse(templates),
    staleTime: 300000,
  })
}
