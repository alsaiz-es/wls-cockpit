import type {
  DeploymentRuntimeRow,
  DeploymentScope,
  DeploymentSeverity,
  DeploymentTargetRef,
} from './deployments.ts'

export type DeploymentGroupScope = DeploymentScope | 'mixed'

export interface DeploymentRuntimeGroup {
  id: string
  name: string
  deploymentName: string
  severity: DeploymentSeverity
  healthState: DeploymentRuntimeRow['healthState']
  overallHealthState: DeploymentRuntimeRow['overallHealthState']
  activeVersionStates: Array<number | null>
  deploymentStates: Array<string | number | null>
  scope: DeploymentGroupScope
  configuredTargets: DeploymentTargetRef[]
  applicationVersions: string[]
  instances: DeploymentRuntimeRow[]
}

function compareText(a: string, b: string) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}

function worseSeverity(a: DeploymentSeverity, b: DeploymentSeverity): DeploymentSeverity {
  const order: DeploymentSeverity[] = ['unknown', 'healthy', 'warning', 'critical']
  return order.indexOf(b) > order.indexOf(a) ? b : a
}

function worseHealth(
  a: DeploymentRuntimeRow['healthState'],
  b: DeploymentRuntimeRow['healthState'],
): DeploymentRuntimeRow['healthState'] {
  const order: Array<DeploymentRuntimeRow['healthState']> = ['unknown', 'ok', 'warn', 'overloaded', 'failed', 'critical']
  return order.indexOf(b) > order.indexOf(a) ? b : a
}

function deploymentGroupKey(row: DeploymentRuntimeRow) {
  return row.deploymentName || row.name
}

function uniqueDeploymentTargets(rows: DeploymentRuntimeRow[]) {
  const targetsByKey = new Map<string, DeploymentTargetRef>()
  rows.forEach((row) => {
    row.configuredTargets.forEach((target) => {
      targetsByKey.set(`${target.kind}:${target.name}`, target)
    })
  })
  return Array.from(targetsByKey.values()).sort(
    (a, b) => a.kind.localeCompare(b.kind) || compareText(a.name, b.name),
  )
}

function uniqueValues<T>(values: T[]) {
  return Array.from(new Set(values))
}

export function buildDeploymentRuntimeGroups(rows: DeploymentRuntimeRow[]): DeploymentRuntimeGroup[] {
  const rowsByDeployment = new Map<string, DeploymentRuntimeRow[]>()
  rows.forEach((row) => {
    const key = deploymentGroupKey(row)
    rowsByDeployment.set(key, [...(rowsByDeployment.get(key) ?? []), row])
  })

  return Array.from(rowsByDeployment.entries()).map(([deploymentName, instances]) => {
    const sortedInstances = [...instances].sort(
      (a, b) => compareText(a.serverName, b.serverName) || compareText(a.name, b.name),
    )
    const first = sortedInstances[0] as DeploymentRuntimeRow
    const scopeValues = uniqueValues(sortedInstances.map((row) => row.scope))

    return {
      id: deploymentName,
      name: first.name,
      deploymentName,
      severity: sortedInstances.reduce<DeploymentSeverity>(
        (current, row) => worseSeverity(current, row.severity),
        'unknown',
      ),
      healthState: sortedInstances.reduce<DeploymentRuntimeRow['healthState']>(
        (current, row) => worseHealth(current, row.healthState),
        'unknown',
      ),
      overallHealthState: sortedInstances.reduce<DeploymentRuntimeRow['overallHealthState']>(
        (current, row) => worseHealth(current, row.overallHealthState),
        'unknown',
      ),
      activeVersionStates: uniqueValues(sortedInstances.map((row) => row.activeVersionState)),
      deploymentStates: uniqueValues(sortedInstances.map((row) => row.deploymentState)),
      scope: scopeValues.length === 1 ? scopeValues[0] : 'mixed',
      configuredTargets: uniqueDeploymentTargets(sortedInstances),
      applicationVersions: uniqueValues(
        sortedInstances.flatMap((row) => (row.applicationVersion ? [row.applicationVersion] : [])),
      ).sort(compareText),
      instances: sortedInstances,
    }
  })
}
