import { useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react'
import { useAuth } from '@/auth/useAuth'
import { invalidateEditSessionAffectedQueries } from '@/api/queries/edit-sessions'
import {
  SERVER_DEBUG_GROUPS,
  invalidateServerDebug,
  serverDebugFlagLabel,
  serverDebugPatch,
  updateServerDebugFlags,
  useServerDebug,
} from '@/api/queries/server-debug'
import { ConfirmDialog, MonoText, StatusBadge } from '@/components'
import { Button } from '@/components/ui/button'
import { debugChangeSummary, debugFlagsEditable } from './server-debug-model'

export function ServerDebugTab({ serverName, readOnlyDemoMode }: { serverName: string; readOnlyDemoMode: boolean }) {
  const { creds } = useAuth()
  const queryClient = useQueryClient()
  const query = useServerDebug(serverName)
  const snapshot = query.data ?? null
  const [draft, setDraft] = useState<Record<string, boolean>>({})
  const [confirming, setConfirming] = useState<Record<string, boolean> | null>(null)
  const [feedback, setFeedback] = useState<{ tone: 'positive' | 'negative'; message: string } | null>(null)
  const editable = debugFlagsEditable(snapshot, { readOnlyDemoMode })
  const patch = useMemo(() => (snapshot ? serverDebugPatch(snapshot, draft) : {}), [draft, snapshot])
  const pendingCount = Object.keys(patch).length
  const otherEnabled = useMemo(() => {
    const curated = new Set(SERVER_DEBUG_GROUPS.flatMap((group) => group.flags.map((flag) => flag.attribute)))
    return (snapshot?.enabled ?? []).filter((attribute) => !curated.has(attribute))
  }, [snapshot?.enabled])

  const mutation = useMutation({
    mutationFn: async (changes: Record<string, boolean>) => {
      if (!creds || !snapshot) throw new Error('not authenticated')
      return updateServerDebugFlags(creds, snapshot, changes)
    },
    onSuccess: async (result) => {
      setFeedback({ tone: 'positive', message: `${result.operation}. Activated.` })
      setDraft({})
      setConfirming(null)
      await Promise.all([
        invalidateServerDebug(queryClient, creds, serverName),
        invalidateEditSessionAffectedQueries(queryClient, creds),
      ])
    },
    onError: (error) => {
      setFeedback({ tone: 'negative', message: error instanceof Error ? error.message : 'Debug flag change failed.' })
      setConfirming(null)
    },
  })

  const flagValue = (attribute: string) => draft[attribute] ?? snapshot?.flags[attribute] ?? false

  if (query.isLoading) {
    return <div className="text-muted-foreground text-[13px]">Loading debug flags…</div>
  }
  if (query.isError || !snapshot) {
    return (
      <div className="border-status-negative/50 bg-status-negative/8 flex items-center justify-between gap-3 border px-3 py-2 text-[13px]">
        <span>{query.error instanceof Error ? query.error.message : 'Unable to load debug flags.'}</span>
        <Button type="button" variant="ghost" size="sm" onClick={() => void query.refetch()}>
          Retry
        </Button>
      </div>
    )
  }

  const allOff = Object.fromEntries(snapshot.enabled.map((attribute) => [attribute, false]))

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted-foreground max-w-[720px] text-[13px] leading-[18px]">
          Debug flags of <MonoText>{serverName}</MonoText>. Changes are activated at once and most take effect without a
          restart; turn them off when you are done, as they make the server log grow fast.
        </p>
        <Button type="button" variant="ghost" size="sm" onClick={() => void query.refetch()}>
          <RefreshCw className="size-3.5" strokeWidth={1.5} />
          Refresh
        </Button>
      </div>

      {snapshot.debugReachesLog === false ? (
        <div className="border-status-warning/60 bg-status-warning/8 flex items-start gap-2 border px-3 py-2 text-[13px]">
          <AlertTriangle className="text-status-warning mt-0.5 size-3.5 shrink-0" strokeWidth={1.5} aria-hidden />
          <span>
            The minimum severity to log is <MonoText>{snapshot.loggerSeverity}</MonoText>, so debug output does not reach
            the server log. Set it to <MonoText>Debug</MonoText> in the Configuration tab (Log) while you debug.
          </span>
        </div>
      ) : null}

      <section className="border-border bg-surface-1 border px-3 py-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2 text-[13px]">
            <span className="text-muted-foreground text-[11px] uppercase tracking-[0.04em]">Enabled now</span>
            {snapshot.enabled.length === 0 ? (
              <StatusBadge kind="custom" tone="positive" label="None" />
            ) : (
              snapshot.enabled.map((attribute) => (
                <StatusBadge key={attribute} kind="custom" tone="warning" label={serverDebugFlagLabel(attribute)} />
              ))
            )}
          </div>
          {editable && snapshot.enabled.length > 0 ? (
            <Button type="button" variant="outline" size="sm" disabled={mutation.isPending} onClick={() => setConfirming(allOff)}>
              Turn all off
            </Button>
          ) : null}
        </div>
        {otherEnabled.length > 0 ? (
          <p className="text-muted-foreground mt-1 text-[12px]">
            Also enabled outside the lists below: {otherEnabled.map((attribute) => attribute).join(', ')}.
          </p>
        ) : null}
      </section>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {SERVER_DEBUG_GROUPS.map((group) => (
          <section key={group.id} className="border-border border px-3 py-2">
            <h3 className="text-muted-foreground mb-1 text-[11px] uppercase tracking-[0.04em]">{group.label}</h3>
            {group.flags
              .filter((flag) => flag.attribute in snapshot.flags)
              .map((flag) => (
                <label key={flag.attribute} className="flex h-7 items-center gap-2 text-[13px]" title={flag.attribute}>
                  <input
                    type="checkbox"
                    className="accent-primary size-3.5"
                    checked={flagValue(flag.attribute)}
                    disabled={!editable || mutation.isPending}
                    onChange={(event) => {
                      const checked = event.target.checked
                      setDraft((current) => ({ ...current, [flag.attribute]: checked }))
                    }}
                  />
                  {flag.label}
                </label>
              ))}
          </section>
        ))}
      </div>

      {editable ? (
        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" disabled={pendingCount === 0 || mutation.isPending} onClick={() => setDraft({})}>
            Discard
          </Button>
          <Button type="button" size="sm" disabled={pendingCount === 0 || mutation.isPending} onClick={() => setConfirming(patch)}>
            {mutation.isPending ? <Loader2 className="size-3.5 animate-spin" strokeWidth={1.5} /> : null}
            Apply {pendingCount > 0 ? `(${pendingCount})` : ''}
          </Button>
        </div>
      ) : null}

      {feedback ? (
        <div
          className={
            feedback.tone === 'positive'
              ? 'border-status-positive/50 bg-status-positive/8 border px-3 py-2 text-[13px]'
              : 'border-status-negative/50 bg-status-negative/8 border px-3 py-2 text-[13px]'
          }
        >
          {feedback.message}
        </div>
      ) : null}

      <ConfirmDialog
        open={!!confirming}
        title="Change debug flags"
        description={`Starts an edit session, sets ${confirming ? debugChangeSummary(confirming) : ''} and activates it.`}
        subject={serverName}
        confirmLabel="Apply"
        pending={mutation.isPending}
        onConfirm={() => confirming && mutation.mutate(confirming)}
        onCancel={() => setConfirming(null)}
      />
    </div>
  )
}
