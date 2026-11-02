import { ArrowDown, ArrowUp, ArrowUpDown, Loader2 } from 'lucide-react'
import { type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export type SortDirection = 'asc' | 'desc'

export interface DataTableSort {
  columnId: string
  direction: SortDirection
}

export interface DataTableColumn<T> {
  id: string
  header: ReactNode
  cell: (row: T) => ReactNode
  sortable?: boolean
  align?: 'left' | 'right' | 'center'
  className?: string
  headerClassName?: string
  // Keeps the column visible while wide tables scroll horizontally (row actions).
  sticky?: 'right'
}

const STICKY_RIGHT_CLASS = 'sticky right-0 border-l border-border bg-background'

export interface DataTableError {
  message: string
  retry?: () => void
}

export interface DataTableEmpty {
  message: string
  hint?: string
  action?: ReactNode
}

export interface DataTableProps<T> {
  columns: DataTableColumn<T>[]
  rows: T[]
  getRowId: (row: T) => string
  sort?: DataTableSort | null
  onSortChange?: (sort: DataTableSort | null) => void
  loading: boolean
  error?: DataTableError | string | null
  empty?: DataTableEmpty | string
  className?: string
}

function alignClass(align: DataTableColumn<unknown>['align']) {
  if (align === 'right') return 'text-right'
  if (align === 'center') return 'text-center'
  return 'text-left'
}

function nextSort(current: DataTableSort | null | undefined, columnId: string): DataTableSort | null {
  if (!current || current.columnId !== columnId) return { columnId, direction: 'asc' }
  if (current.direction === 'asc') return { columnId, direction: 'desc' }
  return null
}

function errorMessage(error: DataTableProps<unknown>['error']) {
  if (!error) return null
  return typeof error === 'string' ? error : error.message
}

function errorRetry(error: DataTableProps<unknown>['error']) {
  return error && typeof error !== 'string' ? error.retry : undefined
}

function emptyModel(empty: DataTableProps<unknown>['empty']) {
  if (!empty) return { message: 'No rows reported.' }
  return typeof empty === 'string' ? { message: empty } : empty
}

export function DataTable<T>({
  columns,
  rows,
  getRowId,
  sort,
  onSortChange,
  loading,
  error,
  empty,
  className,
}: DataTableProps<T>) {
  const message = errorMessage(error)
  const retry = errorRetry(error)
  const isFirstLoad = loading && rows.length === 0
  const isInitialError = !!message && !loading && rows.length === 0
  const model = emptyModel(empty)

  return (
    <div className={cn('space-y-3', className)}>
      {message ? (
        <div className="border-status-negative/60 bg-status-negative/8 flex min-h-10 items-center justify-between gap-3 border px-3 py-2 text-[13px]">
          <span className={cn('min-w-0 truncate', /HTTP|\d{3}|Error|error/.test(message) && 'font-mono')}>
            {message}
          </span>
          {retry ? (
            <Button type="button" variant="ghost" size="sm" onClick={retry}>
              Retry
            </Button>
          ) : null}
        </div>
      ) : null}
      <div className="overflow-auto border-b border-border">
        <table className="w-full min-w-[720px] border-collapse tabular-nums">
          <thead className="sticky top-0 z-10 bg-background">
            <tr className="h-9 border-b border-border">
              {columns.map((column) => {
                const active = sort?.columnId === column.id
                const SortIcon = !active ? ArrowUpDown : sort.direction === 'asc' ? ArrowUp : ArrowDown
                return (
                  <th
                    key={column.id}
                    scope="col"
                    aria-sort={
                      active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : undefined
                    }
                    className={cn(
                      'text-muted-foreground px-3 text-[13px] font-medium uppercase leading-[18px] tracking-[0.04em]',
                      // A sortable header sits in a truncating button, so it must not be squeezed;
                      // a plain header may wrap to keep a narrow panel table inside its card.
                      column.sortable && onSortChange && 'whitespace-nowrap',
                      alignClass(column.align),
                      column.sticky === 'right' && STICKY_RIGHT_CLASS,
                      column.headerClassName,
                    )}
                  >
                    {column.sortable && onSortChange ? (
                      <button
                        type="button"
                        className={cn(
                          'inline-flex max-w-full items-center gap-1 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                          column.align === 'right' && 'ml-auto',
                        )}
                        onClick={() => onSortChange(nextSort(sort, column.id))}
                      >
                        <span className="truncate">{column.header}</span>
                        <SortIcon className="size-3 shrink-0" strokeWidth={1.5} />
                      </button>
                    ) : (
                      column.header
                    )}
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody className={cn(loading && rows.length > 0 && 'opacity-70')}>
            {isFirstLoad ? (
              <tr className="h-24">
                <td colSpan={columns.length} className="text-muted-foreground px-3 text-center">
                  <span className="inline-flex items-center gap-2">
                    <Loader2 className="size-3 animate-spin" strokeWidth={1.5} />
                    Loading…
                  </span>
                </td>
              </tr>
            ) : isInitialError ? (
              <tr className="h-24">
                <td colSpan={columns.length} className="text-muted-foreground px-3 text-center">
                  Request failed. Use retry above after correcting the connection.
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr className="h-24">
                <td colSpan={columns.length} className="px-3 text-center">
                  <div className="text-muted-foreground inline-flex flex-col items-center gap-1">
                    <span>{model.message}</span>
                    {model.hint ? <span className="text-xs">{model.hint}</span> : null}
                    {model.action ? <div className="mt-2">{model.action}</div> : null}
                  </div>
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={getRowId(row)} className="group h-9 border-t border-border hover:bg-surface-1">
                  {columns.map((column) => (
                    <td
                      key={column.id}
                      className={cn(
                        'max-w-[360px] truncate px-3 text-[13px] leading-[18px]',
                        alignClass(column.align),
                        column.sticky === 'right' && `${STICKY_RIGHT_CLASS} z-[1] group-hover:bg-surface-1`,
                        column.className,
                      )}
                    >
                      {column.cell(row)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
