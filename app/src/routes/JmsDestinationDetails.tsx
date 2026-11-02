import { useCallback, useMemo, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom'
import { ArrowLeft, ChevronLeft, ChevronRight, Clipboard, Eye, Loader2, Pause, Play, RefreshCw, Send, Trash2, X } from 'lucide-react'
import { JMS_BROWSE_MAX_SELECTOR_LENGTH } from '@/api/queries/jms-normalization'
import { deleteJmsMessages, fetchJmsMessageDetail, formatJmsMessageDeleteFeedback, formatJmsMessageProduceFeedback, jmsDestinationDetailQueryKey, jmsDestinationPauseOperationAvailable, jmsPausedStateLabel, jmsPausedValue, jmsPauseDimensionLabel, normalizeJmsBrowseUrlState, pauseJmsDestination, produceJmsMessage, serializeJmsBrowseUrlState, useJmsDestinationDetail, useJmsMessageBrowse, type JmsBrowsedMessageRow, type JmsDestinationRow, type JmsMessageDetailRow, type JmsMessageProduceRequest, type JmsPauseAction, type JmsPauseDimension, type JmsSeverity, type JmsTaskSummary } from '@/api/queries/jms'
import { readOnlyDemoModeEnabled, readRuntimeConfig } from '@/api/runtime-config'
import { useAuth } from '@/auth/useAuth'
import {
  ConfirmDialog,
  MonoText,
  PageHeader,
  StatusBadge,
  type StatusTone,
} from '@/components'
import { Button } from '@/components/ui/button'
import { detailReturnPath } from './detail-return-state'
import { routeParam } from './route-params'

const JMS_PRODUCE_MAX_BODY_LENGTH = 32_768
const JMS_PRODUCE_MAX_CORRELATION_ID_LENGTH = 256
const JMS_PRODUCE_MAX_PROPERTY_COUNT = 20
const JMS_PRODUCE_MAX_PROPERTY_NAME_LENGTH = 128
const JMS_PRODUCE_MAX_PROPERTY_VALUE_LENGTH = 1_024
const JMS_PRODUCE_MAX_TTL_SECONDS = 86_400
const JMS_PAUSE_DIMENSIONS: JmsPauseDimension[] = ['consumption', 'production', 'insertion']

function severityTone(severity: JmsSeverity): StatusTone {
  if (severity === 'critical') return 'negative'
  if (severity === 'warning') return 'warning'
  if (severity === 'healthy') return 'positive'
  return 'unknown'
}

function formatNumber(value: number | null) {
  return value === null ? '-' : value.toLocaleString()
}

function formatBoolean(value: boolean | null) {
  if (value === null) return '-'
  return value ? 'true' : 'false'
}

function formatTime(value: number | null) {
  if (value === null || value <= 0) return '-'
  return new Date(value).toLocaleString()
}

function formatEpochMillis(value: number | null) {
  if (value === null || value <= 0) return '-'
  return new Date(value).toLocaleString()
}

function parseProperties(value: string) {
  const properties: Record<string, string> = {}
  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const equals = line.indexOf('=')
    if (equals <= 0) throw new Error('Properties must use name=value lines.')
    const name = line.slice(0, equals).trim()
    const propertyValue = line.slice(equals + 1)
    if (Object.keys(properties).length >= JMS_PRODUCE_MAX_PROPERTY_COUNT) throw new Error(`At most ${JMS_PRODUCE_MAX_PROPERTY_COUNT} properties are allowed.`)
    if (name.length > JMS_PRODUCE_MAX_PROPERTY_NAME_LENGTH) throw new Error(`Property names must be at most ${JMS_PRODUCE_MAX_PROPERTY_NAME_LENGTH} characters.`)
    if (!/^[A-Za-z_][A-Za-z0-9_.$-]*$/.test(name)) throw new Error(`Invalid property name: ${name}.`)
    if (propertyValue.length > JMS_PRODUCE_MAX_PROPERTY_VALUE_LENGTH) throw new Error(`Property values must be at most ${JMS_PRODUCE_MAX_PROPERTY_VALUE_LENGTH} characters.`)
    properties[name] = propertyValue
  }
  return properties
}

function isQueue(row: JmsDestinationRow) {
  return (row.destinationType ?? '').toLowerCase().includes('queue')
}

function pauseTone(value: boolean | null): StatusTone {
  if (value === true) return 'warning'
  if (value === false) return 'positive'
  return 'unknown'
}

function Metric({
  label,
  value,
  detail,
}: {
  label: string
  value: string
  detail?: string
}) {
  return (
    <div className="border-border bg-surface-1 min-h-[72px] border px-3 py-2">
      <div className="text-muted-foreground text-[11px] uppercase leading-[14px] tracking-[0.04em]">{label}</div>
      <MonoText className="mt-2 block truncate text-[18px] leading-6" title={value}>
        {value}
      </MonoText>
      {detail ? <div className="text-muted-foreground mt-1 truncate text-xs">{detail}</div> : null}
    </div>
  )
}

function PartialBanner({
  failures,
  onRetry,
}: {
  failures: Array<{ serverName: string; jmsServerName?: string; family: string; message: string }>
  onRetry: () => void
}) {
  if (failures.length === 0) return null
  return (
    <div className="border-status-warning/60 bg-status-warning/8 mb-3 flex min-h-10 items-center justify-between gap-3 border px-3 py-2 text-[13px]">
      <span className="min-w-0 truncate">
        Partial data:{' '}
        {failures
          .map((failure) => `${failure.serverName}${failure.jmsServerName ? `/${failure.jmsServerName}` : ''}/${failure.family}: ${failure.message}`)
          .join(' · ')}
      </span>
      <Button type="button" variant="ghost" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  )
}

function pauseStateLabel(row: JmsDestinationRow, dimension: JmsPauseDimension) {
  return jmsPausedStateLabel(row, dimension) ?? formatBoolean(jmsPausedValue(row, dimension))
}

