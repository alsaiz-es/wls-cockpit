import { useEffect, useMemo, useState } from 'react'
import { CheckCircle2, LockKeyhole, RefreshCw, ShieldAlert, XCircle } from 'lucide-react'
import { useIsMutating, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import {
  invalidateEditSessionAffectedQueries,
  runEditSessionAction,
  useEditSessionStatus,
  type EditSessionAction,
  type EditSessionStatus,
} from '@/api/queries/edit-sessions'
import { useAuth } from '@/auth/useAuth'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { ConfirmDialog } from './confirm-dialog'
import { MonoText } from './mono-text'
import { RelativeTime } from './relative-time'
import { StatusBadge, type StatusTone } from './status-badge'

type Feedback = { tone: StatusTone; message: string } | null

function statusTone(status: EditSessionStatus): StatusTone {
  if (status.state === 'conflict') return 'negative'
  if (status.state === 'pending' || status.state === 'locked' || status.state === 'unknown') return 'warning'
  return 'neutral'
}

function statusLabel(status: EditSessionStatus) {
  if (status.state === 'conflict') return 'EDIT CONFLICT'
  if (status.state === 'pending') return 'PENDING CHANGES'
  if (status.state === 'locked') return 'EDIT LOCK'
  return 'EDIT STATE'
}

function pendingLabel(status: EditSessionStatus) {
  if (status.pendingChangeCount !== null) {
    return `${status.pendingChangeCount.toLocaleString()} pending`
  }
  if (status.hasPendingChanges === true) return 'pending changes'
  if (status.hasPendingChanges === false) return 'no pending changes'
  return 'pending unknown'
}

function ownershipLabel(status: EditSessionStatus) {
  if (status.ownership === 'current-user') return 'current user'
  if (status.ownership === 'other-user') return 'other user'
  if (status.ownership === 'unknown') return 'owner unknown'
  return 'unlocked'
}

function actionDescription(action: EditSessionAction, status: EditSessionStatus) {
  if (action === 'activate') {
    return `Activate staged WebLogic changes for edit session ${status.editSession ?? 'default'}.`
  }
  return 'Discard staged WebLogic changes and release the edit lock.'
}

function actionSubject(action: EditSessionAction, status: EditSessionStatus) {
  const owner = status.lockOwner ? `owner ${status.lockOwner}` : 'owner unknown'
  const pending = pendingLabel(status)
  return action === 'activate'
    ? `${pending} · ${owner} · ${status.editSession ?? 'default'}`
    : `${owner} · ${status.editSession ?? 'default'}`
}

export function EditSessionBanner({ readOnlyDemoMode = false }: { readOnlyDemoMode?: boolean }) {
  const { creds } = useAuth()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const query = useEditSessionStatus()
  const status = query.data
  const [confirmAction, setConfirmAction] = useState<EditSessionAction | null>(null)
  const [feedback, setFeedback] = useState<Feedback>(null)
  const [capturePrompt, setCapturePrompt] = useState(false)

  const mutation = useMutation<void, Error, EditSessionAction>({
    mutationFn: async (action) => {
      if (!creds) throw new Error('not authenticated')
      return runEditSessionAction(creds, action)
    },
    onSuccess: (_, action) => {
      setCapturePrompt(action === 'activate')
      setFeedback({
        tone: 'positive',
        message: action === 'activate' ? 'Edit session activated.' : 'Edit session cancelled.',
      })
    },
    onError: (error) => {
      setCapturePrompt(false)
      setFeedback({ tone: 'negative', message: error.message || 'Edit-session action failed.' })
    },
    onSettled: async () => {
      setConfirmAction(null)
      await invalidateEditSessionAffectedQueries(queryClient, creds)
    },
  })

  useEffect(() => {
    if (!feedback) return undefined
    const timeout = window.setTimeout(() => {
      setFeedback(null)
      setCapturePrompt(false)
    }, 8_000)
    return () => window.clearTimeout(timeout)
  }, [feedback])

  const confirmStatus = confirmAction && status ? status : null
  const showStatus = !!status?.visible
  const showError = query.isError
  const showFeedback = !!feedback
  const canShowActions = !!status && !readOnlyDemoMode && status.visible
  // Activating or cancelling while a page is applying its own change would race that change's
  // own startEdit/activate, so the actions wait for every mutation in the app, not only this one.
  const mutationsInFlight = useIsMutating()
  const pending = mutation.isPending || mutationsInFlight > 0

  const actionButtons = useMemo(() => {
    if (!canShowActions || !status) return null
    const showActivate = status.hasPendingChanges !== false || status.pendingChangeCount !== null

    return (
      <div className="ml-auto flex shrink-0 items-center gap-2">
        {showActivate ? (
          <Button
            type="button"
            size="xs"
            variant="secondary"
            disabled={!status.canActivate || pending}
            onClick={() => setConfirmAction('activate')}
          >
            <CheckCircle2 className="size-3" strokeWidth={1.5} />
            Activate
          </Button>
        ) : null}
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={!status.canCancel || pending}
          onClick={() => setConfirmAction('cancel')}
        >
          <XCircle className="size-3" strokeWidth={1.5} />
          Cancel
        </Button>
      </div>
    )
  }, [canShowActions, pending, status])

  if (!showStatus && !showError && !showFeedback) return null

  return (
    <>
      <section
        aria-label="Edit session status"
        className={cn(
          'mb-4 flex min-h-10 min-w-0 items-center gap-3 border px-3 py-2 text-[13px] leading-[18px]',
          showError
            ? 'border-status-negative/35 bg-status-negative/8'
            : feedback?.tone === 'positive'
              ? 'border-status-positive/35 bg-status-positive/8'
              : 'border-status-warning/35 bg-status-warning/8',
        )}
      >
        {showError ? (
          <>
            <ShieldAlert className="text-status-negative size-4 shrink-0" strokeWidth={1.5} />
            <StatusBadge kind="custom" tone="negative" label="EDIT STATUS ERROR" />
            <span className="min-w-0 truncate text-muted-foreground">
              {query.error instanceof Error ? query.error.message : 'Edit-session status unavailable.'}
            </span>
          </>
        ) : showStatus && status ? (
          <>
            <LockKeyhole className="text-status-warning size-4 shrink-0" strokeWidth={1.5} />
            <StatusBadge kind="custom" tone={statusTone(status)} label={statusLabel(status)} />
            <span className="min-w-0 text-muted-foreground">
              owner{' '}
              <MonoText className="text-foreground">
                {status.ownerEvidence ?? '–'}
              </MonoText>
            </span>
            <span className="hidden text-subtle-foreground sm:inline">·</span>
            <MonoText className="text-muted-foreground">{ownershipLabel(status)}</MonoText>
            <span className="hidden text-subtle-foreground sm:inline">·</span>
            <MonoText className="text-muted-foreground">{pendingLabel(status)}</MonoText>
            <span className="hidden text-subtle-foreground md:inline">·</span>
            <span className="hidden items-center gap-1 text-subtle-foreground md:inline-flex">
              <RefreshCw className={cn('size-3', query.isFetching ? 'animate-spin' : '')} strokeWidth={1.5} />
              <RelativeTime value={query.dataUpdatedAt || status.fetchedAt} />
            </span>
            {feedback ? (
              <>
                <span className="hidden text-subtle-foreground lg:inline">·</span>
                <StatusBadge kind="custom" tone={feedback.tone} label={feedback.message} className="hidden lg:inline-flex" />
                {capturePrompt ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    onClick={() => {
                      setCapturePrompt(false)
                      navigate('/config-snapshots?capture=1')
                    }}
                  >
                    Config snapshot
                  </Button>
                ) : null}
              </>
            ) : null}
            {actionButtons}
          </>
        ) : feedback ? (
          <>
            <StatusBadge kind="custom" tone={feedback.tone} label={feedback.message} />
            <span className="text-muted-foreground">Edit-session status refreshed.</span>
            {capturePrompt ? (
              <Button
                type="button"
                size="xs"
                variant="ghost"
                onClick={() => {
                  setCapturePrompt(false)
                  navigate('/config-snapshots?capture=1')
                }}
              >
                Config snapshot
              </Button>
            ) : null}
          </>
        ) : null}
      </section>

      {confirmAction && confirmStatus ? (
        <ConfirmDialog
          open
          title={confirmAction === 'activate' ? 'Activate edit session?' : 'Cancel edit session?'}
          description={actionDescription(confirmAction, confirmStatus)}
          subject={actionSubject(confirmAction, confirmStatus)}
          confirmLabel={confirmAction === 'activate' ? 'Activate' : 'Cancel session'}
          pending={pending}
          onCancel={() => {
            if (!pending) setConfirmAction(null)
          }}
          onConfirm={() => mutation.mutate(confirmAction)}
        />
      ) : null}
    </>
  )
}
