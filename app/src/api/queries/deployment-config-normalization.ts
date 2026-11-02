export type DeploymentTargetKind = 'servers' | 'clusters'

export interface DeploymentTargetRef {
  kind: DeploymentTargetKind
  name: string
}

export interface DeploymentConfigMetadata {
  moduleType: string | null
  deploymentOrder: number | null
  sourcePath: string | null
  planPath: string | null
  securityDDModel: string | null
  stagingMode: string | null
}

export interface DeploymentConfigSummary {
  targets: DeploymentTargetRef[]
  metadata: DeploymentConfigMetadata
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

// WebLogic REST returns references as { identity: ['servers', 'AdminServer'] }; bare tuples are
// accepted too.
export function readDeploymentTargetRefs(value: unknown): DeploymentTargetRef[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const identity = Array.isArray(item) ? item : isObject(item) ? item.identity : null
    if (!Array.isArray(identity)) return []
    const kind = readString(identity[0])
    const name = readString(identity[1])
    if ((kind === 'servers' || kind === 'clusters') && name) return [{ kind, name }]
    return []
  })
}

export function normalizeDeploymentConfigSummary(value: unknown): DeploymentConfigSummary | null {
  if (!isObject(value)) return null

  return {
    targets: readDeploymentTargetRefs(value.targets),
    metadata: {
      moduleType: readString(value.moduleType),
      deploymentOrder: readNumber(value.deploymentOrder),
      sourcePath: readString(value.sourcePath),
      planPath: readString(value.planPath),
      securityDDModel: readString(value.securityDDModel),
      stagingMode: readString(value.stagingMode),
    },
  }
}

export function deploymentConfigMapEntries(item: unknown): Array<readonly [string, DeploymentConfigSummary]> {
  if (!isObject(item)) return []
  const name = readString(item.name)
  if (!name) return []
  const summary = normalizeDeploymentConfigSummary(item)
  if (!summary) return []

  const applicationName = readString(item.applicationName)
  const entries: Array<readonly [string, DeploymentConfigSummary]> = [[name, summary]]
  if (applicationName && applicationName !== name) entries.push([applicationName, summary])
  return entries
}

export const JMS_MODULE_TYPE = 'JMS module'

export function jmsModuleTargetEntries(item: unknown): Array<readonly [string, DeploymentTargetRef[]]> {
  if (!isObject(item)) return []
  const name = readString(item.name)
  return name ? [[name, readDeploymentTargetRefs(item.targets)]] : []
}

// JMS system modules show up as application runtimes but are configured as JMSSystemResources,
// not AppDeployments, so they had no targets and no actions. They get their targets from there
// and are marked so the page can send the operator to JMS instead.
export function applyJmsModuleTargets<
  T extends { name: string; deploymentName: string; configurationSupported: boolean; configuredTargets: DeploymentTargetRef[]; moduleType: string | null },
>(rows: T[], modules: ReadonlyMap<string, DeploymentTargetRef[]>): T[] {
  return rows.map((row) => {
    if (row.configurationSupported) return row
    const targets = modules.get(row.deploymentName) ?? modules.get(row.name)
    return targets ? { ...row, configuredTargets: targets, moduleType: JMS_MODULE_TYPE } : row
  })
}
