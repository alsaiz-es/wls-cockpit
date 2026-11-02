import { MonoText } from './mono-text'
import { targetChangeSummary, type TargetChange } from './target-change-model'

// Target editors change configuration through an edit session that Cockpit opens and activates
// in one step; the operator sees that, and exactly what changes, before saving.
export function TargetChangeNotice({ change }: { change: TargetChange }) {
  const removesAll = change.removed.length > 0 && change.added.length === 0
  return (
    <div className="mb-3 space-y-1 text-[13px] leading-[18px]">
      <p className="text-muted-foreground">
        Save opens a WebLogic edit session, applies this change and activates it right away. Removing a target stops
        the resource there.
      </p>
      <MonoText className={removesAll ? 'text-status-warning block' : 'block'}>{targetChangeSummary(change)}</MonoText>
    </div>
  )
}
