import type { DashboardSnapshot } from '@/api/queries/domain-dashboard'

export interface QuickJumpEntry {
  id: string
  label: string
  detail: string
  family: string
  href: string
  keywords: string[]
}

const topLevelEntries: QuickJumpEntry[] = [
  { id: 'route:dashboard', label: 'Dashboard', detail: 'Domain overview', family: 'Route', href: '/dashboard', keywords: ['domain', 'overview', 'health'] },
  { id: 'route:servers', label: 'Servers', detail: 'Server runtimes', family: 'Route', href: '/servers', keywords: ['server', 'runtime', 'jvm', 'threads'] },
  { id: 'route:clusters', label: 'Clusters', detail: 'Cluster runtime', family: 'Route', href: '/clusters', keywords: ['cluster'] },
  { id: 'route:work-managers', label: 'Work Managers', detail: 'Work Manager runtime', family: 'Route', href: '/work-managers', keywords: ['work', 'manager', 'threads'] },
  { id: 'route:node-manager', label: 'Node Manager', detail: 'Machine and Node Manager view', family: 'Route', href: '/node-manager', keywords: ['node', 'manager', 'machine'] },
  { id: 'route:deployments', label: 'Deployments', detail: 'Application runtimes', family: 'Route', href: '/deployments', keywords: ['app', 'application', 'deployment'] },
  { id: 'route:data-sources', label: 'Data Sources', detail: 'JDBC pool runtimes', family: 'Route', href: '/data-sources', keywords: ['jdbc', 'datasource', 'pool'] },
  { id: 'route:jms', label: 'JMS', detail: 'JMS servers and destinations', family: 'Route', href: '/jms', keywords: ['queue', 'topic', 'messages'] },
  { id: 'route:jndi', label: 'JNDI', detail: 'Server-scoped JNDI browser', family: 'Route', href: '/jndi', keywords: ['binding', 'tree'] },
  { id: 'route:jta', label: 'JTA', detail: 'Transaction runtime', family: 'Route', href: '/jta', keywords: ['transaction'] },
  { id: 'route:messaging', label: 'Stores & SAF', detail: 'Persistent stores, SAF agents, bridges', family: 'Route', href: '/messaging', keywords: ['store', 'saf', 'bridge', 'filestore'] },
  { id: 'route:security', label: 'Security', detail: 'User lockout', family: 'Route', href: '/security', keywords: ['lockout', 'unlock', 'user', 'login'] },
  { id: 'route:logs', label: 'Logs', detail: 'Server log activity', family: 'Route', href: '/logs', keywords: ['log', 'tail', 'records'] },
  { id: 'route:config-snapshots', label: 'Config Snapshots', detail: 'Local config snapshot diffs', family: 'Route', href: '/config-snapshots', keywords: ['configuration', 'diff'] },
  { id: 'route:audit', label: 'Action Audit', detail: 'Local mutation audit', family: 'Route', href: '/audit', keywords: ['audit', 'actions'] },
]

function segment(value: string) {
  return encodeURIComponent(value)
}

function jmsHref(serverName: string, jmsServerName: string, destinationName: string | null | undefined) {
  if (destinationName) return `/jms/${segment(serverName)}/${segment(jmsServerName)}/${segment(destinationName)}`
  const params = new URLSearchParams({ server: serverName, jmsServer: jmsServerName })
  return `/jms?${params.toString()}`
}

function addEntry(entries: Map<string, QuickJumpEntry>, entry: QuickJumpEntry) {
  if (!entries.has(entry.id)) entries.set(entry.id, entry)
}

export function buildQuickJumpEntries(snapshot: DashboardSnapshot | null | undefined): QuickJumpEntry[] {
  const entries = new Map(topLevelEntries.map((entry) => [entry.id, entry]))

  for (const server of snapshot?.servers ?? []) {
    addEntry(entries, {
      id: `server:${server.name}`,
      label: server.name,
      detail: `Server · ${server.state}`,
      family: 'Server',
      href: `/servers/${segment(server.name)}`,
      keywords: ['server', server.name, server.state, server.healthState ?? ''],
    })
    addEntry(entries, {
      id: `logs:${server.name}`,
      label: `${server.name} logs`,
      detail: 'Server logs',
      family: 'Logs',
      href: `/logs/${segment(server.name)}`,
      keywords: ['logs', 'server', server.name],
    })
  }

  for (const app of snapshot?.applications.items ?? []) {
    addEntry(entries, {
      id: `deployment:${app.serverName}:${app.deploymentName}`,
      label: app.name,
      detail: `Deployment · ${app.serverName}`,
      family: 'Deployment',
      href: `/deployments/${segment(app.serverName)}/${segment(app.deploymentName)}`,
      keywords: ['deployment', 'application', 'app', app.name, app.deploymentName, app.serverName],
    })
  }

  for (const pool of snapshot?.jdbc.items ?? []) {
    addEntry(entries, {
      id: `jdbc:${pool.serverName}:${pool.name}`,
      label: pool.name,
      detail: `JDBC · ${pool.serverName}`,
      family: 'JDBC',
      href: `/data-sources/${segment(pool.serverName)}/${segment(pool.name)}`,
      keywords: ['jdbc', 'datasource', 'pool', pool.name, pool.serverName],
    })
  }

  for (const item of snapshot?.jms.items ?? []) {
    const label = item.destinationName ?? item.jmsServerName
    addEntry(entries, {
      id: `jms:${item.serverName}:${item.jmsServerName}:${label}`,
      label,
      detail: `JMS · ${item.serverName} / ${item.jmsServerName}`,
      family: 'JMS',
      href: jmsHref(item.serverName, item.jmsServerName, item.destinationName),
      keywords: ['jms', 'queue', 'topic', 'message', label, item.jmsServerName, item.serverName],
    })
  }

  return Array.from(entries.values())
}

function searchableText(entry: QuickJumpEntry) {
  return [entry.label, entry.detail, entry.family, ...entry.keywords].join(' ').toLowerCase()
}

export function filterQuickJumpEntries(entries: QuickJumpEntry[], query: string, limit = 12) {
  const normalized = query.trim().toLowerCase()
  const matched = normalized
    ? entries.filter((entry) => searchableText(entry).includes(normalized))
    : entries

  return matched.slice(0, limit)
}

export function hasLiveQuickJumpResources(snapshot: DashboardSnapshot | null | undefined) {
  return !!snapshot && (
    snapshot.servers.length > 0 ||
    snapshot.applications.items.length > 0 ||
    snapshot.jdbc.items.length > 0 ||
    snapshot.jms.items.length > 0
  )
}
