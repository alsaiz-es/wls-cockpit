export interface DeploymentHealthSymptom {
  source: 'health' | 'overall'
  category: 'jms' | 'deployment' | 'resource' | 'unknown'
  summary: string | null
  actionHint: string | null
  type: string | null
  severity: string | null
  instanceId: string | null
  info: string | null
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readTrimmedString(value: unknown, maxLength = 1_000): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.length <= maxLength ? trimmed : trimmed.slice(0, maxLength)
}

function guidanceForSymptom({
  type,
  info,
}: {
  type: string | null
  info: string | null
}): Pick<DeploymentHealthSymptom, 'category' | 'summary' | 'actionHint'> {
  const text = `${type ?? ''} ${info ?? ''}`.toLowerCase()
  if (text.includes('mdb') || text.includes('messaging system') || text.includes('jms')) {
    if (text.includes('not connected') || text.includes('messaging system')) {
      return {
        category: 'jms',
        summary: 'MDB is not connected to its messaging system.',
        actionHint: 'Check the selected server JMS resources, MDB target, and destination availability.',
      }
    }
    return {
      category: 'jms',
      summary: 'Deployment health references JMS or MDB messaging.',
      actionHint: 'Inspect JMS destinations and MDB configuration for the selected server.',
    }
  }
  if (text.includes('datasource') || text.includes('jdbc') || text.includes('connection pool')) {
    return {
      category: 'resource',
      summary: 'Deployment health references a runtime resource dependency.',
      actionHint: 'Inspect the related datasource or runtime resource on the selected server.',
    }
  }
  return {
    category: 'unknown',
    summary: null,
    actionHint: null,
  }
}

function symptomsFromObject(source: DeploymentHealthSymptom['source'], value: unknown): DeploymentHealthSymptom[] {
  if (!isObject(value) || !Array.isArray(value.symptoms)) return []
  return value.symptoms.slice(0, 12).flatMap((symptom) => {
    if (!isObject(symptom)) return []
    const type = readTrimmedString(symptom.type, 120)
    const info = readTrimmedString(symptom.info, 2_000)
    const guidance = guidanceForSymptom({ type, info })
    const normalized = {
      source,
      ...guidance,
      type,
      severity: readTrimmedString(symptom.severity, 120),
      instanceId: readTrimmedString(symptom.instanceId, 512),
      info,
    } satisfies DeploymentHealthSymptom
    return normalized.type || normalized.severity || normalized.instanceId || normalized.info ? [normalized] : []
  })
}

export function deploymentHealthSymptoms(healthState: unknown, overallHealthState: unknown): DeploymentHealthSymptom[] {
  return [
    ...symptomsFromObject('health', healthState),
    ...symptomsFromObject('overall', overallHealthState),
  ].slice(0, 12)
}

// One line for issue lists. WebLogic's own symptom text ('MDB application X is NOT connected to
// messaging system.') says why; 'Health ok/warn, deployment n/a.' repeated on every row did not.
export function applicationHealthDetail(app: {
  healthState: string
  overallHealthState: string
  healthReason?: string | null
}) {
  if (app.healthReason) return app.healthReason
  return app.healthState === app.overallHealthState
    ? `Health ${app.healthState}.`
    : `Health ${app.healthState}, overall ${app.overallHealthState} (WebLogic gave no symptom).`
}

export function firstHealthReason(healthState: unknown, overallHealthState: unknown) {
  const symptom = deploymentHealthSymptoms(healthState, overallHealthState).find((entry) => entry.info || entry.summary)
  return symptom ? (symptom.info ?? symptom.summary) : null
}
