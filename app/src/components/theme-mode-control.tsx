import { cn } from '@/lib/utils'
import type { ResolvedThemeMode, ThemeMode } from '@/theme/theme-mode'
import { THEME_MODE_CONTROL_OPTIONS, themeModeControlLabel } from './theme-mode-control-model'

export interface ThemeModeControlProps {
  mode: ThemeMode
  resolvedMode: ResolvedThemeMode
  onModeChange: (mode: ThemeMode) => void
}

export function ThemeModeControl({ mode, resolvedMode, onModeChange }: ThemeModeControlProps) {
  return (
    <div
      role="group"
      aria-label="Theme mode"
      className="border-border-strong bg-surface-1 flex h-7 shrink-0 items-center gap-0.5 border p-0.5"
    >
      {THEME_MODE_CONTROL_OPTIONS.map((option) => {
        const selected = mode === option.mode
        const label = themeModeControlLabel(option, resolvedMode)
        const Icon = option.Icon

        return (
          <button
            key={option.mode}
            type="button"
            aria-label={label}
            aria-pressed={selected}
            title={label}
            data-theme-mode={option.mode}
            data-selected={selected ? 'true' : 'false'}
            onClick={() => onModeChange(option.mode)}
            className={cn(
              'flex size-6 items-center justify-center text-muted-foreground outline-none hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
              selected && 'bg-background text-foreground shadow-[inset_0_0_0_1px_var(--border-strong)]',
            )}
          >
            <Icon className="size-3.5" strokeWidth={1.5} aria-hidden />
          </button>
        )
      })}
    </div>
  )
}
