import { useMemo, useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useLocation } from 'react-router-dom'
import { RefreshCw, UserRoundCheck } from 'lucide-react'
import { useAuth } from '@/auth/useAuth'
import { readOnlyDemoModeEnabled } from '@/api/runtime-config'
import {
  clearUserLockout,
  normalizeLockoutUserName,
  userLockoutQueryKey,
  useUserLockoutSnapshot,
  type ClearLockoutResult,
  type UserLockoutServerRow,
} from '@/api/queries/user-lockout'
import {
  ConfirmDialog,
  DataTable,
  MonoText,
  PageHeader,
  RelativeTime,
  StatusBadge,
  type DataTableColumn,
} from '@/components'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { detailReturnState } from './detail-return-state'
import { lockoutClearServers, lockoutRowTone } from './security-model'

function formatCount(value: number | null) {
  return value === null ? '-' : value.toLocaleString()
}

function ClearResults({ userName, results }: { userName: string; results: ClearLockoutResult[] }) {
  const failed = results.filter((result) => !result.ok)
  return (
    <div
      className={
        failed.length > 0
          ? 'border-status-warning/60 bg-status-warning/8 mt-3 border px-3 py-2 text-[13px]'
          : 'border-status-positive/50 bg-status-positive/8 mt-3 border px-3 py-2 text-[13px]'
      }
    >
      <div className="font-medium">
        {failed.length === 0
          ? `Lockout of ${userName} cleared on ${results.length} server${results.length === 1 ? '' : 's'}.`
          : `Lockout of ${userName} cleared on ${results.length - failed.length} of ${results.length} servers.`}
      </div>
      {failed.map((result) => (
        <div key={result.serverName} className="text-muted-foreground mt-1">
          <MonoText>{result.serverName}</MonoText>: {result.message}
        </div>
      ))}
    </div>
  )
}

function ClearLockoutForm({ rows, readOnlyDemoMode }: { rows: UserLockoutServerRow[]; readOnlyDemoMode: boolean }) {
  const { creds } = useAuth()
  const queryClient = useQueryClient()
  const [userName, setUserName] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [outcome, setOutcome] = useState<{ userName: string; results: ClearLockoutResult[] } | null>(null)
  const servers = lockoutClearServers(rows, { readOnlyDemoMode })
  const name = normalizeLockoutUserName(userName)

  const mutation = useMutation({
    mutationFn: async (target: string) => {
      if (!creds) throw new Error('not authenticated')
      return { userName: target, results: await clearUserLockout(creds, target, servers) }
    },
    onSuccess: async (result) => {
      setOutcome(result)
      setConfirming(false)
      await queryClient.invalidateQueries({ queryKey: userLockoutQueryKey(creds) })
    },
    onError: (error) => {
      setOutcome({
        userName: name,
        results: [{ serverName: 'Cockpit', ok: false, message: error instanceof Error ? error.message : 'Clear lockout failed.' }],
      })
      setConfirming(false)
    },
  })

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (name && servers.length > 0) setConfirming(true)
  }

  return (
    <section className="border-border bg-surface-1 mt-4 border px-3 py-3">
      <h2 className="text-[13px] font-medium leading-[18px]">Unlock a user</h2>
      <p className="text-muted-foreground mt-0.5 text-[13px] leading-[18px]">
        WebLogic does not list locked user names. Enter the user to clear its lockout on every running server.
      </p>
      <form className="mt-3 flex flex-wrap items-center gap-2" onSubmit={submit}>
        <Input
          aria-label="User name to unlock"
          placeholder="User name"
          value={userName}
          onChange={(event) => setUserName(event.target.value)}
          className="h-8 w-[260px] rounded-[4px] font-mono text-[13px]"
          autoComplete="off"
          spellCheck={false}
        />
        <Button type="submit" variant="secondary" size="sm" disabled={!name || servers.length === 0 || mutation.isPending}>
          <UserRoundCheck className="size-3.5" strokeWidth={1.5} />
          Clear lockout
        </Button>
        {servers.length === 0 ? <span className="text-muted-foreground text-[13px]">No running server reports user lockout.</span> : null}
      </form>
      {outcome ? <ClearResults userName={outcome.userName} results={outcome.results} /> : null}
      <ConfirmDialog
        open={confirming}
        title="Clear user lockout"
        description={`Clears the lockout of this user on ${servers.length} running server${servers.length === 1 ? '' : 's'}: ${servers.join(', ')}. The user can sign in again at once.`}
        subject={name}
        confirmLabel="Clear lockout"
        pending={mutation.isPending}
        onConfirm={() => mutation.mutate(name)}
        onCancel={() => setConfirming(false)}
      />
    </section>
  )
}

