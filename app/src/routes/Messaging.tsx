import { useMemo } from 'react'
import {
  safEndpointFailing,
  useMessagingInfrastructure,
  type MessagingBridgeRow,
  type MessagingSeverity,
  type PersistentStoreRow,
  type SafAgentRow,
} from '@/api/queries/messaging-infrastructure'
import {
  DataTable,
  MonoText,
  PageHeader,
  StatusBadge,
  type DataTableColumn,
  type StatusTone,
} from '@/components'
import { Button } from '@/components/ui/button'

function severityTone(severity: MessagingSeverity): StatusTone {
  if (severity === 'critical') return 'negative'
  if (severity === 'warning') return 'warning'
  if (severity === 'healthy') return 'positive'
  return 'unknown'
}

function count(value: number | null) {
  return value === null ? '–' : value.toLocaleString()
}

function SectionTitle({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="mb-2 mt-5 flex items-baseline gap-2 first:mt-0">
      <h2 className="text-[13px] font-medium leading-[18px]">{title}</h2>
      <span className="text-muted-foreground text-[12px]">{detail}</span>
    </div>
  )
}

function ServerAndName({ serverName, name }: { serverName: string; name: string }) {
  return (
    <div className="min-w-0">
      <MonoText className="block truncate font-medium" title={name}>
        {name}
      </MonoText>
      <MonoText className="text-muted-foreground block truncate text-[12px]" title={serverName}>
        {serverName}
      </MonoText>
    </div>
  )
}

function pausedText(agent: SafAgentRow) {
  const paused = [
    agent.pausedForForwarding ? 'forwarding' : null,
    agent.pausedForIncoming ? 'incoming' : null,
    agent.pausedForReceiving ? 'receiving' : null,
  ].filter(Boolean)
  return paused.length > 0 ? paused.join(', ') : null
}

