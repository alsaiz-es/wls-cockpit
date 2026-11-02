import { useEffect, useMemo, useRef, useState } from 'react'
import { Bell, CheckCheck, Monitor, MonitorOff, Trash2, X } from 'lucide-react'
import { Link } from 'react-router-dom'
import {
  acknowledgeActiveLocalAlerts,
  activeLocalAlertCount,
  clearRecoveredLocalAlerts,
  dismissLocalAlertToast,
  markLocalAlertsRead,
  setDesktopLocalAlertsEnabled,
  unacknowledgedLocalAlertCount,
  unreadLocalAlertCount,
  useLocalAlertSnapshot,
  type LocalAlertEvent,
  type LocalAlertSeverity,
  type LocalAlertToast,
} from '@/api/queries/local-alerts'
import { cn } from '@/lib/utils'
import { Button } from './ui/button'
import { MonoText } from './mono-text'
import { RelativeTime } from './relative-time'

function severityClass(severity: LocalAlertSeverity) {
  if (severity === 'critical') return 'border-status-negative/70 bg-status-negative/10 text-status-negative'
  if (severity === 'warning') return 'border-status-warning/70 bg-status-warning/10 text-status-warning'
  return 'border-status-positive/70 bg-status-positive/10 text-status-positive'
}

function dotClass(severity: LocalAlertSeverity) {
  if (severity === 'critical') return 'bg-status-negative'
  if (severity === 'warning') return 'bg-status-warning'
  return 'bg-status-positive'
}

function desktopLabel(state: ReturnType<typeof useLocalAlertSnapshot>['desktopNotifications']) {
  if (!state.supported) return 'Desktop unavailable'
  if (state.permission === 'denied') return 'Desktop denied'
  if (state.enabled) return 'Desktop on'
  return 'Desktop off'
}

function eventPrimaryLabel(event: LocalAlertEvent) {
  if (event.aggregate) return event.title
  return event.resourceLabels[0] ?? event.title
}

function eventDetail(event: LocalAlertEvent) {
  if (event.aggregate) return event.detail
  const primary = eventPrimaryLabel(event)
  const suffix = event.title.startsWith(primary) ? event.title.slice(primary.length).trim() : event.title
  return suffix ? `${suffix} · ${event.detail}` : event.detail
}

function maxActiveSeverity(state: ReturnType<typeof useLocalAlertSnapshot>) {
  const active = Object.values(state.activeConditions)
  if (active.some((item) => item.condition.severity === 'critical')) return 'critical'
  if (active.some((item) => item.condition.severity === 'warning')) return 'warning'
  return 'info'
}

function maxUnacknowledgedSeverity(state: ReturnType<typeof useLocalAlertSnapshot>) {
  const active = Object.values(state.activeConditions).filter((item) => item.acknowledgedAt == null)
  if (active.some((item) => item.condition.severity === 'critical')) return 'critical'
  if (active.some((item) => item.condition.severity === 'warning')) return 'warning'
  return 'info'
}

function badgeClass(severity: LocalAlertSeverity) {
  if (severity === 'critical') return 'bg-status-negative'
  if (severity === 'warning') return 'bg-status-warning'
  return 'bg-status-neutral'
}

function AlertEventRow({ event, onNavigate }: { event: LocalAlertEvent; onNavigate: () => void }) {
  const primaryLabel = eventPrimaryLabel(event)
  const detail = eventDetail(event)
  const title = (
    <span className="flex min-w-0 items-center gap-2">
      <span className={cn('size-1.5 shrink-0 rounded-full', dotClass(event.severity))} aria-hidden />
      <span className="truncate font-medium" title={primaryLabel}>{primaryLabel}</span>
    </span>
  )

  return (
    <li className={cn('border-l-2 px-3 py-2', event.read ? 'border-border' : severityClass(event.severity))}>
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          {event.route ? (
            <Link
              to={event.route}
              onClick={onNavigate}
              className="hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {title}
            </Link>
          ) : title}
          <p className="text-muted-foreground mt-1 truncate text-[12px] leading-[16px]" title={detail}>
            {detail}
          </p>
        </div>
        <RelativeTime value={event.timestamp} className="text-xs text-muted-foreground" />
      </div>
    </li>
  )
}

function LocalAlertToastItem({ toast }: { toast: LocalAlertToast }) {
  useEffect(() => {
    const timeout = window.setTimeout(() => dismissLocalAlertToast(toast.id), toast.autoDismissMs)
    return () => window.clearTimeout(timeout)
  }, [toast.autoDismissMs, toast.id])

  return (
    <div className={cn('border bg-background px-3 py-2 shadow-lg', severityClass(toast.severity))}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-medium leading-[18px]">{toast.title}</div>
          <div className="text-muted-foreground mt-1 line-clamp-2 text-[12px] leading-[16px]">{toast.detail}</div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Dismiss alert toast"
          onClick={() => dismissLocalAlertToast(toast.id)}
          className="shrink-0"
        >
          <X className="size-3" strokeWidth={1.5} />
        </Button>
      </div>
    </div>
  )
}

