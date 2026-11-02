import type { DashboardIssue, DashboardSnapshot } from '@/api/queries/domain-dashboard'

type FixtureName = 'healthy' | 'warning' | 'critical' | 'partial'

const baseSnapshot: DashboardSnapshot = {
  severity: 'healthy',
  servers: [
    {
      name: 'AdminServer',
      state: 'RUNNING',
      healthState: 'ok',
      listenAddress: 'localhost',
      listenPort: 7001,
      restartRequired: false,
      heap: { current: 384 * 1024 * 1024, committed: 640 * 1024 * 1024, max: 1024 * 1024 * 1024 },
      jvm: {
        uptime: 3_600_000,
        javaVersion: '17.0.10',
        javaVendor: 'Oracle Corporation',
        javaVmVendor: 'Oracle Corporation',
        osName: 'Linux',
        osVersion: '5.15',
        processCpuLoad: 0.12,
      },
      threads: {
        total: 12,
        idle: 8,
        standby: 2,
        pending: 0,
        queueLength: 0,
        hogging: 0,
        stuck: 0,
      },
    },
    {
      name: 'server1',
      state: 'SHUTDOWN',
      healthState: 'unknown',
      listenAddress: null,
      listenPort: null,
      restartRequired: null,
      heap: null,
      jvm: null,
      threads: null,
    },
  ],
  serverRollup: {
    total: 2,
    running: 1,
    warning: 0,
    stopped: 1,
    failed: 0,
    unknown: 0,
  },
  runtimePressure: {
    highestHeap: {
      serverName: 'AdminServer',
      current: 384 * 1024 * 1024,
      max: 1024 * 1024 * 1024,
      percent: 0.375,
    },
    heapUnavailable: 0,
    heapUnavailableServers: [],
    totalThreads: 12,
    idleThreads: 8,
    pendingUserRequests: 0,
    hoggingThreads: 0,
    queueLength: 0,
    stuckThreads: 0,
    threadsUnavailable: 0,
    threadsUnavailableServers: [],
  },
  jdbc: {
    status: 'empty',
    items: [],
  },
  jms: {
    status: 'empty',
    items: [],
  },
  jmsRollup: {
    jmsServers: 0,
    destinations: 0,
    messagesCurrent: 0,
    messagesPending: 0,
    zeroConsumerBacklog: 0,
    paused: 0,
  },
  applications: {
    status: 'available',
    items: [
      {
        serverName: 'AdminServer',
        name: 'WLS Management Services',
        deploymentName: 'wls-management-services',
        internal: true,
        healthState: 'ok',
        overallHealthState: 'ok',
        activeVersionState: 2,
        deploymentState: null,
        healthReason: null,
        severity: 'healthy',
      },
    ],
  },
  applicationRollup: {
    total: 1,
    internal: 1,
    external: 0,
    healthy: 1,
    unhealthy: 0,
  },
  logs: {
    status: 'available',
    items: [
      {
        serverName: 'AdminServer',
        messagesLogged: 0,
        logFileStreamOpened: true,
        status: 'available',
      },
    ],
  },
  issues: [],
  partialFailures: [],
}

const warningIssue: DashboardIssue = {
  id: 'jdbc:AdminServer:OrdersDS',
  severity: 'warning',
  family: 'jdbc',
  title: 'OrdersDS is near capacity',
  detail: 'State Running, active 90, max 100, created 10, waiting 0, leaked 0.',
  serverName: 'AdminServer',
  resourceName: 'OrdersDS',
}

const threadWarningIssue: DashboardIssue = {
  id: 'threads:AdminServer',
  severity: 'warning',
  family: 'threads',
  title: 'AdminServer has execution pressure',
  detail: 'Pending 0, hogging 2, stuck 0, queue 2.',
  serverName: 'AdminServer',
}

const jmsWarningIssue: DashboardIssue = {
  id: 'jms:AdminServer:DemoJMSServer:OrdersQueue',
  severity: 'warning',
  family: 'jms',
  title: 'OrdersQueue has JMS pressure',
  detail: 'Messages 12, pending 3, consumers 0, paused no.',
  serverName: 'AdminServer',
  resourceName: 'OrdersQueue',
  jmsServerName: 'DemoJMSServer',
  destinationName: 'OrdersQueue',
}

const criticalIssue: DashboardIssue = {
  id: 'server:server1',
  severity: 'critical',
  family: 'servers',
  title: 'server1 requires attention',
  detail: 'Lifecycle FAILED_NOT_RESTARTABLE, health failed.',
  serverName: 'server1',
}

export function dashboardVisualFixture(name: FixtureName): DashboardSnapshot {
  if (name === 'healthy') return baseSnapshot

  if (name === 'warning') {
    return {
      ...baseSnapshot,
      severity: 'warning',
      servers: baseSnapshot.servers.map((server) =>
        server.name === 'AdminServer' && server.threads
          ? {
              ...server,
              threads: {
                ...server.threads,
                queueLength: 2,
                hogging: 2,
              },
            }
          : server,
      ),
      runtimePressure: {
        ...baseSnapshot.runtimePressure,
        hoggingThreads: 2,
        queueLength: 2,
      },
      jdbc: {
        status: 'available',
        items: [
          {
            serverName: 'AdminServer',
            name: 'OrdersDS',
            state: 'Running',
            deploymentState: 2,
            activeConnectionsCurrentCount: 90,
            currCapacity: 10,
            configuredMaxCapacity: 100,
            waitingForConnectionCurrentCount: 0,
            leakedConnectionCount: 0,
            utilization: 0.9,
            utilizationCapacity: 100,
            utilizationCapacitySource: 'configuredMax',
            severity: 'warning',
          },
        ],
      },
      jms: {
        status: 'available',
        items: [
          {
            serverName: 'AdminServer',
            jmsServerName: 'DemoJMSServer',
            destinationName: 'OrdersQueue',
            destinationType: 'Queue',
            state: 'running',
            destinationsCurrentCount: null,
            messagesCurrentCount: 12,
            messagesPendingCount: 3,
            consumersCurrentCount: 0,
            consumptionPaused: false,
            productionPaused: false,
            insertionPaused: false,
            consumptionPausedState: 'Consumption-Enabled',
            productionPausedState: 'Production-Enabled',
            insertionPausedState: 'Insertion-Enabled',
            severity: 'warning',
          },
        ],
      },
      jmsRollup: {
        jmsServers: 1,
        destinations: 1,
        messagesCurrent: 12,
        messagesPending: 3,
        zeroConsumerBacklog: 1,
        paused: 0,
      },
      issues: [warningIssue, threadWarningIssue, jmsWarningIssue],
    }
  }

  if (name === 'critical') {
    return {
      ...baseSnapshot,
      severity: 'critical',
      serverRollup: {
        total: 2,
        running: 1,
        warning: 0,
        stopped: 0,
        failed: 1,
        unknown: 0,
      },
      issues: [criticalIssue, warningIssue],
    }
  }

  return {
    ...baseSnapshot,
    logs: {
      status: 'failed',
      items: [],
      error: 'logs: HTTP 404 Not Found',
    },
    partialFailures: [{ family: 'logs', message: 'logs: HTTP 404 Not Found' }],
  }
}
