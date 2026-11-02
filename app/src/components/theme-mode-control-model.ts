import { Monitor, Moon, Sun, type LucideIcon } from 'lucide-react'
import type { ResolvedThemeMode, ThemeMode } from '@/theme/theme-mode'

export interface ThemeModeControlOption {
  mode: ThemeMode
  label: string
  Icon: LucideIcon
}

export const THEME_MODE_CONTROL_OPTIONS: ThemeModeControlOption[] = [
  { mode: 'dark', label: 'Dark theme', Icon: Moon },
  { mode: 'light', label: 'Light theme', Icon: Sun },
  { mode: 'system', label: 'System theme', Icon: Monitor },
]

export function themeModeControlLabel(option: ThemeModeControlOption, resolvedMode: ResolvedThemeMode) {
  return option.mode === 'system' ? `${option.label} (currently ${resolvedMode})` : option.label
}
