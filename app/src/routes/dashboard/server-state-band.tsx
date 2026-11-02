import { MonoText } from '@/components'

export function ServerStateBand({
  running,
  warning,
  stopped,
  failed,
  unknown,
  total,
}: {
  running: number
  warning: number
  stopped: number
  failed: number
  unknown: number
  total: number
}) {
  const segments = [
    ['RUNNING', running, 'bg-status-positive'],
    ['WARN', warning, 'bg-status-warning'],
    ['FAILED', failed, 'bg-status-negative'],
    ['SHUTDOWN', stopped, 'bg-status-neutral'],
    ['UNKNOWN', unknown, 'bg-status-unknown'],
  ] as const

  return (
    <div className="space-y-3">
      <div className="flex h-2 overflow-hidden rounded-[3px] bg-surface-2">
        {segments.map(([label, value, className]) =>
          value > 0 ? (
            <span
              key={label}
              className={className}
              style={{ width: `${(value / Math.max(total, 1)) * 100}%` }}
              title={`${label}: ${value}`}
            />
          ) : null,
        )}
      </div>
      <div className="grid grid-cols-5 gap-2">
        {segments.map(([label, value]) => (
          <div key={label} className="min-w-0">
            <div className="text-muted-foreground truncate text-[11px] uppercase tracking-[0.04em]">{label}</div>
            <MonoText className="text-[16px] font-semibold tabular-nums">{value.toLocaleString()}</MonoText>
          </div>
        ))}
      </div>
    </div>
  )
}