export function Security() {
  const location = useLocation()
  const query = useUserLockoutSnapshot()
  const readOnlyDemoMode = readOnlyDemoModeEnabled()
  const returnState = useMemo(() => detailReturnState(location), [location])
  const rows = useMemo(() => query.data?.rows ?? [], [query.data?.rows])
  const locked = query.data?.lockedUsersCurrentCount ?? 0

  const columns = useMemo<DataTableColumn<UserLockoutServerRow>[]>(
    () => [
      {
        id: 'server',
        header: 'SERVER',
        className: 'min-w-[180px]',
        cell: (row) => (
          <Link
            to={`/servers/${encodeURIComponent(row.serverName)}`}
            state={returnState}
            className="hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <MonoText className="block truncate font-medium" title={row.serverName}>
              {row.serverName}
            </MonoText>
          </Link>
        ),
      },
      {
        id: 'state',
        header: 'STATE',
        cell: (row) => <StatusBadge kind="wls-state" value={row.lifecycleState} />,
      },
      {
        id: 'locked',
        header: 'LOCKED NOW',
        align: 'right',
        className: 'font-mono tabular-nums',
        cell: (row) => {
          const tone = lockoutRowTone(row)
          if (row.error) return <span className="text-status-unknown italic" title={row.error}>unavailable</span>
          return <span className={tone === 'warning' ? 'text-status-warning' : undefined}>{formatCount(row.lockedUsersCurrentCount)}</span>
        },
      },
      {
        id: 'lockouts',
        header: 'LOCKOUTS',
        align: 'right',
        className: 'font-mono tabular-nums',
        cell: (row) => formatCount(row.userLockoutTotalCount),
      },
      {
        id: 'invalid',
        header: 'INVALID LOGINS',
        align: 'right',
        className: 'font-mono tabular-nums',
        cell: (row) => formatCount(row.invalidLoginAttemptsTotalCount),
      },
      {
        id: 'whileLocked',
        header: 'TRIES WHILE LOCKED',
        align: 'right',
        className: 'font-mono tabular-nums',
        cell: (row) => formatCount(row.loginAttemptsWhileLockedTotalCount),
      },
      {
        id: 'unlocked',
        header: 'UNLOCKED',
        align: 'right',
        className: 'font-mono tabular-nums',
        cell: (row) => formatCount(row.unlockedUsersTotalCount),
      },
    ],
    [returnState],
  )

  return (
    <>
      <PageHeader
        title="Security"
        subtitle="User lockout per server, counted since each server started."
        meta={
          <div className="flex w-full items-center justify-between gap-3">
            <span className="text-muted-foreground flex items-center gap-2 text-[13px] leading-[18px]">
              {locked > 0 ? (
                <StatusBadge kind="custom" tone="warning" label={`${locked} locked`} />
              ) : query.data ? (
                <StatusBadge kind="custom" tone="positive" label="No locked users" />
              ) : null}
              <span>
                Updated <RelativeTime value={query.dataUpdatedAt} />
              </span>
            </span>
            <Button type="button" variant="ghost" size="sm" onClick={() => void query.refetch()}>
              <RefreshCw className="size-3.5" strokeWidth={1.5} />
              Refresh
            </Button>
          </div>
        }
      />

      <DataTable
        columns={columns}
        rows={rows}
        getRowId={(row) => row.serverName}
        loading={query.isFetching}
        error={
          query.isError
            ? {
                message: query.error instanceof Error ? query.error.message : 'Unable to load user lockout data.',
                retry: () => void query.refetch(),
              }
            : null
        }
        empty="No servers reported."
      />

      {readOnlyDemoMode ? null : <ClearLockoutForm rows={rows} readOnlyDemoMode={readOnlyDemoMode} />}
    </>
  )
}
