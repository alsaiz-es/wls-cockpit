import {
  Activity,
  Archive,
  ClipboardList,
  Database,
  FileText,
  Gauge,
  MessageSquareText,
  Network,
  Package,
  RadioTower,
  Server,
  ShieldCheck,
  Workflow,
} from 'lucide-react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { readRuntimeConfig } from '@/api/runtime-config'
import { useDomainDashboard } from '@/api/queries/domain-dashboard'
import { useEnvironmentStatus } from '@/api/queries/environment-status'
import { useRecordLocalRuntimeAlerts } from '@/api/queries/local-alerts'
import { ServerMetricCapturePollerHost } from '@/api/queries/server-metric-capture-poller'
import { useAuth } from '@/auth/useAuth'
import { cn } from '@/lib/utils'
import { useThemeMode } from '@/theme/use-theme-mode'
import { demoReadOnlyModeLabel } from './app-shell-mode'
import { DiagnosticSnapshotExport } from './diagnostic-snapshot-export'
import { EditSessionBanner } from './edit-session-banner'
import { LocalAlertsWidget } from './local-alerts'
import { MonoText } from './mono-text'
import { QuitCockpitButton } from './quit-cockpit'
import { QuickJump } from './quick-jump'
import { ActiveDomainName, SessionButtons } from './session-controls'
import { StatusBadge } from './status-badge'
import { ThemeModeControl } from './theme-mode-control'

const navItems = [
  { label: 'Dashboard', path: '/dashboard', icon: Gauge },
  { label: 'Servers', path: '/servers', icon: Server },
  { label: 'Clusters', path: '/clusters', icon: Workflow },
  { label: 'Work Managers', path: '/work-managers', icon: Activity },
  { label: 'Node Manager', path: '/node-manager', icon: RadioTower },
  { label: 'Deployments', path: '/deployments', icon: Package },
  { label: 'Data Sources', path: '/data-sources', icon: Database },
  { label: 'JMS', path: '/jms', icon: MessageSquareText },
  { label: 'JNDI', path: '/jndi', icon: Network },
  { label: 'JTA', path: '/jta', icon: Activity },
  { label: 'Security', path: '/security', icon: ShieldCheck },
  { label: 'Logs', path: '/logs', icon: FileText },
  { label: 'Config Snapshots', path: '/config-snapshots', icon: Archive },
  { label: 'Action Audit', path: '/audit', icon: ClipboardList },
] as const

const routeLabels = new Map(navItems.map((item) => [item.path, item.label]))

