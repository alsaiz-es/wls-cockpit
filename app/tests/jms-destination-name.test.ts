import assert from 'node:assert/strict'
import test from 'node:test'
import { jmsDestinationDisplayName } from '../src/routes/jms-destination-name.ts'

test('distributed queue members lead with the part that tells them apart', () => {
  assert.deepEqual(jmsDestinationDisplayName('jmsResources!wlsbJMSServer_auto_2@dist_QueueIn_auto_1'), {
    primary: 'dist_QueueIn_auto_1',
    secondary: 'jmsResources · wlsbJMSServer_auto_2',
  })
  assert.deepEqual(jmsDestinationDisplayName('SystemModule!OrdersQueue'), { primary: 'OrdersQueue', secondary: 'SystemModule' })
  assert.deepEqual(jmsDestinationDisplayName('PlainQueue'), { primary: 'PlainQueue', secondary: null })
})