function PausePanel({ row, onRefresh }: { row: JmsDestinationRow; onRefresh: () => void }) {
  const { creds } = useAuth()
  const queryClient = useQueryClient()
  const readOnlyDemoMode = readOnlyDemoModeEnabled()
  const [pendingPause, setPendingPause] = useState<{ dimension: JmsPauseDimension; action: JmsPauseAction } | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)

  const pauseMutation = useMutation({
    mutationFn: async ({ dimension, action }: { dimension: JmsPauseDimension; action: JmsPauseAction }) => {
      if (!creds || !row.destinationName) throw new Error('JMS destination identity is required.')
      return pauseJmsDestination({
        creds,
        serverName: row.serverName,
        jmsServerName: row.jmsServerName,
        destinationName: row.destinationName,
        dimension,
        action,
      })
    },
    onSuccess: (_result, request) => {
      const label = jmsPauseDimensionLabel(request.dimension)
      setPendingPause(null)
      setFeedback(`${label} ${request.action === 'pause' ? 'pause' : 'resume'} request completed.`)
      if (creds && row.destinationName) {
        void queryClient.invalidateQueries({ queryKey: jmsDestinationDetailQueryKey(creds, row.serverName, row.jmsServerName, row.destinationName) })
      }
      onRefresh()
    },
    onError: (error) => {
      setPendingPause(null)
      setFeedback(error instanceof Error ? error.message : 'JMS destination pause operation failed.')
    },
  })

  const requestAction = useCallback((dimension: JmsPauseDimension, action: JmsPauseAction) => {
    setFeedback(null)
    // Resume changes message flow as much as pause does, so both are confirmed.
    setPendingPause({ dimension, action })
  }, [])

  const confirmSubject = pendingPause
    ? `${row.serverName} / ${row.jmsServerName} / ${row.destinationName}`
    : undefined
  const confirmVerb = pendingPause?.action === 'resume' ? 'Resume' : 'Pause'
  const confirmDescription = pendingPause
    ? `${confirmVerb} ${jmsPauseDimensionLabel(pendingPause.dimension).toLowerCase()} for ${row.destinationName}. ${
        pendingPause.action === 'resume' ? 'Held messages start flowing again. ' : ''
      }Runtime counters remain visible while WebLogic applies the change.`
    : ''

  return (
    <section className="border-border bg-surface-1 border px-3 py-3">
      <div className="mb-3">
        <h2 className="text-[14px] font-medium leading-5">Pause State</h2>
        <p className="text-muted-foreground text-[13px] leading-[18px]">
          {readOnlyDemoMode ? 'Read-only production, consumption, and insertion pause status.' : 'Guarded destination production, consumption, and insertion controls.'}
        </p>
      </div>
      {feedback ? (
        <div className="border-status-warning/60 bg-status-warning/8 mb-3 flex min-h-10 items-center justify-between gap-3 border px-3 py-2 text-[13px]">
          <span className="min-w-0 truncate">{feedback}</span>
          <Button type="button" variant="ghost" size="sm" onClick={() => setFeedback(null)}>Dismiss</Button>
        </div>
      ) : null}
      <div className="grid gap-3 md:grid-cols-3">
        {JMS_PAUSE_DIMENSIONS.map((dimension) => {
          const paused = jmsPausedValue(row, dimension)
          const available = jmsDestinationPauseOperationAvailable(row, dimension)
          const action: JmsPauseAction = paused ? 'resume' : 'pause'
          const label = jmsPauseDimensionLabel(dimension)
          return (
            <div key={dimension} className="border-border bg-background min-h-[96px] border px-3 py-2">
              <div className="text-muted-foreground text-[11px] uppercase leading-[14px] tracking-[0.04em]">{label}</div>
              <div className="mt-2 flex items-center justify-between gap-2">
                <StatusBadge kind="custom" tone={pauseTone(paused)} label={pauseStateLabel(row, dimension)} />
                {readOnlyDemoMode ? null : available ? (
                  <Button
                    type="button"
                    variant={action === 'pause' ? 'outline' : 'ghost'}
                    size="sm"
                    onClick={() => requestAction(dimension, action)}
                    disabled={pauseMutation.isPending}
                  >
                    {pauseMutation.isPending ? (
                      <Loader2 className="size-3.5 animate-spin" strokeWidth={1.5} />
                    ) : action === 'pause' ? (
                      <Pause className="size-3.5" strokeWidth={1.5} />
                    ) : (
                      <Play className="size-3.5" strokeWidth={1.5} />
                    )}
                    {action === 'pause' ? 'Pause' : 'Resume'}
                  </Button>
                ) : (
                  <StatusBadge kind="custom" tone="unknown" label="UNSUPPORTED" />
                )}
              </div>
            </div>
          )
        })}
      </div>
      <ConfirmDialog
        open={!!pendingPause}
        title={`${confirmVerb} JMS Destination`}
        description={confirmDescription}
        confirmLabel={confirmVerb}
        subject={confirmSubject}
        pending={pauseMutation.isPending}
        onCancel={() => {
          if (!pauseMutation.isPending) setPendingPause(null)
        }}
        onConfirm={() => {
          if (pendingPause) pauseMutation.mutate(pendingPause)
        }}
      />
    </section>
  )
}

