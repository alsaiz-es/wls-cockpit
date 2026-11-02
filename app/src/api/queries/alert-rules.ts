import { useEffect, useMemo } from 'react'
import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import {
  ALERT_RULES_PATH,
  alertRulesConfigToFileShape,
  resolveAlertRules,
  setActiveAlertRules,
  validateAlertRulesConfig,
  type AlertConfigError,
  type AlertRulesConfig,
  type ResolvedAlertRules,
} from '../alert-rules.ts'
import { useAuth } from '@/auth/useAuth'

export const ALERT_RULES_REFRESH_MS = 60_000

export interface AlertRulesFile {
  // False when this Cockpit server does not serve alert rules; the defaults apply.
  available: boolean
  path: string | null
  exists: boolean
  config: AlertRulesConfig | null
  errors: AlertConfigError[]
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function normalizeAlertRulesFile(value: unknown): AlertRulesFile {
  if (!isObject(value)) return { available: false, path: null, exists: false, config: null, errors: [] }
  // The server already validated the file; validating again keeps a malformed answer from
  // reaching the classifiers.
  const { config, errors: shapeErrors } = validateAlertRulesConfig(alertRulesConfigToFileShape(value.config))
  const errors = Array.isArray(value.errors)
    ? value.errors.flatMap((error): AlertConfigError[] => {
        if (!isObject(error) || typeof error.message !== 'string') return []
        return [{
          path: Array.isArray(error.path) ? error.path.filter((part) => typeof part === 'string' || typeof part === 'number') : [],
          message: error.message,
          line: typeof error.line === 'number' ? error.line : undefined,
        }]
      })
    : []
  return {
    available: true,
    path: typeof value.path === 'string' ? value.path : null,
    exists: value.exists === true,
    config,
    errors: [...errors, ...shapeErrors],
  }
}

export async function fetchAlertRulesFile(): Promise<AlertRulesFile> {
  const response = await fetch(ALERT_RULES_PATH, { headers: { Accept: 'application/json' } })
  if (response.status === 404) return { available: false, path: null, exists: false, config: null, errors: [] }
  if (!response.ok) throw new Error(`Alert rules could not be read (HTTP ${response.status}).`)
  return normalizeAlertRulesFile(await response.json())
}

// Loads the rules for the signed-in connection and makes them the active ones for every classifier.
export function useAlertRules(): {
  file: AlertRulesFile | undefined
  resolved: ResolvedAlertRules
  domainName: string | null
  query: UseQueryResult<AlertRulesFile, Error>
} {
  const { creds } = useAuth()
  const query = useQuery({
    queryKey: ['alertRules'],
    queryFn: fetchAlertRulesFile,
    refetchInterval: ALERT_RULES_REFRESH_MS,
    staleTime: ALERT_RULES_REFRESH_MS / 2,
  })
  const domainName = creds?.name ?? null
  const resolved = useMemo(() => resolveAlertRules(query.data?.config, domainName), [query.data, domainName])

  useEffect(() => {
    setActiveAlertRules(resolved)
  }, [resolved])

  return { file: query.data, resolved, domainName, query }
}
