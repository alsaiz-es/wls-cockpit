import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useRef } from 'react'
import type { WlsCredentials } from '../client.ts'
import { useDocumentVisible } from '../query-polling.ts'
import { useAuth } from '../../auth/useAuth.ts'
import {
  fetchServerMetricCaptureSnapshot,
  serverMetricCapturePollInterval,
  serverMetricCapturePollQueryKey,
} from './server-metric-capture-query.ts'
import {
  appendServerMetricCaptureSamples,
  getServerMetricCaptureSession,
  resetServerMetricCaptureScopeOnChange,
  serverMetricCaptureScopeKey,
  useServerMetricCaptureSnapshot,
} from './server-metric-capture-store.ts'
import { projectServerMetricSamples } from './server-metrics.ts'

function ServerMetricCapturePoller({
  creds,
  scopeKey,
  serverName,
  sessionId,
}: {
  creds: WlsCredentials
  scopeKey: string
  serverName: string
  sessionId: string
}) {
  const visible = useDocumentVisible()
  const session = getServerMetricCaptureSession(scopeKey, serverName)
  const interval = serverMetricCapturePollInterval(visible, session)
  const query = useQuery({
    queryKey: serverMetricCapturePollQueryKey(scopeKey, serverName, sessionId),
    enabled: interval !== false,
    staleTime: 0,
    refetchInterval: interval,
    queryFn: async () => {
      const snapshot = await fetchServerMetricCaptureSnapshot(creds, serverName)
      return { snapshot, timestamp: Date.now() }
    },
    refetchIntervalInBackground: session?.pollWhileHidden === true,
  })
  const lastRecordedAt = useRef(0)

  useEffect(() => {
    if (!query.data || query.dataUpdatedAt <= lastRecordedAt.current) return
    lastRecordedAt.current = query.dataUpdatedAt
    if (!query.data.snapshot) return
    const projection = projectServerMetricSamples({
      server: query.data.snapshot.server,
      jdbc: query.data.snapshot.jdbc,
      jms: query.data.snapshot.jms,
    })
    appendServerMetricCaptureSamples(scopeKey, serverName, projection.samples, query.data.timestamp, {
      omitted: projection.omitted,
      resources: projection.resources,
    })
  }, [query.data, query.dataUpdatedAt, scopeKey, serverName])

  return null
}

export function ServerMetricCapturePollerHost() {
  const { creds } = useAuth()
  const scopeKey = serverMetricCaptureScopeKey(creds)
  const previousScopeRef = useRef<string | null>(null)
  const state = useServerMetricCaptureSnapshot()

  useEffect(() => {
    previousScopeRef.current = resetServerMetricCaptureScopeOnChange(previousScopeRef.current, scopeKey)
  }, [scopeKey])

  const activeSessions = useMemo(() => {
    if (!creds || !scopeKey || state.scopeKey !== scopeKey) return []
    return Object.values(state.sessions).filter((session) => session.status === 'active')
  }, [creds, scopeKey, state.scopeKey, state.sessions])

  if (!creds || !scopeKey) return null

  return (
    <>
      {activeSessions.map((session) => (
        <ServerMetricCapturePoller
          key={session.id}
          creds={creds}
          scopeKey={scopeKey}
          serverName={session.serverName}
          sessionId={session.id}
        />
      ))}
    </>
  )
}