export function Messaging() {
  const query = useMessagingInfrastructure()
  const data = query.data
  const failures = data?.partialFailures ?? []

  const storeColumns = useMemo<DataTableColumn<PersistentStoreRow>[]>(
    () => [
      {
        id: 'status',
        header: 'STATUS',
        cell: (row) => <StatusBadge kind="wls-health" value={row.healthState} />,
      },
      {
        id: 'store',
        header: 'STORE',
        className: 'min-w-[220px]',
        cell: (row) => <ServerAndName serverName={row.serverName} name={row.name} />,
      },
      { id: 'objects', header: 'OBJECTS', align: 'right', className: 'font-mono tabular-nums', cell: (row) => count(row.objectCount) },
      { id: 'creates', header: 'CREATES', align: 'right', className: 'font-mono tabular-nums', cell: (row) => count(row.createCount) },
      { id: 'reads', header: 'READS', align: 'right', className: 'font-mono tabular-nums', cell: (row) => count(row.readCount) },
      { id: 'writes', header: 'PHYSICAL WRITES', align: 'right', className: 'font-mono tabular-nums', cell: (row) => count(row.physicalWriteCount) },
      {
        id: 'reason',
        header: 'HEALTH REASON',
        className: 'min-w-[200px]',
        cell: (row) =>
          row.healthReason ? (
            <span className="block truncate" title={row.healthReason}>
              {row.healthReason}
            </span>
          ) : (
            <span className="text-muted-foreground">-</span>
          ),
      },
    ],
    [],
  )

  const safColumns = useMemo<DataTableColumn<SafAgentRow>[]>(
    () => [
      {
        id: 'status',
        header: 'STATUS',
        cell: (row) => <StatusBadge kind="custom" tone={severityTone(row.severity)} label={row.severity} />,
      },
      {
        id: 'agent',
        header: 'SAF AGENT',
        className: 'min-w-[200px]',
        cell: (row) => <ServerAndName serverName={row.serverName} name={row.name} />,
      },
      { id: 'messages', header: 'MESSAGES', align: 'right', className: 'font-mono tabular-nums', cell: (row) => count(row.messagesCurrentCount) },
      { id: 'pending', header: 'PENDING', align: 'right', className: 'font-mono tabular-nums', cell: (row) => count(row.messagesPendingCount) },
      { id: 'failed', header: 'FAILED', align: 'right', className: 'font-mono tabular-nums', cell: (row) => count(row.failedMessagesTotal) },
      {
        id: 'paused',
        header: 'PAUSED',
        cell: (row) => {
          const text = pausedText(row)
          return text ? <span className="text-status-warning">{text}</span> : <span className="text-muted-foreground">-</span>
        },
      },
      {
        id: 'endpoints',
        header: 'REMOTE ENDPOINTS',
        className: 'min-w-[260px]',
        cell: (row) =>
          row.remoteEndpoints.length === 0 ? (
            <span className="text-muted-foreground">-</span>
          ) : (
            <div className="space-y-0.5">
              {row.remoteEndpoints.map((endpoint) => (
                <div key={endpoint.name} className="min-w-0 text-[12px]">
                  <MonoText className={safEndpointFailing(endpoint) ? 'text-status-negative' : undefined} title={endpoint.url ?? endpoint.name}>
                    {endpoint.url ?? endpoint.name}
                  </MonoText>
                  {endpoint.lastException ? (
                    <span className="text-muted-foreground block truncate" title={endpoint.lastException}>
                      {endpoint.lastException}
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          ),
      },
    ],
    [],
  )

  const bridgeColumns = useMemo<DataTableColumn<MessagingBridgeRow>[]>(
    () => [
      {
        id: 'status',
        header: 'STATE',
        cell: (row) => <StatusBadge kind="custom" tone={severityTone(row.severity)} label={row.state ?? 'unknown'} />,
      },
      {
        id: 'bridge',
        header: 'BRIDGE',
        className: 'min-w-[220px]',
        cell: (row) => <ServerAndName serverName={row.serverName} name={row.name} />,
      },
      {
        id: 'description',
        header: 'DESCRIPTION',
        className: 'min-w-[260px]',
        cell: (row) =>
          row.description ? (
            <span className="block truncate" title={row.description}>
              {row.description}
            </span>
          ) : (
            <span className="text-muted-foreground">-</span>
          ),
      },
    ],
    [],
  )

  const error = query.isError
    ? { message: query.error instanceof Error ? query.error.message : 'Unable to load messaging runtime.', retry: () => void query.refetch() }
    : null

  return (
    <>
      <PageHeader
        title="Stores & SAF"
        subtitle="Persistent stores, store-and-forward agents and messaging bridges on running servers."
        updatedAt={query.dataUpdatedAt}
        refreshing={query.isFetching}
        onRefresh={() => void query.refetch()}
      />

      {failures.length > 0 ? (
        <div className="border-status-warning/60 bg-status-warning/8 mb-3 flex min-h-10 items-center justify-between gap-3 border px-3 py-2 text-[13px]">
          <span className="min-w-0 truncate">
            Partial data: {failures.map((failure) => `${failure.serverName}/${failure.family}: ${failure.message}`).join(' · ')}
          </span>
          <Button type="button" variant="ghost" size="sm" onClick={() => void query.refetch()}>
            Retry
          </Button>
        </div>
      ) : null}

      <SectionTitle title="Persistent stores" detail="File and JDBC stores used by JMS, SAF and JTA." />
      <DataTable
        columns={storeColumns}
        rows={data?.stores ?? []}
        getRowId={(row) => row.id}
        loading={query.isFetching && !data}
        error={error}
        empty="No persistent stores reported by running servers."
      />

      <SectionTitle title="SAF agents" detail="A failing remote endpoint with messages waiting means they are not being forwarded." />
      <DataTable
        columns={safColumns}
        rows={data?.safAgents ?? []}
        getRowId={(row) => row.id}
        loading={query.isFetching && !data}
        error={error}
        empty="No SAF agents reported by running servers."
      />

      <SectionTitle title="Messaging bridges" detail="Bridges that are not Active do not forward messages." />
      <DataTable
        columns={bridgeColumns}
        rows={data?.bridges ?? []}
        getRowId={(row) => row.id}
        loading={query.isFetching && !data}
        error={error}
        empty="No messaging bridges reported by running servers."
      />
    </>
  )
}