function Breadcrumb() {
  const location = useLocation()
  const currentPath = location.pathname === '/' ? '/dashboard' : location.pathname
  if (currentPath.startsWith('/servers/')) {
    const rawServerName = currentPath.slice('/servers/'.length)
    const serverName = rawServerName ? decodeURIComponent(rawServerName) : 'Server'

    return (
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1 text-[13px] leading-[18px]">
        <Link className="text-muted-foreground hover:text-foreground" to="/dashboard">
          Domain
        </Link>
        <span className="text-subtle-foreground">/</span>
        <Link className="text-muted-foreground hover:text-foreground" to="/servers">
          Servers
        </Link>
        <span className="text-subtle-foreground">/</span>
        <MonoText className="max-w-[240px] truncate">{serverName}</MonoText>
      </nav>
    )
  }

  if (currentPath.startsWith('/clusters/')) {
    const rawClusterName = currentPath.slice('/clusters/'.length)
    const clusterName = rawClusterName ? decodeURIComponent(rawClusterName) : 'Cluster'

    return (
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1 text-[13px] leading-[18px]">
        <Link className="text-muted-foreground hover:text-foreground" to="/dashboard">
          Domain
        </Link>
        <span className="text-subtle-foreground">/</span>
        <Link className="text-muted-foreground hover:text-foreground" to="/clusters">
          Clusters
        </Link>
        <span className="text-subtle-foreground">/</span>
        <MonoText className="max-w-[240px] truncate">{clusterName}</MonoText>
      </nav>
    )
  }

  if (currentPath.startsWith('/data-sources/')) {
    const rawParts = currentPath.slice('/data-sources/'.length).split('/')
    const serverName = rawParts[0] ? decodeURIComponent(rawParts[0]) : 'Server'
    const dataSourceName = rawParts[1] ? decodeURIComponent(rawParts[1]) : 'Data Source'

    return (
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1 text-[13px] leading-[18px]">
        <Link className="text-muted-foreground hover:text-foreground" to="/dashboard">
          Domain
        </Link>
        <span className="text-subtle-foreground">/</span>
        <Link className="text-muted-foreground hover:text-foreground" to="/data-sources">
          Data Sources
        </Link>
        <span className="text-subtle-foreground">/</span>
        <MonoText className="max-w-[160px] truncate">{serverName}</MonoText>
        <span className="text-subtle-foreground">/</span>
        <MonoText className="max-w-[240px] truncate">{dataSourceName}</MonoText>
      </nav>
    )
  }

  if (currentPath.startsWith('/deployments/')) {
    const rawParts = currentPath.slice('/deployments/'.length).split('/')
    const serverName = rawParts[0] ? decodeURIComponent(rawParts[0]) : 'Server'
    const deploymentName = rawParts[1] ? decodeURIComponent(rawParts[1]) : 'Deployment'

    return (
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1 text-[13px] leading-[18px]">
        <Link className="text-muted-foreground hover:text-foreground" to="/dashboard">
          Domain
        </Link>
        <span className="text-subtle-foreground">/</span>
        <Link className="text-muted-foreground hover:text-foreground" to="/deployments">
          Deployments
        </Link>
        <span className="text-subtle-foreground">/</span>
        <MonoText className="max-w-[160px] truncate">{serverName}</MonoText>
        <span className="text-subtle-foreground">/</span>
        <MonoText className="max-w-[240px] truncate">{deploymentName}</MonoText>
      </nav>
    )
  }

  if (currentPath.startsWith('/logs/')) {
    const rawServerName = currentPath.slice('/logs/'.length)
    const serverName = rawServerName ? decodeURIComponent(rawServerName) : 'Server'

    return (
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1 text-[13px] leading-[18px]">
        <Link className="text-muted-foreground hover:text-foreground" to="/dashboard">
          Domain
        </Link>
        <span className="text-subtle-foreground">/</span>
        <Link className="text-muted-foreground hover:text-foreground" to="/logs">
          Logs
        </Link>
        <span className="text-subtle-foreground">/</span>
        <MonoText className="max-w-[240px] truncate">{serverName}</MonoText>
      </nav>
    )
  }

  if (currentPath.startsWith('/jms/')) {
    const rawParts = currentPath.slice('/jms/'.length).split('/')
    const serverName = rawParts[0] ? decodeURIComponent(rawParts[0]) : 'Server'
    const jmsServerName = rawParts[1] ? decodeURIComponent(rawParts[1]) : 'JMS Server'
    const destinationName = rawParts[2] ? decodeURIComponent(rawParts[2]) : 'Destination'

    return (
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1 text-[13px] leading-[18px]">
        <Link className="text-muted-foreground hover:text-foreground" to="/dashboard">
          Domain
        </Link>
        <span className="text-subtle-foreground">/</span>
        <Link className="text-muted-foreground hover:text-foreground" to="/jms">
          JMS
        </Link>
        <span className="text-subtle-foreground">/</span>
        <MonoText className="max-w-[120px] truncate">{serverName}</MonoText>
        <span className="text-subtle-foreground">/</span>
        <MonoText className="max-w-[160px] truncate">{jmsServerName}</MonoText>
        <span className="text-subtle-foreground">/</span>
        <MonoText className="max-w-[220px] truncate">{destinationName}</MonoText>
      </nav>
    )
  }

  if (currentPath.startsWith('/jta/')) {
    const rawServerName = currentPath.slice('/jta/'.length)
    const serverName = rawServerName ? decodeURIComponent(rawServerName) : 'Server'

    return (
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1 text-[13px] leading-[18px]">
        <Link className="text-muted-foreground hover:text-foreground" to="/dashboard">
          Domain
        </Link>
        <span className="text-subtle-foreground">/</span>
        <Link className="text-muted-foreground hover:text-foreground" to="/jta">
          JTA
        </Link>
        <span className="text-subtle-foreground">/</span>
        <MonoText className="max-w-[240px] truncate">{serverName}</MonoText>
      </nav>
    )
  }

  const current = routeLabels.get(currentPath as (typeof navItems)[number]['path']) ?? 'Dashboard'

  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-[13px] leading-[18px]">
      <Link className="text-muted-foreground hover:text-foreground" to="/dashboard">
        Domain
      </Link>
      <span className="text-subtle-foreground">/</span>
      <span>{current}</span>
    </nav>
  )
}

