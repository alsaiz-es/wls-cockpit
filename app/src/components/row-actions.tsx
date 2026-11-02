import { Loader2, MoreHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

export interface RowAction {
  key: string
  label: string
  ariaLabel: string
  onSelect: () => void
  destructive?: boolean
  pending?: boolean
  pendingLabel?: string
  // Starts a new group in the overflow menu.
  separatorBefore?: boolean
}

export interface RowActionsProps {
  // Shown as a button; the rest go into the "…" menu so the column stays narrow at 1440 px.
  primary?: RowAction | null
  more: RowAction[]
  moreLabel: string
  disabled?: boolean
}

export function RowActions({ primary, more, moreLabel, disabled = false }: RowActionsProps) {
  const morePending = more.some((action) => action.pending)
  return (
    <div className="flex justify-end gap-1">
      {primary ? (
        <Button
          type="button"
          variant={primary.destructive ? 'destructive' : 'secondary'}
          size="xs"
          disabled={disabled}
          aria-label={primary.ariaLabel}
          onClick={primary.onSelect}
        >
          {primary.pending ? <Loader2 className="size-3 animate-spin" strokeWidth={1.5} /> : null}
          {primary.pending ? (primary.pendingLabel ?? primary.label) : primary.label}
        </Button>
      ) : null}
      {more.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="xs" disabled={disabled} aria-label={moreLabel} title={moreLabel}>
              {morePending ? (
                <Loader2 className="size-3 animate-spin" strokeWidth={1.5} />
              ) : (
                <MoreHorizontal className="size-3.5" strokeWidth={1.5} />
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44">
            {more.map((action) => (
              <RowActionMenuItem key={action.key} action={action} />
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  )
}

function RowActionMenuItem({ action }: { action: RowAction }) {
  return (
    <>
      {action.separatorBefore ? <DropdownMenuSeparator /> : null}
      <DropdownMenuItem
        variant={action.destructive ? 'destructive' : 'default'}
        aria-label={action.ariaLabel}
        onSelect={action.onSelect}
        className="text-[13px]"
      >
        {action.pending ? <Loader2 className="size-3 animate-spin" strokeWidth={1.5} /> : null}
        {action.pending ? (action.pendingLabel ?? action.label) : action.label}
      </DropdownMenuItem>
    </>
  )
}
