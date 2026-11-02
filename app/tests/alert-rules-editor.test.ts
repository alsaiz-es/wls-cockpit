import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveAlertRules, validateAlertRulesConfig } from '../src/api/alert-rules.ts'
import {
  applyIgnoreRows,
  applyRuleRows,
  parseRuleRow,
  ruleRowsForScope,
  ruleRowsHaveErrors,
} from '../src/routes/alert-rules-editor-model.ts'

const fileConfig = () =>
  validateAlertRulesConfig({
    rules: { 'heap.percent': { warning: 92 } },
    ignore: [{ jms: 'Global*' }],
    domains: {
      'Lab 14.1.2': { rules: { 'jms.noConsumers': { for: '20s' } }, ignore: [{ jdbc: 'Legacy*' }] },
      Prod: { rules: { 'jms.backlog': { warning: 5000 } } },
    },
  }).config

test('rows show the effective value and whether the scope customises it', () => {
  const config = fileConfig()
  const global = ruleRowsForScope(config, 'global', 'Lab 14.1.2')
  assert.deepEqual(global['heap.percent'], { custom: true, dirty: false, enabled: true, warning: '92', critical: '', for: '15m' })
  assert.equal(global['threads.pending'].custom, false)
  assert.equal(global['threads.pending'].warning, '5')

  const lab = ruleRowsForScope(config, 'domain', 'Lab 14.1.2')
  assert.equal(lab['heap.percent'].custom, false)
  assert.equal(lab['heap.percent'].warning, '92')
  assert.deepEqual(lab['jms.noConsumers'], { custom: true, dirty: false, enabled: true, warning: '1', critical: '', for: '20s' })
})

test('untouched rules keep their override, touched ones are written whole', () => {
  const config = fileConfig()
  const rows = ruleRowsForScope(config, 'global', null)
  rows['threads.pending'] = { ...rows['threads.pending'], custom: true, dirty: true, warning: '8' }
  const next = applyRuleRows(config, 'global', null, rows)
  assert.deepEqual(next.rules['heap.percent'], { warning: 92 })
  assert.deepEqual(next.rules['threads.pending'], { enabled: true, warning: 8, critical: 20, forMs: 60_000 })
  assert.deepEqual(next.domains, config.domains)
  assert.deepEqual(next.ignore, config.ignore)
})

test('turning customisation off removes the override; other domains stay as they were', () => {
  const config = fileConfig()
  const rows = ruleRowsForScope(config, 'domain', 'Lab 14.1.2')
  rows['jms.noConsumers'] = { ...rows['jms.noConsumers'], custom: false, dirty: true }
  const next = applyRuleRows(config, 'domain', 'Lab 14.1.2', rows)
  assert.deepEqual(next.domains['Lab 14.1.2'], { rules: {}, ignore: [{ family: 'jdbc', pattern: 'Legacy*' }] })
  assert.deepEqual(next.domains.Prod, config.domains.Prod)
  assert.equal(resolveAlertRules(next, 'Lab 14.1.2').rules['jms.noConsumers'].forMs, 300_000)
})

test('a new connection scope is created on first save', () => {
  const config = fileConfig()
  const rows = ruleRowsForScope(config, 'domain', 'New domain')
  rows['heap.percent'] = { ...rows['heap.percent'], custom: true, dirty: true, enabled: false }
  const next = applyRuleRows(config, 'domain', 'New domain', rows)
  assert.equal(next.domains['New domain'].rules['heap.percent']?.enabled, false)
  assert.equal(resolveAlertRules(next, 'New domain').rules['heap.percent'].enabled, false)
})

test('row validation catches bad numbers, bad durations and inverted levels', () => {
  const base = { custom: true, dirty: true, enabled: true, warning: '5', critical: '20', for: '1m' }
  assert.deepEqual(parseRuleRow(base).errors, {})
  assert.deepEqual(parseRuleRow({ ...base, warning: '', critical: '' }).rule, { enabled: true, warning: null, critical: null, forMs: 60_000 })
  assert.equal(parseRuleRow({ ...base, warning: 'many' }).errors.warning !== undefined, true)
  assert.equal(parseRuleRow({ ...base, for: 'soon' }).errors.for !== undefined, true)
  assert.equal(parseRuleRow({ ...base, warning: '30' }).errors.critical !== undefined, true)

  const config = fileConfig()
  const rows = ruleRowsForScope(config, 'global', null)
  assert.equal(ruleRowsHaveErrors(rows), false)
  rows['jdbc.waiting'] = { ...rows['jdbc.waiting'], custom: true, dirty: true, for: 'later' }
  assert.equal(ruleRowsHaveErrors(rows), true)
})

test('ignore rows drop blank patterns and only change their scope', () => {
  const config = fileConfig()
  const next = applyIgnoreRows(config, 'domain', 'Lab 14.1.2', [
    { family: 'jdbc', pattern: 'Legacy*' },
    { family: 'jms', pattern: '  Demo!*  ' },
    { family: 'servers', pattern: '   ' },
  ])
  assert.deepEqual(next.domains['Lab 14.1.2'].ignore, [
    { family: 'jdbc', pattern: 'Legacy*' },
    { family: 'jms', pattern: 'Demo!*' },
  ])
  assert.deepEqual(next.domains['Lab 14.1.2'].rules, config.domains['Lab 14.1.2'].rules)
  assert.deepEqual(next.ignore, config.ignore)
})
