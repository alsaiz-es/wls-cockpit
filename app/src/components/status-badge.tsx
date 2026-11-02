/* eslint-disable react-refresh/only-export-components */
import { AlertTriangle, Circle, CircleX } from 'lucide-react'
import { cn } from '@/lib/utils'
import { MonoText } from './mono-text'
import { healthTone, lifecycleTone, type StatusTone, type WlsHealthState, type WlsLifecycleState } from './status-model'
export {
  STATUS_TONES,
  WLS_HEALTH_STATES,
  WLS_LIFECYCLE_STATES,
  healthTone,
  lifecycleTone,
} from './status-model'
export type { StatusTone, WlsHealthState, WlsLifecycleState } from './status-model'

export type StatusBadgeProps =
  | { kind: 'wls-state'; value: WlsLifecycleState; className?: string }
  | { kind: 'wls-health'; value: WlsHealthState; className?: string }
  | { kind: 'custom'; tone: StatusTone; label: string; className?: string }

const toneClasses: Record<StatusTone, string> = {
  positive: 'text-status-positive',
  warning: 'text-status-warning',
  negative: 'text-status-negative',
  neutral: 'text-status-neutral',
  unknown: 'text-status-unknown italic',
}

function badgeModel(props: StatusBadgeProps) {
  if (props.kind === 'custom') {
    return { tone: props.tone, label: props.label }
  }
  if (props.kind === 'wls-state') {
    return { tone: lifecycleTone(props.value), label: props.value }
  }
  return { tone: healthTone(props.value), label: props.value }
}

function StatusGlyph({ tone }: { tone: StatusTone }) {
  if (tone === 'warning') return <AlertTriangle aria-hidden className="size-3" strokeWidth={1.5} />
  if (tone === 'negative') return <CircleX aria-hidden className="size-3" strokeWidth={1.5} />
  return <Circle aria-hidden className="size-2 fill-current" strokeWidth={1.5} />
}

export function StatusBadge(props: StatusBadgeProps) {
  const { tone, label } = badgeModel(props)

  return (
    <span
      className={cn(
        'inline-flex min-w-0 items-center gap-1 whitespace-nowrap text-[11px] leading-[14px]',
        toneClasses[tone],
        props.className,
      )}
    >
      <StatusGlyph tone={tone} />
      <MonoText className="min-w-0 truncate uppercase tracking-[0.05em]" title={label}>
        {label}
      </MonoText>
    </span>
  )
}

// Marks a server whose activated configuration changes wait for its next restart.
export function RestartRequiredBadge({ className }: { className?: string }) {
  return (
    <span title="Activated configuration changes take effect after this server restarts.">
      <StatusBadge kind="custom" tone="warning" label="Restart required" className={className} />
    </span>
  )
}
