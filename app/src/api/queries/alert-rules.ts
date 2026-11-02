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
  // Names the file version a save is based on; 'none' when there is no file yet.
  revision: string | null
  config: AlertRulesConfig | null
  errors: AlertConfigError[]
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function normalizeAlertRulesFile(value: unknown): AlertRulesFile {
  if (!isObject(value)) return { available: false, path: null, exists: false, revision: null, config: null, errors: [] }
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
    revision: typeof value.revision === 'string' ? value.revision : null,
    config,
    errors: [...errors, ...shapeErrors],
  }
}

export async function fetchAlertRulesFile(): Promise<AlertRulesFile> {
  const response = await fetch(ALERT_RULES_PATH, { headers: { Accept: 'application/json' } })
  if (response.status === 404) return { available: false, path: null, exists: false, revision: null, config: null, errors: [] }
  if (!response.ok) throw new Error(`Alert rules could not be read (HTTP ${response.status}).`)
  return normalizeAlertRulesFile(await response.json())
}

export class AlertRulesSaveError extends Error {
  readonly conflict: boolean
  readonly errors: AlertConfigError[]

  constructor(message: string, conflict: boolean, errors: AlertConfigError[] = []) {
    super(message)
    this.conflict = conflict
    this.errors = errors
  }
}

// Saves the edited config; the server rewrites alerts.yaml keeping its comments. A file changed
// since revision is a conflict: nothing is written.
export async function saveAlertRules(revision: string, config: AlertRulesConfig): Promise<AlertRulesFile> {
  const response = await fetch(ALERT_RULES_PATH, {
    method: 'PUT',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Requested-By': 'wls-cockpit' },
    body: JSON.stringify({ revision, config }),
  })
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const message = isObject(body) && typeof body.error === 'string' ? body.error : `Saving failed (HTTP ${response.status}).`
    const errors = isObject(body) ? normalizeAlertRulesFile({ config: null, errors: body.errors }).errors : []
    throw new AlertRulesSaveError(message, response.status === 409, errors)
  }
  return normalizeAlertRulesFile(body)
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
