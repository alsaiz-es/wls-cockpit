import assert from 'node:assert/strict'
import test from 'node:test'
import type { DashboardIssue } from '../src/api/queries/domain-dashboard.ts'
import { issueTarget } from '../src/routes/dashboard/format.ts'

test('application issue targets use deployment identity instead of display name', () => {
  const issue: DashboardIssue = {
    id: 'app:AdminServer:wls-management-services',
    severity: 'warning',
    family: 'applications',
    title: 'WLS Management Services is not healthy',
    detail: 'Health warn/warn, deployment n/a.',
    serverName: 'AdminServer',
    resourceName: 'WLS Management Services',
    deploymentName: 'wls-management-services',
  }

  assert.deepEqual(issueTarget(issue), {
    label: 'Deployments',
    href: '/deployments/AdminServer/wls-management-services',
  })
})

test('application issue targets fall back to resource name when deployment identity is absent', () => {
  const issue: DashboardIssue = {
    id: 'app:AdminServer:LegacyApp',
    severity: 'warning',
    family: 'applications',
    title: 'LegacyApp is not healthy',
    detail: 'Health warn/warn, deployment n/a.',
    serverName: 'AdminServer',
    resourceName: 'LegacyApp',
  }

  assert.deepEqual(issueTarget(issue), {
    label: 'Deployments',
    href: '/deployments/AdminServer/LegacyApp',
  })
})

test('JMS destination issue targets destination detail when full identity is present', () => {
  const issue: DashboardIssue = {
    id: 'jms:AdminServer:DemoJMSServer:OrdersQueue',
    severity: 'warning',
    family: 'jms',
    title: 'OrdersQueue has JMS pressure',
    detail: 'Messages 7, pending 0, consumers 0, paused no.',
    serverName: 'AdminServer',
    resourceName: 'OrdersQueue',
    jmsServerName: 'DemoJMSServer',
    destinationName: 'OrdersQueue',
  }

  assert.deepEqual(issueTarget(issue), {
    label: 'JMS OrdersQueue',
    href: '/jms/AdminServer/DemoJMSServer/OrdersQueue',
  })
})

test('JMS summary issue targets filtered JMS list when destination identity is absent', () => {
  const issue: DashboardIssue = {
    id: 'jms:AdminServer:DemoJMSServer:DemoJMSServer',
    severity: 'warning',
    family: 'jms',
    title: 'DemoJMSServer has JMS pressure',
    detail: 'Messages 7, pending 0, consumers n/a, paused no.',
    serverName: 'AdminServer',
    resourceName: 'DemoJMSServer',
    jmsServerName: 'DemoJMSServer',
  }

  assert.deepEqual(issueTarget(issue), {
    label: 'JMS DemoJMSServer',
    href: '/jms?server=AdminServer&jmsServer=DemoJMSServer',
  })
})

test('JMS issue preserves explicit unavailable target when identity is incomplete', () => {
  const issue: DashboardIssue = {
    id: 'jms:unknown',
    severity: 'warning',
    family: 'jms',
    title: 'JMS has pressure',
    detail: 'JMS identity unavailable.',
  }

  assert.deepEqual(issueTarget(issue), {
    label: 'JMS target unavailable',
    href: '/dashboard',
  })
})
