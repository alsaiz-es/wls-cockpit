export interface TargetChange {
  added: string[]
  removed: string[]
}

export function targetChange(before: string[], after: string[]): TargetChange {
  const was = new Set(before)
  const now = new Set(after)
  return {
    added: after.filter((key) => !was.has(key)),
    removed: before.filter((key) => !now.has(key)),
  }
}

export function targetChangeSummary(change: TargetChange) {
  if (change.added.length === 0 && change.removed.length === 0) return 'No changes yet.'
  return [
    change.added.length ? `Adds ${change.added.join(', ')}` : null,
    change.removed.length ? `Removes ${change.removed.join(', ')}` : null,
  ]
    .filter(Boolean)
    .join(' · ')
}