function LocalAlertToastStack({ toasts }: { toasts: LocalAlertToast[] }) {
  const visibleToasts = toasts.slice(0, 3)
  if (visibleToasts.length === 0) return null

  return (
    <div className="fixed bottom-4 right-4 z-50 w-[380px] max-w-[calc(100vw-2rem)] space-y-2">
      {visibleToasts.map((toast) => (
        <LocalAlertToastItem key={toast.id} toast={toast} />
      ))}
    </div>
  )
}

export function LocalAlertsWidget() {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(false)
  const state = useLocalAlertSnapshot()
  const activeCount = activeLocalAlertCount(state)
  const unacknowledgedCount = unacknowledgedLocalAlertCount(state)
  const activeSeverity = maxActiveSeverity(state)
  const unacknowledgedSeverity = maxUnacknowledgedSeverity(state)
  const unreadCount = unreadLocalAlertCount(state)
  const recoveredCount = state.log.filter((event) => event.kind === 'recovery').length
  const log = useMemo(() => state.log.slice(0, 40), [state.log])
  const desktopDisabled = !state.desktopNotifications.supported || state.desktopNotifications.permission === 'denied'

  useEffect(() => {
    if (!open) return
    function onMouseDown(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [open])

  useEffect(() => {
    if (open && unreadCount > 0) markLocalAlertsRead()
  }, [open, unreadCount])

  return (
    <>
      <div ref={rootRef} className="relative">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Local runtime alerts"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="relative"
        >
          <Bell
            className={cn(
              'size-4',
              unacknowledgedCount > 0 && unacknowledgedSeverity === 'critical' && 'text-status-negative',
              unacknowledgedCount > 0 && unacknowledgedSeverity === 'warning' && 'text-status-warning',
              unacknowledgedCount === 0 && activeCount > 0 && activeSeverity !== 'info' && 'text-muted-foreground',
            )}
            strokeWidth={1.5}
          />
          {unacknowledgedCount > 0 ? (
            <span className={cn('text-background absolute -right-1 -top-1 inline-flex min-w-4 items-center justify-center rounded-[4px] px-1 text-[10px] font-medium leading-4', badgeClass(unacknowledgedSeverity))}>
              {unacknowledgedCount > 99 ? '99+' : unacknowledgedCount}
            </span>
          ) : null}
        </Button>

        {open ? (
          <div className="absolute right-0 top-9 z-50 w-[440px] border border-border bg-surface-2 shadow-xl">
            <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
              <div className="min-w-0">
                <div className="text-[13px] font-medium leading-[18px]">Local Alerts</div>
                <div className="text-muted-foreground text-[12px] leading-[16px]">
                  <MonoText>{activeCount}</MonoText> active · <MonoText>{unacknowledgedCount}</MonoText> unack · <MonoText>{unreadCount}</MonoText> unread
                </div>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Acknowledge active local alerts"
                  title={unacknowledgedCount > 0 ? `Acknowledge ${unacknowledgedCount} active local alerts` : 'No unacknowledged active local alerts'}
                  disabled={unacknowledgedCount === 0}
                  onClick={() => acknowledgeActiveLocalAlerts()}
                >
                  <CheckCheck className="size-3" strokeWidth={1.5} />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Clear recovered local alerts"
                  title={recoveredCount > 0 ? `Clear ${recoveredCount} recovered local alerts only` : 'No recovered local alerts to clear'}
                  disabled={recoveredCount === 0}
                  onClick={clearRecoveredLocalAlerts}
                >
                  <Trash2 className="size-3" strokeWidth={1.5} />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={desktopDisabled}
                  onClick={() => void setDesktopLocalAlertsEnabled(!state.desktopNotifications.enabled)}
                >
                  {state.desktopNotifications.enabled ? (
                    <Monitor className="size-3.5" strokeWidth={1.5} />
                  ) : (
                    <MonitorOff className="size-3.5" strokeWidth={1.5} />
                  )}
                  {desktopLabel(state.desktopNotifications)}
                </Button>
              </div>
            </div>

            {log.length === 0 ? (
              <div className="text-muted-foreground px-3 py-6 text-center text-[13px]">No local alerts in this session.</div>
            ) : (
              <ul className="max-h-[420px] divide-y divide-border overflow-auto">
                {log.map((event) => (
                  <AlertEventRow key={event.id} event={event} onNavigate={() => setOpen(false)} />
                ))}
              </ul>
            )}
          </div>
        ) : null}
      </div>

      <LocalAlertToastStack toasts={state.toasts} />
    </>
  )
}
