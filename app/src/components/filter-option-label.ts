// Filter selects read in sentence case ("All servers", "Warning"), like the rest of the UI. Only for
// fixed choices: server and resource names are shown as WebLogic reports them.
export function filterOptionLabel(value: string, allLabel: string) {
  if (value === 'all') return allLabel
  return value.charAt(0).toUpperCase() + value.slice(1)
}

export const FILTER_SELECT_CLASS =
  'border-input bg-background h-8 rounded-[4px] border px-2 text-[13px] leading-[18px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
