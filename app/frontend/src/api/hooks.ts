import { useQuery } from '@tanstack/react-query'
import { api } from './client'

export function useRuns() {
  return useQuery({ queryKey: ['runs'], queryFn: api.listRuns })
}
