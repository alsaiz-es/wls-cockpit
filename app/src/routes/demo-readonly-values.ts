export const DEMO_REDACTED_VALUE = 'Hidden in demo mode'

export function demoSensitiveValue(value: string | null | undefined, readOnlyDemoMode: boolean) {
  if (readOnlyDemoMode && value && value.trim().length > 0) return DEMO_REDACTED_VALUE
  return value ?? null
}
