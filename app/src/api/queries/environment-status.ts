import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { type WlsCredentials, type WlsVersion } from '@/api/client'
import { useRefreshStaleQueryOnVisibleReturn, useVisiblePollingInterval } from '@/api/query-polling'
import { useAuth } from '@/auth/useAuth'
import { type StatusTone } from '@/components'
import { fetchServerLifecycleHeartbeat, serverLifecycleHeartbeatQueryKey } from './server-runtimes'

function readTargetUrl(creds: WlsCredentials | null) {
  const targetUrl = creds?.targetUrl
  return typeof targetUrl === 'string' && targetUrl.trim().length > 0 ? targetUrl : null
}

function parseTarget(creds: WlsCredentials | null) {
  const raw = readTargetUrl(creds)
  if (!raw) return { host: 'localhost', port: 7001 }

  try {
    const url = new URL(raw)
    return {
      host: url.hostname || 'localhost',
      port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
    }
  } catch {
    return { host: 'localhost', port: 7001 }
  }
}

function isDevDashboardFixtureRoute() {
  if (!import.meta.env.DEV) return false
  if (typeof window === 'undefined') return false
  const fixture = new URLSearchParams(window.location.search).get('fixture')
  return window.location.pathname === '/dashboard' && ['healthy', 'warning', 'critical', 'partial'].includes(fixture ?? '')
}

export function useEnvironmentStatus(): {
  tone: Extract<StatusTone, 'positive' | 'warning' | 'negative'>
  host: string
  port: number
  version: WlsVersion
} {
  const { creds } = useAuth()
  const target = useMemo(() => parseTarget(creds), [creds])
  const disableLiveStatus = isDevDashboardFixtureRoute()
  const heartbeatPollingInterval = useVisiblePollingInterval(30_000)

  const query = useQuery({
    queryKey: serverLifecycleHeartbeatQueryKey(creds),
    enabled: !!creds && !disableLiveStatus,
    staleTime: 0,
    refetchInterval: heartbeatPollingInterval,
    queryFn: async () => {
      if (!creds) throw new Error('not authenticated')
      return fetchServerLifecycleHeartbeat(creds)
    },
  })

  useRefreshStaleQueryOnVisibleReturn({
    enabled: !!creds && !disableLiveStatus,
    isFetching: query.isFetching,
    isStale: query.isStale,
    refetch: query.refetch,
  })

  const tone =
    query.isError ? 'negative' : query.isFetching && !query.data ? 'warning' : 'positive'

  return {
    tone,
    host: target.host,
    port: target.port,
    version: creds?.version ?? '14.1.2.0.0',
  }
}
