import type {
  DeploymentRuntimeGroup,
  DeploymentRuntimeRow,
  DeploymentTargetRef,
} from './deployments.ts'
import { deploymentTargetKey, deploymentTargetLabel } from './deployment-targets.ts'

export type DeploymentMatrixCellState =
  | 'empty'
  | 'configured-active'
  | 'configured-inactive'
  | 'configured-missing'
  | 'configured-unavailable'
  | 'runtime-active'
  | 'runtime-inactive'

export type DeploymentMatrixDrift = 'none' | 'missing-runtime' | 'runtime-only' | 'unavailable'

export interface DeploymentMatrixTargetColumn extends DeploymentTargetRef {
  key: string
  label: string
}

export interface DeploymentMatrixCell {
  target: DeploymentMatrixTargetColumn
  state: DeploymentMatrixCellState
  configured: boolean
  runtimeRow: DeploymentRuntimeRow | null
}

export interface DeploymentMatrixRow {
  id: string
  name: string
  deploymentName: string
  scope: DeploymentRuntimeGroup['scope']
  drift: DeploymentMatrixDrift
  editable: boolean
  protectedReason: string | null
  configuredTargets: DeploymentTargetRef[]
  sourceRow: DeploymentRuntimeRow | null
  cells: DeploymentMatrixCell[]
  cellsByTargetKey: ReadonlyMap<string, DeploymentMatrixCell>
}

export interface DeploymentTargetingMatrix {
  targets: DeploymentMatrixTargetColumn[]
  rows: DeploymentMatrixRow[]
}

function compareText(a: string, b: string) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}

function uniqueTargets(targets: DeploymentTargetRef[]) {
  const byKey = new Map<string, DeploymentMatrixTargetColumn>()
  targets.forEach((target) => {
    const key = deploymentTargetKey(target)
    byKey.set(key, { ...target, key, label: deploymentTargetLabel(target) })
  })
  return Array.from(byKey.values()).sort(
    (a, b) => a.kind.localeCompare(b.kind) || compareText(a.name, b.name),
  )
}

function isActiveRuntime(row: DeploymentRuntimeRow) {
  const deploymentState = typeof row.deploymentState === 'string' ? row.deploymentState.toUpperCase() : row.deploymentState
  return deploymentState === 2 || deploymentState === 'ACTIVE' || deploymentState === 'ACTIVATED' || row.activeVersionState === 2
}

function cellState(
  target: DeploymentMatrixTargetColumn,
  configured: boolean,
  runtimeRow: DeploymentRuntimeRow | null,
): DeploymentMatrixCellState {
  if (runtimeRow) {
    const active = isActiveRuntime(runtimeRow)
    if (configured) return active ? 'configured-active' : 'configured-inactive'
    return active ? 'runtime-active' : 'runtime-inactive'
  }

  if (configured && target.kind === 'servers') return 'configured-missing'
  if (configured) return 'configured-unavailable'
  return 'empty'
}

function classifyDrift(cells: DeploymentMatrixCell[]): DeploymentMatrixDrift {
  if (cells.some((cell) => cell.state === 'configured-missing')) return 'missing-runtime'
  if (cells.some((cell) => cell.state === 'runtime-active' || cell.state === 'runtime-inactive')) return 'runtime-only'
  if (cells.some((cell) => cell.state === 'configured-unavailable')) return 'unavailable'
  return 'none'
}

function editProtection(group: DeploymentRuntimeGroup) {
  if (group.scope !== 'external') return 'Internal or mixed-scope deployment.'
  if (group.instances.length === 0) return 'Runtime row is unavailable.'
  if (!group.instances.some((row) => row.configurationSupported)) return 'Configuration row is unavailable.'
  return null
}

export function buildDeploymentTargetingMatrix(
  groups: DeploymentRuntimeGroup[],
  targetChoices: DeploymentTargetRef[] = [],
): DeploymentTargetingMatrix {
  const targets = uniqueTargets([
    ...targetChoices,
    ...groups.flatMap((group) => group.configuredTargets),
    ...groups.flatMap((group) => group.instances.map((row) => ({ kind: 'servers' as const, name: row.serverName }))),
  ])

  const rows = groups.map((group): DeploymentMatrixRow => {
    const configuredKeys = new Set(group.configuredTargets.map(deploymentTargetKey))
    const runtimeRowsByServer = new Map(group.instances.map((row) => [row.serverName, row]))
    const cells = targets.map((target): DeploymentMatrixCell => {
      const runtimeRow = target.kind === 'servers' ? (runtimeRowsByServer.get(target.name) ?? null) : null
      const configured = configuredKeys.has(target.key)
      return {
        target,
        state: cellState(target, configured, runtimeRow),
        configured,
        runtimeRow,
      }
    })
    const cellsByTargetKey = new Map(cells.map((cell) => [cell.target.key, cell]))
    const protectedReason = editProtection(group)

    return {
      id: group.id,
      name: group.name,
      deploymentName: group.deploymentName,
      scope: group.scope,
      drift: classifyDrift(cells),
      editable: protectedReason === null,
      protectedReason,
      configuredTargets: group.configuredTargets,
      sourceRow: group.instances.find((row) => row.configurationSupported && row.scope === 'external') ?? group.instances[0] ?? null,
      cells,
      cellsByTargetKey,
    }
  })

  return { targets, rows }
}

export function matrixRowMatchesTarget(row: DeploymentMatrixRow, targetKey: string) {
  return row.cells.some((cell) => cell.target.key === targetKey && cell.state !== 'empty')
}

export function matrixRowMatchesCluster(row: DeploymentMatrixRow, clusterName: string) {
  return row.configuredTargets.some((target) => target.kind === 'clusters' && target.name === clusterName)
}
