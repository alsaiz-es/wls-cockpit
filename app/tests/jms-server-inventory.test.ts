import assert from 'node:assert/strict'
import test from 'node:test'
import { jmsServerInventory } from '../src/routes/jms-server-inventory.ts'

const dest = (jmsServerName: string, destinationName: string | null, messages: number, consumers: number) => ({
  serverName: 'osb_server1',
  jmsServerName,
  destinationName,
  messagesCurrentCount: messages,
  messagesPendingCount: 0,
  consumersCurrentCount: consumers,
})

test('the JMS inventory sums destinations per JMS server and counts stalled ones', () => {
  const inventory = jmsServerInventory([
    dest('wlsbJMSServer_auto_2', null, 0, 0),
    dest('wlsbJMSServer_auto_2', 'dist_QueueIn_auto_1', 4, 0),
    dest('wlsbJMSServer_auto_2', 'dist_AlertQueue_auto_1', 0, 2),
    dest('UMSJMSServer_auto_2', 'dist_OraSDPM_auto_1', 1, 1),
  ])
  assert.deepEqual(
    inventory.map(({ jmsServerName, destinations, messages, consumers, stalled }) => ({ jmsServerName, destinations, messages, consumers, stalled })),
    [
      { jmsServerName: 'UMSJMSServer_auto_2', destinations: 1, messages: 1, consumers: 1, stalled: 0 },
      { jmsServerName: 'wlsbJMSServer_auto_2', destinations: 2, messages: 4, consumers: 2, stalled: 1 },
    ],
  )
})
