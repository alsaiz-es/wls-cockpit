export const THEME_MODE_STORAGE_KEY = 'wls-cockpit:theme-mode:v1'
export const SYSTEM_COLOR_SCHEME_QUERY = '(prefers-color-scheme: dark)'
export const DEFAULT_THEME_MODE = 'dark'

export const THEME_MODES = ['dark', 'light', 'system'] as const

export type ThemeMode = (typeof THEME_MODES)[number]
export type ResolvedThemeMode = 'dark' | 'light'

export interface ThemeModeStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface ThemeRoot {
  classList: {
    contains(token: string): boolean
    toggle(token: string, force?: boolean): boolean
  }
  dataset?: Record<string, string | undefined>
  style?: {
    colorScheme?: string
  }
}

export interface ThemeMediaQueryList {
  matches: boolean
  addEventListener?: (type: 'change', listener: (event: { matches: boolean }) => void) => void
  removeEventListener?: (type: 'change', listener: (event: { matches: boolean }) => void) => void
  addListener?: (listener: (event: { matches: boolean }) => void) => void
  removeListener?: (listener: (event: { matches: boolean }) => void) => void
}

export type ThemeMatchMedia = (query: string) => ThemeMediaQueryList

export function parseThemeMode(value: unknown): ThemeMode | null {
  return typeof value === 'string' && THEME_MODES.includes(value as ThemeMode)
    ? (value as ThemeMode)
    : null
}

export function browserThemeStorage(): ThemeModeStorage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function browserDocumentRoot(): ThemeRoot | null {
  return typeof document === 'undefined' ? null : document.documentElement
}

export function browserMatchMedia(): ThemeMatchMedia | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null
  return window.matchMedia.bind(window)
}

export function readStoredThemeMode(storage: ThemeModeStorage | null = browserThemeStorage()): ThemeMode {
  try {
    return parseThemeMode(storage?.getItem(THEME_MODE_STORAGE_KEY)) ?? DEFAULT_THEME_MODE
  } catch {
    return DEFAULT_THEME_MODE
  }
}

export function persistThemeMode(
  mode: ThemeMode,
  storage: ThemeModeStorage | null = browserThemeStorage(),
): boolean {
  try {
    storage?.setItem(THEME_MODE_STORAGE_KEY, mode)
    return Boolean(storage)
  } catch {
    return false
  }
}

export function systemPrefersDark(matchMedia: ThemeMatchMedia | null = browserMatchMedia()): boolean {
  try {
    return matchMedia ? matchMedia(SYSTEM_COLOR_SCHEME_QUERY).matches : true
  } catch {
    return true
  }
}

export function resolveThemeMode(mode: ThemeMode, systemDark = systemPrefersDark()): ResolvedThemeMode {
  if (mode === 'light') return 'light'
  if (mode === 'system') return systemDark ? 'dark' : 'light'
  return 'dark'
}

export function applyResolvedThemeMode(
  root: ThemeRoot | null,
  resolvedMode: ResolvedThemeMode,
  selectedMode?: ThemeMode,
) {
  if (!root) return
  root.classList.toggle('dark', resolvedMode === 'dark')
  if (selectedMode && root.dataset) root.dataset.themeMode = selectedMode
  if (root.style) root.style.colorScheme = resolvedMode
}

export function applyThemeMode({
  mode,
  root = browserDocumentRoot(),
  matchMedia = browserMatchMedia(),
}: {
  mode: ThemeMode
  root?: ThemeRoot | null
  matchMedia?: ThemeMatchMedia | null
}): ResolvedThemeMode {
  const resolvedMode = resolveThemeMode(mode, systemPrefersDark(matchMedia))
  applyResolvedThemeMode(root, resolvedMode, mode)
  return resolvedMode
}

export function initializeThemeMode({
  storage = browserThemeStorage(),
  root = browserDocumentRoot(),
  matchMedia = browserMatchMedia(),
}: {
  storage?: ThemeModeStorage | null
  root?: ThemeRoot | null
  matchMedia?: ThemeMatchMedia | null
} = {}) {
  const mode = readStoredThemeMode(storage)
  const resolvedMode = applyThemeMode({ mode, root, matchMedia })
  return { mode, resolvedMode }
}

export function subscribeToSystemThemePreference(
  onChange: (systemDark: boolean) => void,
  matchMedia: ThemeMatchMedia | null = browserMatchMedia(),
) {
  let query: ThemeMediaQueryList | null = null
  try {
    query = matchMedia?.(SYSTEM_COLOR_SCHEME_QUERY) ?? null
  } catch {
    query = null
  }
  if (!query) return () => undefined

  const listener = (event: { matches: boolean }) => onChange(event.matches)
  if (query.addEventListener) {
    query.addEventListener('change', listener)
    return () => query?.removeEventListener?.('change', listener)
  }

  query.addListener?.(listener)
  return () => query?.removeListener?.(listener)
}
