import { useEffect, useRef } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { MonoText } from './mono-text'

export interface ConfirmDialogProps {
  open: boolean
  title: string
  description: string
  confirmLabel?: string
  cancelLabel?: string
  subject?: string
  pending?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  subject,
  pending = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return undefined
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !pending) onCancel()
    }
    document.addEventListener('keydown', handleKeyDown)
    const frame = window.requestAnimationFrame(() => confirmRef.current?.focus())
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      window.cancelAnimationFrame(frame)
    }
  }, [onCancel, open, pending])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 py-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        className="border-border bg-surface-2 w-full max-w-[400px] border shadow-xl"
      >
        <div className="border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <AlertTriangle className="text-status-negative size-4" strokeWidth={1.5} aria-hidden />
            <h2 id="confirm-dialog-title" className="text-[16px] font-medium leading-[22px]">
              {title}
            </h2>
          </div>
        </div>
        <div className="space-y-3 px-4 py-3 text-[13px] leading-[18px]">
          <p className="text-muted-foreground">{description}</p>
          {subject ? (
            <div className="border-border bg-background border px-2 py-2">
              <MonoText className="block truncate text-[13px]" title={subject}>
                {subject}
              </MonoText>
            </div>
          ) : null}
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
          <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button ref={confirmRef} type="button" variant="destructive" size="sm" disabled={pending} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}
