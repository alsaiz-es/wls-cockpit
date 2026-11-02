import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_LIVE_POLL_INTERVAL_MS } from '../src/api/query-polling.ts'
import {
  EDIT_SESSION_STATUS_FIELDS,
  EDIT_SESSION_STATUS_POLL_INTERVAL_MS,
  editSessionActionRequestOptions,
  normalizeEditSessionStatus,
} from '../src/api/queries/edit-sessions.ts'
import type { WlsCredentials } from '../src/api/client.ts'

const creds: WlsCredentials = {
  profileId: 'local',
  name: 'Local',
  targetUrl: 'http://wls-admin.example.com:7001',
  username: 'admin',
  password: 'secret',
  version: '14.1.2.0.0',
}

test('edit-session status polling is slower than live runtime polling and requests an allow-list', () => {
  assert.equal(EDIT_SESSION_STATUS_POLL_INTERVAL_MS > DEFAULT_LIVE_POLL_INTERVAL_MS, true)
  assert.equal(EDIT_SESSION_STATUS_FIELDS, 'locked,lockOwner,hasChanges,mergeNeeded,editSession')
})

test('normalizes idle edit-session status as hidden and non-actionable', () => {
  assert.deepEqual(
    normalizeEditSessionStatus(
      {
        locked: false,
        mergeNeeded: false,
        editSession: 'default',
      },
      { username: 'admin', fetchedAt: 100 },
    ),
    {
      state: 'idle',
      locked: false,
      lockOwner: null,
      editSession: 'default',
      hasPendingChanges: null,
      pendingChangeCount: null,
      mergeNeeded: false,
      ownership: 'none',
      ownerEvidence: null,
      canActivate: false,
      canCancel: false,
      visible: false,
      unavailableFields: ['hasChanges'],
      fetchedAt: 100,
    },
  )
})

test('allows current lock owner to activate pending changes and cancel the session', () => {
  const status = normalizeEditSessionStatus(
    {
      locked: true,
      lockOwner: 'admin',
      hasChanges: true,
      mergeNeeded: false,
      editSession: 'default',
    },
    { username: 'admin' },
  )

  assert.equal(status.state, 'pending')
  assert.equal(status.ownership, 'current-user')
  assert.equal(status.canActivate, true)
  assert.equal(status.canCancel, true)
  assert.equal(status.visible, true)
  assert.equal(status.ownerEvidence, 'admin')
})

test('keeps actions disabled when ownership is unclear or belongs to another user', () => {
  const otherUser = normalizeEditSessionStatus(
    {
      locked: true,
      lockOwner: 'other-admin',
      hasChanges: true,
      mergeNeeded: false,
      editSession: 'default',
    },
    { username: 'admin' },
  )
  const unknownOwner = normalizeEditSessionStatus(
    {
      locked: true,
      hasChanges: true,
      mergeNeeded: false,
      editSession: 'default',
    },
    { username: 'admin' },
  )

  assert.equal(otherUser.ownership, 'other-user')
  assert.equal(otherUser.canActivate, false)
  assert.equal(otherUser.canCancel, false)
  assert.equal(unknownOwner.ownership, 'unknown')
  assert.equal(unknownOwner.ownerEvidence, 'Lock owner unavailable')
  assert.equal(unknownOwner.canActivate, false)
  assert.equal(unknownOwner.canCancel, false)
})

test('marks merge-needed status as conflict and blocks actions', () => {
  const status = normalizeEditSessionStatus(
    {
      locked: true,
      lockOwner: 'admin',
      hasChanges: true,
      mergeNeeded: true,
      editSession: 'default',
    },
    { username: 'admin' },
  )

  assert.equal(status.state, 'conflict')
  assert.equal(status.canActivate, false)
  assert.equal(status.canCancel, false)
})

test('edit-session actions send explicit CSRF header and empty JSON body', () => {
  assert.deepEqual(editSessionActionRequestOptions(creds), {
    params: {
      path: { version: '14.1.2.0.0' },
      header: { 'X-Requested-By': 'wls-cockpit' },
    },
    body: {},
  })
})