function TaskPanel({ tasks }: { tasks: JmsTaskSummary[] }) {
  return (
    <section className="border-border bg-surface-1 border px-3 py-3">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-[14px] font-medium leading-5">Message Management Tasks</h2>
          <p className="text-muted-foreground text-[13px] leading-[18px]">Task history when the target version exposes it.</p>
        </div>
        <MonoText className="text-muted-foreground text-[13px]">{tasks.length.toLocaleString()}</MonoText>
      </div>
      {tasks.length === 0 ? (
        <div className="text-muted-foreground flex min-h-16 items-center border-y border-border py-2 text-[13px]">
          No task rows reported.
        </div>
      ) : (
        <div className="overflow-auto border-b border-border">
          <table className="w-full min-w-[760px] border-collapse tabular-nums">
            <thead>
              <tr className="h-9 border-b border-border">
                <th className="text-muted-foreground px-3 text-left text-[13px] font-medium uppercase tracking-[0.04em]">Name</th>
                <th className="text-muted-foreground px-3 text-left text-[13px] font-medium uppercase tracking-[0.04em]">State</th>
                <th className="text-muted-foreground px-3 text-left text-[13px] font-medium uppercase tracking-[0.04em]">Progress</th>
                <th className="text-muted-foreground px-3 text-left text-[13px] font-medium uppercase tracking-[0.04em]">Begin</th>
                <th className="text-muted-foreground px-3 text-left text-[13px] font-medium uppercase tracking-[0.04em]">End</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => (
                <tr key={task.name} className="h-9 border-t border-border">
                  <td className="max-w-[220px] truncate px-3"><MonoText title={task.name}>{task.name}</MonoText></td>
                  <td className="px-3"><MonoText>{task.state ?? '-'}</MonoText></td>
                  <td className="max-w-[260px] truncate px-3 text-muted-foreground" title={task.description ?? task.progress ?? undefined}>{task.progress ?? task.description ?? '-'}</td>
                  <td className="px-3"><MonoText>{formatTime(task.beginTime)}</MonoText></td>
                  <td className="px-3"><MonoText>{formatTime(task.endTime)}</MonoText></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function MessageDetailPanel({
  messageId,
  row,
  pending,
  error,
  feedback,
  onCopyBody,
  onCopy,
  onClose,
}: {
  messageId: string | null
  row: JmsMessageDetailRow | null
  pending: boolean
  error: string | null
  feedback: string | null
  onCopyBody: () => void
  onCopy: () => void
  onClose: () => void
}) {
  return (
    <div className="border-border bg-background mt-3 border">
      <div className="flex min-h-10 items-center justify-between gap-3 border-b border-border px-3 py-2">
        <div className="min-w-0">
          <h3 className="text-[14px] font-medium leading-5">Message Detail</h3>
          <MonoText className="text-muted-foreground mt-1 block truncate text-[12px] leading-4" title={messageId ?? undefined}>
            {messageId ?? 'Selected message'}
          </MonoText>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onCopyBody} disabled={!row?.bodyText || pending}>
            <Clipboard className="size-3.5" strokeWidth={1.5} />
            Copy Body
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={onCopy} disabled={!row?.messageXmlText || pending}>
            <Clipboard className="size-3.5" strokeWidth={1.5} />
            Copy XML
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            <X className="size-3.5" strokeWidth={1.5} />
            Close
          </Button>
        </div>
      </div>

      {pending ? (
        <div className="text-muted-foreground flex min-h-16 items-center gap-2 px-3 py-3 text-[13px]">
          <Loader2 className="size-3 animate-spin" strokeWidth={1.5} />
          Loading message detail...
        </div>
      ) : error ? (
        <div className="border-status-negative/60 bg-status-negative/8 m-3 flex min-h-10 items-center border px-3 py-2 text-[13px]">
          {error}
        </div>
      ) : row ? (
        <div className="space-y-3 px-3 py-3">
          <div className="grid gap-2 md:grid-cols-4">
            <Metric label="Delivery" value={row.deliveryMode ?? '-'} />
            <Metric label="Type" value={row.type ?? '-'} />
            <Metric label="Redelivered" value={formatBoolean(row.redelivered)} />
            <Metric label="Expiration" value={formatEpochMillis(row.expiration)} />
          </div>
          {feedback ? <div className="text-muted-foreground text-[12px] leading-4">{feedback}</div> : null}
          {row.bodyText ? (
            <div>
              <div className="text-muted-foreground mb-2 text-[11px] uppercase leading-[14px] tracking-[0.04em]">Body</div>
              <pre className="border-border bg-surface-1 max-h-[360px] overflow-auto whitespace-pre-wrap break-words border p-3 text-[12px] leading-[17px] text-foreground">
                {row.bodyText}
              </pre>
            </div>
          ) : row.messageXmlText ? (
            <div>
              <div className="text-muted-foreground mb-2 text-[11px] uppercase leading-[14px] tracking-[0.04em]">WebLogic Message XML</div>
              {row.bodyUnavailableReason ? <div className="text-muted-foreground mb-2 text-[12px] leading-4">{row.bodyUnavailableReason}</div> : null}
              <pre className="border-border bg-surface-1 max-h-[360px] overflow-auto whitespace-pre-wrap break-words border p-3 text-[12px] leading-[17px] text-foreground">
                {row.messageXmlText}
              </pre>
            </div>
          ) : (
            <div className="text-muted-foreground flex min-h-16 items-center border-y border-border py-2 text-[13px]">
              Message body is not available in the WebLogic JMX response.
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}

function ProducePanel({
  row,
  onProduced,
}: {
  row: JmsDestinationRow
  onProduced: () => void
}) {
  const { creds } = useAuth()
  const queryClient = useQueryClient()
  const runtimeConfig = readRuntimeConfig()
  const readOnlyDemoMode = runtimeConfig.readOnlyDemoMode
  const [open, setOpen] = useState(false)
  const [body, setBody] = useState('')
  const [correlationId, setCorrelationId] = useState('')
  const [propertiesText, setPropertiesText] = useState('')
  const [priority, setPriority] = useState(4)
  const [deliveryMode, setDeliveryMode] = useState<'NON_PERSISTENT' | 'PERSISTENT'>('NON_PERSISTENT')
  const [ttlSeconds, setTtlSeconds] = useState(0)
  const [pendingRequest, setPendingRequest] = useState<JmsMessageProduceRequest | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)
  const [validationError, setValidationError] = useState<string | null>(null)

  const supported = runtimeConfig.jmsJmxAvailable && !readOnlyDemoMode && isQueue(row) && row.productionPaused !== true
  const produceMutation = useMutation({
    mutationFn: async (request: JmsMessageProduceRequest) => {
      // Production may have been paused (or JMX lost) since the form opened.
      if (!supported) throw new Error('Producing is no longer available for this destination.')
      if (!creds || !row.destinationName) throw new Error('JMS destination identity is required.')
      return produceJmsMessage({
        creds,
        serverName: row.serverName,
        jmsServerName: row.jmsServerName,
        destinationName: row.destinationName,
        destinationType: row.destinationType ?? '',
        request,
      })
    },
    onSuccess: (result) => {
      setPendingRequest(null)
      setFeedback(formatJmsMessageProduceFeedback(result))
      setBody('')
      setCorrelationId('')
      setPropertiesText('')
      setPriority(4)
      setDeliveryMode('NON_PERSISTENT')
      setTtlSeconds(0)
      setOpen(false)
      void queryClient.invalidateQueries({ queryKey: ['jmsMessageBrowse'] })
      if (creds && row.destinationName) void queryClient.invalidateQueries({ queryKey: jmsDestinationDetailQueryKey(creds, row.serverName, row.jmsServerName, row.destinationName) })
      onProduced()
    },
    onError: (error) => {
      setPendingRequest(null)
      setFeedback(error instanceof Error ? error.message : 'Unable to produce JMS message.')
    },
  })

  const prepare = useCallback(() => {
    try {
      const trimmedBody = body.trim()
      if (!trimmedBody) throw new Error('Message body is required.')
      if (body.length > JMS_PRODUCE_MAX_BODY_LENGTH) throw new Error(`Message body must be at most ${JMS_PRODUCE_MAX_BODY_LENGTH.toLocaleString()} characters.`)
      const trimmedCorrelationId = correlationId.trim()
      if (trimmedCorrelationId.length > JMS_PRODUCE_MAX_CORRELATION_ID_LENGTH) {
        throw new Error(`Correlation ID must be at most ${JMS_PRODUCE_MAX_CORRELATION_ID_LENGTH} characters.`)
      }
      if (!Number.isInteger(priority) || priority < 0 || priority > 9) throw new Error('Priority must be an integer between 0 and 9.')
      if (!Number.isFinite(ttlSeconds) || ttlSeconds < 0 || ttlSeconds > JMS_PRODUCE_MAX_TTL_SECONDS) {
        throw new Error(`TTL must be between 0 and ${JMS_PRODUCE_MAX_TTL_SECONDS.toLocaleString()} seconds.`)
      }
      const properties = parseProperties(propertiesText)
      const request: JmsMessageProduceRequest = {
        body,
        correlationId: trimmedCorrelationId,
        properties,
        priority,
        deliveryMode,
        ttlMillis: Math.max(0, Math.floor(ttlSeconds * 1000)),
      }
      setValidationError(null)
      setPendingRequest(request)
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : 'Invalid JMS message request.')
    }
  }, [body, correlationId, deliveryMode, priority, propertiesText, ttlSeconds])

  const pendingPropertyCount = Object.keys(pendingRequest?.properties ?? {}).length
  const pendingTtlSeconds = Math.floor((pendingRequest?.ttlMillis ?? 0) / 1000)
  const pendingConfirmationDescription =
    `Send one text message to ${row.destinationName}. ` +
    `Payload size ${pendingRequest?.body.length.toLocaleString() ?? 0} characters, ` +
    `${pendingPropertyCount.toLocaleString()} properties, priority ${pendingRequest?.priority ?? 4}, ` +
    `${pendingRequest?.deliveryMode ?? 'NON_PERSISTENT'}, TTL ${pendingTtlSeconds.toLocaleString()} seconds, ` +
    `correlation id ${pendingRequest?.correlationId ? 'set' : 'not set'}.`

  if (!supported && !open && !feedback) {
    return (
      <section className="border-border bg-surface-1 border px-3 py-3">
        <div className="flex min-h-10 items-center justify-between gap-3">
          <div>
            <h2 className="text-[14px] font-medium leading-5">Produce Message</h2>
            <p className="text-muted-foreground text-[13px] leading-[18px]">
              {readOnlyDemoMode
                ? 'Disabled in read-only mode.'
                : !runtimeConfig.jmsJmxAvailable
                  ? 'Needs the local JMX helper; Message Browse below explains how to enable it.'
                  : row.productionPaused
                    ? 'Production is paused for this destination.'
                    : 'Available for queue destinations with local JMX configured.'}
            </p>
          </div>
          <StatusBadge kind="custom" tone="unknown" label="UNAVAILABLE" />
        </div>
      </section>
    )
  }

  return (
    <section className="border-border bg-surface-1 border px-3 py-3">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-[14px] font-medium leading-5">Produce Message</h2>
          <p className="text-muted-foreground text-[13px] leading-[18px]">One text message through the local WebLogic JMX adapter.</p>
        </div>
        <Button type="button" variant={open ? 'ghost' : 'outline'} size="sm" onClick={() => setOpen(!open)} disabled={!supported || produceMutation.isPending}>
          {open ? <X className="size-3.5" strokeWidth={1.5} /> : <Send className="size-3.5" strokeWidth={1.5} />}
          {open ? 'Close' : 'Produce'}
        </Button>
      </div>

      {feedback ? (
        <div className="border-status-warning/60 bg-status-warning/8 mb-3 flex min-h-10 items-center justify-between gap-3 border px-3 py-2 text-[13px]">
          <span className="min-w-0 truncate">{feedback}</span>
          <Button type="button" variant="ghost" size="sm" onClick={() => setFeedback(null)}>Dismiss</Button>
        </div>
      ) : null}

      {open ? (
        <div className="space-y-3">
          <textarea
            className="border-input bg-background min-h-[96px] w-full resize-y border px-2 py-2 text-[13px] leading-[18px] outline-none focus:border-ring"
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder="Text message body"
          />
          <div className="grid gap-2 md:grid-cols-[1fr_110px_150px_110px]">
            <input
              className="border-input bg-background h-9 min-w-0 border px-2 text-[13px] outline-none focus:border-ring"
              value={correlationId}
              onChange={(event) => setCorrelationId(event.target.value)}
              placeholder="Correlation ID"
            />
            <input
              className="border-input bg-background h-9 border px-2 text-[13px] outline-none focus:border-ring"
              type="number"
              min={0}
              max={9}
              value={priority}
              onChange={(event) => setPriority(event.target.value === '' ? 0 : Number.parseInt(event.target.value, 10))}
              title="Priority"
            />
            <select
              className="border-input bg-background h-9 border px-2 text-[13px] outline-none focus:border-ring"
              value={deliveryMode}
              onChange={(event) => setDeliveryMode(event.target.value === 'PERSISTENT' ? 'PERSISTENT' : 'NON_PERSISTENT')}
            >
              <option value="NON_PERSISTENT">NON_PERSISTENT</option>
              <option value="PERSISTENT">PERSISTENT</option>
            </select>
            <input
              className="border-input bg-background h-9 border px-2 text-[13px] outline-none focus:border-ring"
              type="number"
              min={0}
              max={JMS_PRODUCE_MAX_TTL_SECONDS}
              value={ttlSeconds}
              onChange={(event) => setTtlSeconds(Number(event.target.value))}
              title="TTL seconds"
            />
          </div>
          <textarea
            className="border-input bg-background min-h-[64px] w-full resize-y border px-2 py-2 font-mono text-[12px] leading-[17px] outline-none focus:border-ring"
            value={propertiesText}
            onChange={(event) => setPropertiesText(event.target.value)}
            placeholder="name=value"
          />
          {validationError ? <div className="text-status-negative text-[13px] leading-[18px]">{validationError}</div> : null}
          <div className="flex justify-end">
            <Button type="button" variant="default" size="sm" onClick={prepare} disabled={!supported || produceMutation.isPending}>
              <Send className="size-3.5" strokeWidth={1.5} />
              Send
            </Button>
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        open={!!pendingRequest}
        title="Produce JMS Message"
        description={pendingConfirmationDescription}
        confirmLabel="Send"
        subject={`${row.serverName} / ${row.jmsServerName} / ${row.destinationName}`}
        pending={produceMutation.isPending}
        onCancel={() => {
          if (!produceMutation.isPending) setPendingRequest(null)
        }}
        onConfirm={() => {
          if (pendingRequest) produceMutation.mutate(pendingRequest)
        }}
      />
    </section>
  )
}

function MessageBrowsePanel({
  serverName,
  jmsServerName,
  destinationName,
  onRefreshDetail,
}: {
  serverName: string
  jmsServerName: string
  destinationName: string
  onRefreshDetail: () => void
}) {
  const { creds } = useAuth()
  const queryClient = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()
  const browseUrlState = useMemo(() => normalizeJmsBrowseUrlState(searchParams), [searchParams])
  const readOnlyDemoMode = readOnlyDemoModeEnabled()
  const selectorInputRef = useRef<HTMLInputElement | null>(null)
  const [pendingDelete, setPendingDelete] = useState<JmsBrowsedMessageRow | null>(null)
  const [pendingBulkDelete, setPendingBulkDelete] = useState<JmsBrowsedMessageRow[] | null>(null)
  const [selectedMessageIds, setSelectedMessageIds] = useState<Set<string>>(() => new Set())
  const [selectedDetail, setSelectedDetail] = useState<JmsBrowsedMessageRow | null>(null)
  const [actionMessage, setActionMessage] = useState<string | null>(null)
  const [detailFeedback, setDetailFeedback] = useState<string | null>(null)
  const { selector: appliedSelector, offset, limit } = browseUrlState
  const browse = useJmsMessageBrowse(serverName, jmsServerName, destinationName, {
    selector: appliedSelector,
    offset,
    limit,
  })
  const failure = browse.data?.partialFailures[0]
  const cursorSize = browse.data?.cursorSize ?? 0
  const canPagePrevious = offset > 0
  const canPageNext = browse.data?.support === 'supported' && offset + limit < cursorSize
  const browsedMessages = browse.data?.messages
  const messages = useMemo(() => browsedMessages ?? [], [browsedMessages])
  const selectableMessages = useMemo(() => messages.filter((message) => !!message.messageId && message.deleteCapable), [messages])
  const selectedRows = useMemo(
    () => selectableMessages.filter((message) => !!message.messageId && selectedMessageIds.has(message.messageId)),
    [selectableMessages, selectedMessageIds],
  )
  const allVisibleSelected = selectableMessages.length > 0 && selectedRows.length === selectableMessages.length

  const updateBrowseUrlState = useCallback(
    (patch: Partial<typeof browseUrlState>) => {
      setSelectedMessageIds(new Set())
      setSearchParams((previous) => serializeJmsBrowseUrlState({ ...normalizeJmsBrowseUrlState(previous), ...patch }, previous), {
        replace: true,
      })
    },
    [setSearchParams],
  )

  const deleteMutation = useMutation({
    mutationFn: async (rows: JmsBrowsedMessageRow[]) => {
      if (!creds) throw new Error('Authentication is required.')
      const messageIds = rows.flatMap((row) => (row.messageId ? [row.messageId] : []))
      if (messageIds.length < 1) throw new Error('Select one or more visible messages.')
      return deleteJmsMessages({ creds, serverName, jmsServerName, destinationName, messageIds })
    },
    onSuccess: (result) => {
      setPendingDelete(null)
      setPendingBulkDelete(null)
      setSelectedMessageIds(new Set())
      setActionMessage(formatJmsMessageDeleteFeedback(result))
      void queryClient.invalidateQueries({ queryKey: ['jmsMessageBrowse'] })
      if (creds) void queryClient.invalidateQueries({ queryKey: jmsDestinationDetailQueryKey(creds, serverName, jmsServerName, destinationName) })
      void browse.refetch()
      onRefreshDetail()
    },
    onError: (error) => {
      setActionMessage(error instanceof Error ? error.message : 'Unable to delete JMS message.')
    },
  })
  const detailMutation = useMutation({
    mutationFn: async (row: JmsBrowsedMessageRow) => {
      if (!creds || !row.messageId) throw new Error('Message id is required.')
      return fetchJmsMessageDetail({ creds, serverName, jmsServerName, destinationName, messageId: row.messageId })
    },
    onMutate: (row) => {
      setSelectedDetail(row)
      setDetailFeedback(null)
      setActionMessage(null)
    },
    onError: (error) => {
      setDetailFeedback(error instanceof Error ? error.message : 'Unable to load JMS message detail.')
    },
  })

  const applySelector = useCallback(() => {
    const selector = selectorInputRef.current?.value ?? ''
    // A longer selector used to be dropped silently, which browsed the whole destination instead.
    if (selector.length > JMS_BROWSE_MAX_SELECTOR_LENGTH) {
      setActionMessage(`The selector is longer than ${JMS_BROWSE_MAX_SELECTOR_LENGTH.toLocaleString()} characters and was not applied.`)
      return
    }
    updateBrowseUrlState({ selector, offset: 0 })
  }, [updateBrowseUrlState])

  const retry = useCallback(() => {
    setActionMessage(null)
    void browse.refetch()
  }, [browse])

  const toggleSelectedMessage = useCallback((messageId: string, selected: boolean) => {
    setSelectedMessageIds((current) => {
      const next = new Set(current)
      if (selected) next.add(messageId)
      else next.delete(messageId)
      return next
    })
  }, [])

  const toggleAllVisible = useCallback((selected: boolean) => {
    setSelectedMessageIds((current) => {
      const next = new Set(current)
      for (const message of selectableMessages) {
        if (!message.messageId) continue
        if (selected) next.add(message.messageId)
        else next.delete(message.messageId)
      }
      return next
    })
  }, [selectableMessages])

  const copyDetailXml = useCallback(() => {
    const xml = detailMutation.data?.message?.messageXmlText
    if (!xml) return
    if (!navigator.clipboard?.writeText) {
      setDetailFeedback('Clipboard API unavailable.')
      return
    }
    navigator.clipboard.writeText(xml).then(
      () => setDetailFeedback('Message XML copied.'),
      (error: unknown) => setDetailFeedback(error instanceof Error ? `Copy failed: ${error.message}` : 'Copy failed.'),
    )
  }, [detailMutation.data?.message?.messageXmlText])

  const copyDetailBody = useCallback(() => {
    const body = detailMutation.data?.message?.bodyText
    if (!body) return
    if (!navigator.clipboard?.writeText) {
      setDetailFeedback('Clipboard API unavailable.')
      return
    }
    navigator.clipboard.writeText(body).then(
      () => setDetailFeedback('Message body copied.'),
      (error: unknown) => setDetailFeedback(error instanceof Error ? `Copy failed: ${error.message}` : 'Copy failed.'),
    )
  }, [detailMutation.data?.message?.bodyText])

  const closeDetail = useCallback(() => {
    setSelectedDetail(null)
    setDetailFeedback(null)
    detailMutation.reset()
  }, [detailMutation])

  return (
    <section className="border-border bg-surface-1 border px-3 py-3">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-[14px] font-medium leading-5">Messages</h2>
          <p className="text-muted-foreground text-[13px] leading-[18px]">Bounded browse through the local JMX/T3 adapter when configured.</p>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={retry} disabled={browse.isFetching}>
          <RefreshCw className="size-3.5" strokeWidth={1.5} />
          Refresh
        </Button>
      </div>
      <div className="mb-3 grid gap-2 md:grid-cols-[1fr_96px_auto]">
        <input
          className="border-input bg-background h-9 min-w-0 border px-2 text-[13px] outline-none focus:border-ring"
          key={appliedSelector}
          ref={selectorInputRef}
          defaultValue={appliedSelector}
          maxLength={JMS_BROWSE_MAX_SELECTOR_LENGTH}
          placeholder="JMS selector"
        />
        <select
          className="border-input bg-background h-9 border px-2 text-[13px] outline-none focus:border-ring"
          value={limit}
          onChange={(event) => {
            updateBrowseUrlState({ limit: Number(event.target.value), offset: 0 })
          }}
        >
          <option value={10}>10</option>
          <option value={25}>25</option>
          <option value={50}>50</option>
        </select>
        <Button type="button" variant="outline" size="sm" onClick={applySelector} disabled={browse.isFetching}>
          Apply
        </Button>
      </div>
      {actionMessage ? (
        <div className="border-status-warning/60 bg-status-warning/8 mb-3 flex min-h-10 items-center justify-between gap-3 border px-3 py-2 text-[13px]">
          <span className="min-w-0 truncate">{actionMessage}</span>
          <Button type="button" variant="ghost" size="sm" onClick={() => setActionMessage(null)}>
            Dismiss
          </Button>
        </div>
      ) : null}
      {!readOnlyDemoMode ? (
        <div className="border-border bg-background mb-3 flex min-h-10 items-center justify-between gap-3 border px-3 py-2 text-[13px]">
          <span className="text-muted-foreground min-w-0 truncate">
            Selected-message move and drain are unsupported until a built-in WebLogic operation is verified.
          </span>
          <StatusBadge kind="custom" tone="unknown" label="MOVE UNSUPPORTED" />
        </div>
      ) : null}
      {browse.isFetching && !browse.data ? (
        <div className="text-muted-foreground flex min-h-16 items-center gap-2 border-y border-border py-2 text-[13px]">
          <Loader2 className="size-3 animate-spin" strokeWidth={1.5} />
          Loading...
        </div>
      ) : browse.data?.support !== 'supported' ? (
        <div className="border-status-warning/60 bg-status-warning/8 flex min-h-16 items-start justify-between gap-3 border px-3 py-2 text-[13px]">
          <div className="min-w-0">
            <div className="truncate">
              {failure?.message ?? 'Message browsing is not exposed by this target/version.'}
            </div>
            {failure?.details?.length ? (
              <div className="mt-2 space-y-1">
                {failure.details.map((detail) => (
                  <MonoText key={detail} className="text-muted-foreground block truncate text-[12px] leading-4" title={detail}>
                    {detail}
                  </MonoText>
                ))}
              </div>
            ) : null}
          </div>
          <StatusBadge kind="custom" tone="warning" label="UNSUPPORTED" />
        </div>
      ) : messages.length === 0 ? (
        <div className="text-muted-foreground flex min-h-16 items-center justify-between gap-3 border-y border-border py-2 text-[13px]">
          <span>No messages matched the current browse window.</span>
          <div className="flex items-center gap-2">
            <MonoText>{cursorSize.toLocaleString()} total</MonoText>
            {/* Messages consumed since the window was opened can leave the offset past the end. */}
            {canPagePrevious ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => updateBrowseUrlState({ offset: 0 })}
                disabled={browse.isFetching}
              >
                <ChevronLeft className="size-3.5" strokeWidth={1.5} />
                Back to first
              </Button>
            ) : null}
          </div>
        </div>
      ) : (
        <>
          <div className="mb-2 flex items-center justify-between gap-3 text-[13px]">
            <span className="text-muted-foreground">
              Showing {Math.min(offset + 1, cursorSize).toLocaleString()}-{Math.min(offset + messages.length, cursorSize).toLocaleString()} of{' '}
              {cursorSize.toLocaleString()}
            </span>
            <div className="flex items-center gap-2">
              {!readOnlyDemoMode ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setPendingBulkDelete(selectedRows)}
                  disabled={selectedRows.length === 0 || deleteMutation.isPending}
                >
                  <Trash2 className="size-3.5" strokeWidth={1.5} />
                  Delete selected {selectedRows.length ? `(${selectedRows.length.toLocaleString()})` : ''}
                </Button>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => updateBrowseUrlState({ offset: Math.max(0, offset - limit) })}
                disabled={!canPagePrevious || browse.isFetching}
              >
                <ChevronLeft className="size-3.5" strokeWidth={1.5} />
                Previous
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => updateBrowseUrlState({ offset: offset + limit })}
                disabled={!canPageNext || browse.isFetching}
              >
                Next
                <ChevronRight className="size-3.5" strokeWidth={1.5} />
              </Button>
            </div>
          </div>
          <div className="overflow-auto border-b border-border">
            <table className="w-full min-w-[1040px] border-collapse tabular-nums">
              <thead>
                <tr className="h-9 border-b border-border">
                  {!readOnlyDemoMode ? (
                    <th className="w-10 px-3 text-left">
                      <input
                        aria-label="Select all visible JMS messages"
                        type="checkbox"
                        checked={allVisibleSelected}
                        disabled={selectableMessages.length === 0 || deleteMutation.isPending}
                        onChange={(event) => toggleAllVisible(event.target.checked)}
                      />
                    </th>
                  ) : null}
                  <th className="text-muted-foreground px-3 text-left text-[13px] font-medium uppercase tracking-[0.04em]">Message ID</th>
                  <th className="text-muted-foreground px-3 text-left text-[13px] font-medium uppercase tracking-[0.04em]">State</th>
                  <th className="text-muted-foreground px-3 text-left text-[13px] font-medium uppercase tracking-[0.04em]">Size</th>
                  <th className="text-muted-foreground px-3 text-left text-[13px] font-medium uppercase tracking-[0.04em]">Priority</th>
                  <th className="text-muted-foreground px-3 text-left text-[13px] font-medium uppercase tracking-[0.04em]">Timestamp</th>
                  <th className="text-muted-foreground px-3 text-left text-[13px] font-medium uppercase tracking-[0.04em]">Properties</th>
                  <th className="text-muted-foreground px-3 text-right text-[13px] font-medium uppercase tracking-[0.04em]">Actions</th>
                </tr>
              </thead>
              <tbody>
                {messages.map((message) => (
                  <tr key={message.id} className="h-10 border-t border-border align-top">
                    {!readOnlyDemoMode ? (
                      <td className="px-3 py-2">
                        <input
                          aria-label={`Select JMS message ${message.messageId ?? message.handle ?? message.id}`}
                          type="checkbox"
                          checked={!!message.messageId && selectedMessageIds.has(message.messageId)}
                          disabled={!message.messageId || !message.deleteCapable || deleteMutation.isPending}
                          onChange={(event) => {
                            if (message.messageId) toggleSelectedMessage(message.messageId, event.target.checked)
                          }}
                        />
                      </td>
                    ) : null}
                    <td className="max-w-[260px] px-3 py-2">
                      <MonoText className="block truncate" title={message.messageId ?? message.handle ?? undefined}>
                        {message.messageId ?? message.handle ?? '-'}
                      </MonoText>
                      {message.correlationId ? <MonoText className="text-muted-foreground mt-1 block truncate">corr {message.correlationId}</MonoText> : null}
                    </td>
                    <td className="px-3 py-2"><MonoText>{message.state ?? '-'}</MonoText></td>
                    <td className="px-3 py-2"><MonoText>{formatNumber(message.messageSize)}</MonoText></td>
                    <td className="px-3 py-2"><MonoText>{formatNumber(message.priority)}</MonoText></td>
                    <td className="px-3 py-2"><MonoText>{formatEpochMillis(message.timestamp)}</MonoText></td>
                    <td className="max-w-[320px] px-3 py-2">
                      {message.properties.count > 0 ? (
                        <div className="text-muted-foreground truncate text-[12px]" title={message.properties.names.join(', ')}>
                          props {message.properties.count.toLocaleString()}: {message.properties.names.join(', ')}
                        </div>
                      ) : (
                        <span className="text-muted-foreground text-[12px]">–</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex justify-end gap-2">
                        {message.messageId ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => detailMutation.mutate(message)}
                            disabled={detailMutation.isPending && selectedDetail?.id === message.id}
                            title="View message detail"
                          >
                            {detailMutation.isPending && selectedDetail?.id === message.id ? (
                              <Loader2 className="size-3.5 animate-spin" strokeWidth={1.5} />
                            ) : (
                              <Eye className="size-3.5" strokeWidth={1.5} />
                            )}
                            View
                          </Button>
                        ) : null}
                        {!readOnlyDemoMode && message.deleteCapable ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => setPendingDelete(message)}
                            disabled={deleteMutation.isPending}
                            title="Delete message"
                          >
                            <Trash2 className="size-3.5" strokeWidth={1.5} />
                            Delete
                          </Button>
                        ) : (
                          <StatusBadge kind="custom" tone={readOnlyDemoMode ? 'unknown' : 'warning'} label={readOnlyDemoMode ? 'READ-ONLY' : 'NO ID'} />
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {selectedDetail ? (
            <MessageDetailPanel
              messageId={selectedDetail.messageId}
              row={detailMutation.data?.message ?? null}
              pending={detailMutation.isPending}
              error={detailMutation.isError ? detailFeedback : null}
              feedback={!detailMutation.isError ? detailFeedback : null}
              onCopyBody={copyDetailBody}
              onCopy={copyDetailXml}
              onClose={closeDetail}
            />
          ) : null}
        </>
      )}
      <ConfirmDialog
        open={!!pendingDelete}
        title="Delete JMS Message"
        description={`Delete this message from ${destinationName}. This cannot be undone.`}
        confirmLabel="Delete"
        subject={pendingDelete?.messageId ?? undefined}
        pending={deleteMutation.isPending}
        onCancel={() => {
          if (!deleteMutation.isPending) setPendingDelete(null)
        }}
        onConfirm={() => {
          if (pendingDelete) deleteMutation.mutate([pendingDelete])
        }}
      />
      <ConfirmDialog
        open={!!pendingBulkDelete}
        title="Delete Selected JMS Messages"
        description={`Delete ${pendingBulkDelete?.length.toLocaleString() ?? 0} selected visible messages from ${destinationName}. This cannot be undone.`}
        confirmLabel="Delete selected"
        subject={`${serverName} / ${jmsServerName} / ${destinationName}`}
        pending={deleteMutation.isPending}
        onCancel={() => {
          if (!deleteMutation.isPending) setPendingBulkDelete(null)
        }}
        onConfirm={() => {
          if (pendingBulkDelete) deleteMutation.mutate(pendingBulkDelete)
        }}
      />
    </section>
  )
}

export function JmsDestinationDetails() {
  const location = useLocation()
  const params = useParams()
  const serverName = routeParam(params.serverName)
  const jmsServerName = routeParam(params.jmsServerName)
  const destinationName = routeParam(params.destinationName)
  const query = useJmsDestinationDetail(serverName, jmsServerName, destinationName)
  const failures = query.data?.partialFailures ?? []
  const returnPath = useMemo(() => detailReturnPath(location.state, '/jms'), [location.state])
  const row = query.data?.row ?? null
  const refetchAll = useCallback(() => void query.refetch(), [query])

  return (
    <>
      <PageHeader
        title={destinationName || 'JMS Destination'}
        subtitle="Single JMS destination runtime snapshot."
        meta={
          <>
            <Button type="button" variant="ghost" size="sm" className="-ml-2" asChild>
              <Link to={returnPath}>
                <ArrowLeft className="size-3.5" strokeWidth={1.5} />
                JMS
              </Link>
            </Button>
          </>
        }
        updatedAt={query.dataUpdatedAt}
        refreshing={query.isFetching}
        onRefresh={refetchAll}
      />

      <PartialBanner failures={failures} onRetry={refetchAll} />

      {query.isFetching && !query.data ? (
        <div className="text-muted-foreground flex h-24 items-center justify-center gap-2 border-b border-border text-[13px]">
          <Loader2 className="size-3 animate-spin" strokeWidth={1.5} />
          Loading...
        </div>
      ) : null}

      {query.isError ? (
        <div className="border-status-negative/60 bg-status-negative/8 flex min-h-10 items-center justify-between gap-3 border px-3 py-2 text-[13px]">
          <span className="min-w-0 truncate font-mono">
            {query.error instanceof Error ? query.error.message : 'Unable to load JMS destination runtime.'}
          </span>
          <Button type="button" variant="ghost" size="sm" onClick={refetchAll}>Retry</Button>
        </div>
      ) : null}

      {!query.isFetching && !query.isError && !row ? (
        <div className="border-border bg-surface-1 flex min-h-28 items-center justify-between gap-3 border px-3 py-3 text-[13px]">
          <div className="min-w-0">
            <div className="font-medium">JMS destination not found</div>
            <MonoText className="text-muted-foreground mt-1 block truncate">
              {serverName || '-'} / {jmsServerName || '-'} / {destinationName || '-'}
            </MonoText>
          </div>
          <Button type="button" variant="outline" size="sm" asChild>
            <Link to={returnPath}>Back to JMS</Link>
          </Button>
        </div>
      ) : null}

      {row ? (
        <div className="space-y-4">
          <div className="grid gap-3 md:grid-cols-4">
            <div className="border-border bg-surface-1 min-h-[72px] border px-3 py-2">
              <div className="text-muted-foreground text-[11px] uppercase leading-[14px] tracking-[0.04em]">Status</div>
              <div className="mt-2">
                <StatusBadge kind="custom" tone={severityTone(row.severity)} label={row.severity} />
              </div>
            </div>
            <Metric label="Runtime" value={row.state ?? '-'} />
            <Metric label="Server" value={row.serverName} />
            <Metric label="JMS Server" value={row.jmsServerName} />
            <Metric label="Type" value={row.destinationType ?? '-'} />
          </div>

          <div className="grid gap-3 md:grid-cols-4">
            <Metric label="Messages" value={formatNumber(row.messagesCurrentCount)} />
            <Metric label="Pending" value={formatNumber(row.messagesPendingCount)} />
            <Metric label="High" value={formatNumber(row.messagesHighCount)} />
            <Metric label="Received" value={formatNumber(row.messagesReceivedCount)} />
            <Metric label="Bytes" value={formatNumber(row.bytesCurrentCount)} />
            <Metric label="Bytes pending" value={formatNumber(row.bytesPendingCount)} />
            <Metric label="Bytes high" value={formatNumber(row.bytesHighCount)} />
            <Metric label="Consumers" value={formatNumber(row.consumersCurrentCount)} detail={`high ${formatNumber(row.consumersHighCount)} · total ${formatNumber(row.consumersTotalCount)}`} />
          </div>

          <PausePanel row={row} onRefresh={refetchAll} />
          <TaskPanel tasks={query.data?.tasks ?? []} />
          <ProducePanel row={row} onProduced={refetchAll} />
          <MessageBrowsePanel serverName={serverName} jmsServerName={jmsServerName} destinationName={destinationName} onRefreshDetail={refetchAll} />
        </div>
      ) : null}
    </>
  )
}
