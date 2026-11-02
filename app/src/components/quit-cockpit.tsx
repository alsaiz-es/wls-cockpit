import { useState } from 'react'
import { Power } from 'lucide-react'
import { requestCockpitShutdown } from '@/api/cockpit-shutdown'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from './confirm-dialog'

export function QuitCockpitButton() {
  const [confirming, setConfirming] = useState(false)
  const [pending, setPending] = useState(false)
  const [stopped, setStopped] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onConfirm() {
    setPending(true)
    setError(null)
    try {
      await requestCockpitShutdown()
      setStopped(true)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Cockpit did not stop.')
    } finally {
      setPending(false)
      setConfirming(false)
    }
  }

  if (stopped) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-background px-4">
        <div className="max-w-md space-y-2 text-center">
          <h1 className="text-base font-semibold text-foreground">WLS Cockpit stopped</h1>
          <p className="text-sm text-muted-foreground">
            The local server is no longer running. You can close this tab; start Cockpit again from its launcher.
          </p>
        </div>
      </div>
    )
  }

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setConfirming(true)}
        title="Stop the local Cockpit server"
      >
        <Power className="size-4" strokeWidth={1.5} />
        Quit
      </Button>
      {error ? <span className="text-xs text-status-negative" role="alert">{error}</span> : null}
      <ConfirmDialog
        open={confirming}
        title="Quit WLS Cockpit?"
        description="This stops the local Cockpit server on this machine. WebLogic is not affected. Open tabs stop working until Cockpit is started again."
        confirmLabel="Quit Cockpit"
        pending={pending}
        onConfirm={() => void onConfirm()}
        onCancel={() => setConfirming(false)}
      />
    </>
  )
}
