import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_THEME_MODE,
  SYSTEM_COLOR_SCHEME_QUERY,
  THEME_MODE_STORAGE_KEY,
  applyThemeMode,
  initializeThemeMode,
  parseThemeMode,
  persistThemeMode,
  readStoredThemeMode,
  resolveThemeMode,
  subscribeToSystemThemePreference,
  systemPrefersDark,
  type ThemeModeStorage,
  type ThemeRoot,
} from '../src/theme/theme-mode.ts'

class MemoryStorage implements ThemeModeStorage {
  private readonly values = new Map<string, string>()

  getItem(key: string) {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string) {
    this.values.set(key, value)
  }
}

class ThrowingStorage implements ThemeModeStorage {
  getItem() {
    throw new Error('storage unavailable')
  }

  setItem() {
    throw new Error('storage unavailable')
  }
}

class FakeClassList {
  private readonly tokens = new Set<string>()

  constructor(tokens: string[] = []) {
    tokens.forEach((token) => this.tokens.add(token))
  }

  contains(token: string) {
    return this.tokens.has(token)
  }

  toggle(token: string, force?: boolean) {
    const shouldContain = force ?? !this.tokens.has(token)
    if (shouldContain) this.tokens.add(token)
    else this.tokens.delete(token)
    return shouldContain
  }
}

function fakeRoot(tokens: string[] = []) {
  return {
    classList: new FakeClassList(tokens),
    dataset: {},
    style: {},
  } satisfies ThemeRoot
}

test('theme mode parsing accepts only supported modes', () => {
  assert.equal(parseThemeMode('dark'), 'dark')
  assert.equal(parseThemeMode('light'), 'light')
  assert.equal(parseThemeMode('system'), 'system')
  assert.equal(parseThemeMode('midnight'), null)
  assert.equal(parseThemeMode(null), null)
})

test('stored theme mode falls back to dark for missing invalid or unreadable values', () => {
  const storage = new MemoryStorage()
  assert.equal(readStoredThemeMode(storage), DEFAULT_THEME_MODE)

  storage.setItem(THEME_MODE_STORAGE_KEY, 'light')
  assert.equal(readStoredThemeMode(storage), 'light')

  storage.setItem(THEME_MODE_STORAGE_KEY, 'invalid')
  assert.equal(readStoredThemeMode(storage), 'dark')
  assert.equal(readStoredThemeMode(new ThrowingStorage()), 'dark')
})

test('theme mode persistence stores only the selected mode string', () => {
  const storage = new MemoryStorage()
  assert.equal(persistThemeMode('system', storage), true)
  assert.equal(storage.getItem(THEME_MODE_STORAGE_KEY), 'system')
  assert.doesNotMatch(storage.getItem(THEME_MODE_STORAGE_KEY) ?? '', /weblogic|password|host|target/i)
  assert.equal(persistThemeMode('light', new ThrowingStorage()), false)
})

test('theme mode resolution and document root application update the dark class', () => {
  const lightRoot = fakeRoot(['dark'])
  const lightResolved = applyThemeMode({
    mode: 'light',
    root: lightRoot,
    matchMedia: () => ({ matches: true }),
  })
  assert.equal(lightResolved, 'light')
  assert.equal(lightRoot.classList.contains('dark'), false)
  assert.deepEqual(lightRoot.dataset, { themeMode: 'light' })
  assert.deepEqual(lightRoot.style, { colorScheme: 'light' })

  const systemRoot = fakeRoot()
  const systemResolved = applyThemeMode({
    mode: 'system',
    root: systemRoot,
    matchMedia: (query) => {
      assert.equal(query, SYSTEM_COLOR_SCHEME_QUERY)
      return { matches: true }
    },
  })
  assert.equal(systemResolved, 'dark')
  assert.equal(systemRoot.classList.contains('dark'), true)
  assert.deepEqual(systemRoot.dataset, { themeMode: 'system' })
  assert.deepEqual(systemRoot.style, { colorScheme: 'dark' })
})

test('theme initialization reads storage and applies the resolved theme', () => {
  const storage = new MemoryStorage()
  storage.setItem(THEME_MODE_STORAGE_KEY, 'system')
  const root = fakeRoot(['dark'])

  const state = initializeThemeMode({
    storage,
    root,
    matchMedia: () => ({ matches: false }),
  })

  assert.deepEqual(state, { mode: 'system', resolvedMode: 'light' })
  assert.equal(root.classList.contains('dark'), false)
})

test('system preference helpers default safely and publish updates', () => {
  assert.equal(resolveThemeMode('system', false), 'light')
  assert.equal(systemPrefersDark(null), true)

  let listener: ((event: { matches: boolean }) => void) | null = null
  let removed = false
  const observed: boolean[] = []
  const unsubscribe = subscribeToSystemThemePreference(
    (systemDark) => observed.push(systemDark),
    (query) => {
      assert.equal(query, SYSTEM_COLOR_SCHEME_QUERY)
      return {
        matches: false,
        addEventListener: (_type, nextListener) => {
          listener = nextListener
        },
        removeEventListener: (_type, nextListener) => {
          removed = nextListener === listener
        },
      }
    },
  )

  listener?.({ matches: true })
  listener?.({ matches: false })
  unsubscribe()

  assert.deepEqual(observed, [true, false])
  assert.equal(removed, true)
})
