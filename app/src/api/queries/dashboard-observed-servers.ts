export interface DashboardObservedServer {
  name: string
  state: string
}

export interface DashboardObservedServerIssue {
  id: string
  severity: 'critical'
  family: 'servers'
  title: string
  detail: string
  hint: string
  serverName: string
  snapshotServers: string[]
}

export function buildObservedServerDownIssues(
  servers: DashboardObservedServer[],
  observedRunningServers: Set<string>,
): DashboardObservedServerIssue[] {
  const issues = servers.flatMap((server) => {
    if (
      observedRunningServers.has(server.name) &&
      (server.state === 'SHUTDOWN' || server.state === 'FAILED_NOT_RESTARTABLE')
    ) {
      return [
        {
          id: `server-observed-down:${server.name}`,
          severity: 'critical' as const,
          family: 'servers' as const,
          title: `${server.name} stopped after running`,
          detail: `Observed RUNNING earlier in this browser session; now ${server.state}.`,
          hint: 'Open server detail and collect evidence before deciding whether to restart the managed server.',
          serverName: server.name,
          snapshotServers: [server.name],
        },
      ]
    }
    return []
  })

  servers.forEach((server) => {
    if (server.state === 'RUNNING') observedRunningServers.add(server.name)
  })

  return issues
}
