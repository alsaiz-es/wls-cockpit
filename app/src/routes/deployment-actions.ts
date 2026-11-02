import type { DeploymentLifecycleAction } from '@/api/queries/deployment-lifecycle'
import { JMS_MODULE_TYPE } from '../api/queries/deployment-config-normalization.ts'

export interface DeploymentActionInput {
  scope: 'internal' | 'external'
  lifecycleSupported: boolean
  configurationSupported: boolean
  deploymentState: string | number | null
  activeVersionState: number | null
  moduleType?: string | null
}

export interface DeploymentActionModeOptions {
  readOnlyDemoMode?: boolean
}

function deploymentStateLabel(value: string | number | null) {
  if (value === null) return '-'
  if (value === 2) return 'ACTIVE'
  if (value === 1) return 'PREPARED'
  if (value === 0) return 'UNPREPARED'
  return String(value).toUpperCase()
}

export function canMutateDeploymentConfig(
  row: DeploymentActionInput,
  options: DeploymentActionModeOptions = {},
) {
  return !options.readOnlyDemoMode && row.scope === 'external' && row.configurationSupported
}

export function availableDeploymentLifecycleActions(
  row: DeploymentActionInput,
  options: DeploymentActionModeOptions = {},
): DeploymentLifecycleAction[] {
  if (options.readOnlyDemoMode) return []
  if (row.scope === 'internal') return []
  if (!row.lifecycleSupported) return []
  // JMS system modules are managed from the JMS page, not as application deployments.
  if (row.moduleType === JMS_MODULE_TYPE) return []

  if (row.deploymentState !== null) {
    const state = deploymentStateLabel(row.deploymentState)
    if (state === 'ACTIVE' || state === 'ACTIVATED') return ['stop', 'redeploy']
    if (state === 'INACTIVE' || state === 'PREPARED' || state === 'UNPREPARED') return ['start']
    return []
  }

  if (row.activeVersionState === 2 || row.activeVersionState === 1) return ['stop', 'redeploy']
  if (row.activeVersionState === 0) return ['start']

  return []
}

export type DeploymentConfirmKind = DeploymentLifecycleAction | 'undeploy'

export interface DeploymentConfirmInput {
  name: string
  targetName: string
  configuredTargets: Array<{ name: string }>
}

// Every lifecycle action is confirmed: they all change a running domain. Redeploy is sent without
// targets (the only overload that needs no source or plan path), so WebLogic redeploys the
// application on all of its targets, not only the row's server; the dialog says so.
export function deploymentConfirmCopy(kind: DeploymentConfirmKind, row: DeploymentConfirmInput) {
  const allTargets = row.configuredTargets.map((target) => target.name)
  switch (kind) {
    case 'start':
      return {
        title: 'Start application?',
        description: 'This starts the application on the selected target server.',
        subject: `${row.name} on ${row.targetName}`,
        confirmLabel: 'Confirm start',
      }
    case 'stop':
      return {
        title: 'Stop application?',
        description: 'This will stop the application on the selected target server.',
        subject: `${row.name} on ${row.targetName}`,
        confirmLabel: 'Confirm stop',
      }
    case 'redeploy':
      return {
        title: 'Redeploy application?',
        description:
          'WebLogic redeploys the application on all of its targets, not only this server. Requests in flight may fail while it restarts.',
        subject: `${row.name} on ${allTargets.length ? allTargets.join(', ') : row.targetName}`,
        confirmLabel: 'Confirm redeploy',
      }
    case 'undeploy':
      return {
        title: 'Undeploy application?',
        description: 'This will delete the configured application deployment in a WebLogic edit session.',
        subject: `${row.name} on ${row.targetName}`,
        confirmLabel: 'Confirm undeploy',
      }
  }
}

export function formatActiveVersionState(value: number | null) {
  if (value === null) return '–'
  if (value === 2) return 'ACTIVE'
  if (value === 1) return 'ACTIVE_ADMIN'
  if (value === 0) return 'INACTIVE'
  return String(value)
}

export function formatDeploymentState(value: string | number | null) {
  if (value === null) return '–'
  if (value === 2) return 'ACTIVE'
  if (value === 1) return 'PREPARED'
  if (value === 0) return 'UNPREPARED'
  return String(value)
}

// ApplicationRuntime has no deploymentState on 12.2.1.4 or 14.1.2, only activeVersionState, so the
// state filter uses whichever the row has instead of offering a single '–' option.
export function rowStateLabel(row: { deploymentState: string | number | null; activeVersionState: number | null }) {
  return row.deploymentState !== null
    ? formatDeploymentState(row.deploymentState)
    : formatActiveVersionState(row.activeVersionState)
}
