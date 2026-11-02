import { useCallback, useEffect, useState } from 'react'
import {
  applyResolvedThemeMode,
  browserDocumentRoot,
  browserThemeStorage,
  persistThemeMode,
  readStoredThemeMode,
  resolveThemeMode,
  subscribeToSystemThemePreference,
  systemPrefersDark,
  type ResolvedThemeMode,
  type ThemeMode,
} from './theme-mode'

export interface ThemeModeState {
  mode: ThemeMode
  resolvedMode: ResolvedThemeMode
}

export function useThemeMode() {
  const [mode, setModeState] = useState<ThemeMode>(() => readStoredThemeMode(browserThemeStorage()))
  const [systemDark, setSystemDark] = useState(() => systemPrefersDark())
  const resolvedMode = resolveThemeMode(mode, systemDark)

  useEffect(() => {
    persistThemeMode(mode, browserThemeStorage())
    applyResolvedThemeMode(browserDocumentRoot(), resolvedMode, mode)
  }, [mode, resolvedMode])

  useEffect(() => {
    if (mode !== 'system') return undefined
    return subscribeToSystemThemePreference(setSystemDark)
  }, [mode])

  const setMode = useCallback((nextMode: ThemeMode) => {
    if (nextMode === 'system') setSystemDark(systemPrefersDark())
    setModeState(nextMode)
  }, [])

  return { mode, resolvedMode, setMode } satisfies ThemeModeState & { setMode: (mode: ThemeMode) => void }
}