function EnvironmentIndicator() {
  const status = useEnvironmentStatus()

  return (
    <StatusBadge
      kind="custom"
      tone={status.tone}
      label={`${status.host}:${status.port} · v${status.version}`}
      className="max-w-[320px]"
    />
  )
}

export function AppShell() {
  const { creds, logout } = useAuth()
  const navigate = useNavigate()
  const runtimeConfig = readRuntimeConfig()
  const readOnlyLabel = demoReadOnlyModeLabel(runtimeConfig.readOnlyDemoMode)
  const dashboardQuery = useDomainDashboard()
  const themeMode = useThemeMode()

  useRecordLocalRuntimeAlerts({
    creds,
    snapshot: dashboardQuery.data,
    timestamp: dashboardQuery.dataUpdatedAt,
  })

  function onLogout() {
    logout()
    navigate('/login', { replace: true })
  }

  return (
    <div className="grid h-svh grid-cols-[200px_minmax(0,1fr)] grid-rows-[40px_minmax(0,1fr)] bg-background text-foreground">
      <header className="col-span-2 flex min-h-10 items-center justify-between border-b border-border bg-background px-3">
        <Breadcrumb />
        <div className="flex min-w-0 items-center gap-3">
          {readOnlyLabel ? (
            <StatusBadge kind="custom" tone="warning" label={readOnlyLabel} className="shrink-0" />
          ) : null}
          <QuickJump snapshot={dashboardQuery.data} />
          <ActiveDomainName name={creds?.name} />
          <EnvironmentIndicator />
          <LocalAlertsWidget />
          <ThemeModeControl
            mode={themeMode.mode}
            resolvedMode={themeMode.resolvedMode}
            onModeChange={themeMode.setMode}
          />
          <DiagnosticSnapshotExport snapshot={dashboardQuery.data} />
          <SessionButtons
            domainName={creds?.name}
            username={creds?.username}
            onSwitch={() => navigate('/connections')}
            onSignOut={onLogout}
          />
          {runtimeConfig.shutdownAvailable ? <QuitCockpitButton /> : null}
        </div>
      </header>

      <aside className="border-r border-border bg-surface-1 py-3">
        <nav className="space-y-1 px-2" aria-label="Main">
          {navItems.map((item) => {
            const Icon = item.icon
            return (
              <NavLink
                key={item.path}
                to={item.path}
                className={({ isActive }) =>
                  cn(
                    'flex h-8 items-center gap-2 border-l-2 px-3 text-[13px] leading-[18px] text-muted-foreground hover:bg-white/4 hover:text-foreground',
                    isActive
                      ? 'border-accent bg-accent/8 text-foreground'
                      : 'border-transparent',
                  )
                }
              >
                <Icon className="size-3.5 shrink-0" strokeWidth={1.5} />
                <span className="truncate">{item.label}</span>
              </NavLink>
            )
          })}
        </nav>
      </aside>

      <main className="min-w-0 overflow-auto p-5">
        <ServerMetricCapturePollerHost />
        <EditSessionBanner readOnlyDemoMode={runtimeConfig.readOnlyDemoMode} />
        <Outlet />
      </main>
    </div>
  )
}
