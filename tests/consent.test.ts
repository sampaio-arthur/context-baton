// Consent and snooze: the question at the end of a turn, what counts as No, the snooze mark, silent deferral
import { expect, test } from 'claude-code/testing'
import { HEADER, consentOf, questionOf, rejectionOf, snoozeMarkOf } from '../src/consent'
import { deferralOf } from '../src/deferral'
import { cmd, stop, world, showStatus } from './world'

const Q40 = 'Context is at 40%. Hand off and continue in a new session?'

// ---------- pure ----------

test('only the exact Yes label is a yes', () => {
  expect(consentOf('Yes')).toBe('yes')
  for (const a of ['No', 'yes', 'YES', 'Yes ', ' Yes', 'Yes, please', 'sim', '']) expect(consentOf(a)).toBe('no')
})

test('question and header', () => {
  expect(questionOf(41)).toBe('Context is at 41%. Hand off and continue in a new session?')
  expect(HEADER).toBe('Baton')
  expect(HEADER.length).toBeLessThanOrEqual(12)
  expect(snoozeMarkOf(40, 10)).toBe(50)
})

test('rejectionOf: user dismissals are quiet, anything else carries its reason', () => {
  const esc = new Error('context-baton: $.ui.ask: no answer (The user doesn\'t want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_strin)')
  expect(rejectionOf(esc)).toEqual({ kind: 'dismissed' })
  expect(rejectionOf(new Error('context-baton: $.ui.ask: no answer (the dialog was dismissed)'))).toEqual({ kind: 'dismissed' })
  expect(rejectionOf(new Error('context-baton: $.ui.ask: no answer (Permission to use AskUserQuestion has been denied by policy)')))
    .toEqual({ kind: 'other', reason: 'Permission to use AskUserQuestion has been denied by policy' })
  const none = 'HooksError: context-baton: $.tool.call: no tool named "AskUserQuestion" in this session'
  expect(rejectionOf(new Error(none))).toEqual({ kind: 'unavailable', reason: none })
  expect(rejectionOf('something else')).toEqual({ kind: 'other', reason: 'something else' })
})

test('deferralOf: wait for tasks, one-shot schedules and subagents; not for recurring schedules; stop waiting at 90%', () => {
  const none = { tasks: 0, oneShot: 0, recurring: 0 }
  expect(deferralOf(none, 0, 45)).toBe('proceed')
  expect(deferralOf({ ...none, recurring: 2 }, 0, 45)).toBe('proceed')
  expect(deferralOf({ ...none, tasks: 1 }, 0, 45)).toBe('defer')
  expect(deferralOf({ ...none, oneShot: 1 }, 0, 45)).toBe('defer')
  expect(deferralOf(none, 1, 45)).toBe('defer')
  expect(deferralOf({ ...none, tasks: 1 }, 0, 89)).toBe('defer')
  expect(deferralOf({ ...none, tasks: 1 }, 0, 90)).toBe('proceed-at-cap')
})

// ---------- the flow ----------

test('below the threshold: no question', async ($, on) => {
  const w = world(on, 399_999)
  await stop($)
  await w.clock.settle()
  expect(w.asks).toEqual([])
})

test('usage not measured yet: no question', async ($, on) => {
  const w = world(on, null)
  await stop($)
  await w.clock.settle()
  expect(w.asks).toEqual([])
})

test('at the threshold: one question with the real percentage', async ($, on) => {
  const w = world(on, 400_000)
  await stop($)
  await w.clock.settle()
  expect(w.asks).toEqual([Q40])
})

test('the engine percent is what the question shows', async ($, on) => {
  const w = world(on, 399_999)
  w.ctl.percent = 40
  await stop($)
  await w.clock.settle()
  expect(w.asks).toEqual([Q40])
})

test('No: nothing forked, cleared or submitted; no second question at the same usage; snooze shown in /baton', async ($, on) => {
  const w = world(on, 400_000)
  await stop($)
  await w.clock.settle()
  expect(w.asks.length).toBe(1)
  expect(w.forks).toEqual([])
  expect(w.commands).toEqual([])
  expect(w.submits).toEqual([])
  expect(w.get('snooze:S1')).toEqual({ mark: 50, at: 0, after: 'no' })
  await stop($)
  await w.clock.settle()
  w.ctl.tokens = 499_999
  await stop($)
  await w.clock.settle()
  expect(w.asks.length).toBe(1)
  expect((await showStatus($)).text).toContain('Snoozed after a No: will ask again at 50%')
  // At the mark it asks again
  w.ctl.tokens = 500_000
  await stop($)
  await w.clock.settle()
  expect(w.asks.length).toBe(2)
  expect(w.asks[1]).toBe('Context is at 50%. Hand off and continue in a new session?')
  expect(w.get('snooze:S1')).toEqual({ mark: 60, at: 0, after: 'no' })
})

test('the snooze mark survives a plugin reload (it is in the store, not in memory)', async ($, on) => {
  // A fresh load of the plugin finds the mark an earlier load stored after a No
  const w = world(on, 450_000, 1_000_000, { store: { 'snooze:S1': { mark: 50, at: 0 } } })
  await stop($)
  await w.clock.settle()
  expect(w.asks).toEqual([])
  w.ctl.tokens = 500_000
  await stop($)
  await w.clock.settle()
  expect(w.asks.length).toBe(1)
})

test('the snooze mark belongs to its session: a new session id asks again', async ($, on) => {
  const w = world(on, 450_000, 1_000_000, { store: { 'snooze:S0': { mark: 90, at: 0 } } })
  await stop($)
  await w.clock.settle()
  expect(w.asks.length).toBe(1)
})

test('Esc (dismissed) is a No, and is not logged', async ($, on) => {
  const w = world(on)
  w.ctl.answer = null
  await stop($)
  await w.clock.settle()
  expect(w.asks.length).toBe(1)
  expect(w.forks).toEqual([])
  expect(w.commands).toEqual([])
  expect(w.get('snooze:S1')).toEqual({ mark: 50, at: 0, after: 'no' })
  expect(w.logs.join()).not.toContain('could not ask')
})

test('text typed under Other is a No unless it is exactly Yes', async ($, on) => {
  const w = world(on)
  w.ctl.answer = 'yes please'
  await stop($)
  await w.clock.settle()
  expect(w.forks).toEqual([])
  expect(w.get('snooze:S1')).toEqual({ mark: 50, at: 0, after: 'no' })
})

test('AskUserQuestion denied: a No, with the reason logged once per session', async ($, on) => {
  const w = world(on)
  w.ctl.answer = { deny: 'denied by policy' }
  await stop($)
  await w.clock.settle()
  expect(w.forks).toEqual([])
  w.ctl.tokens = 500_000
  await stop($)
  await w.clock.settle()
  expect(w.asks.length).toBe(2)
  const lines = w.logs.filter(l => l.includes('could not ask whether to hand off'))
  expect(lines.length).toBe(1)
  expect(lines[0]).toContain('denied by policy')
  expect(lines[0]).toContain('/baton now')
})

test('Yes: full handoff with no further input, the reason names the percentage', async ($, on) => {
  const w = world(on, 412_000)
  w.ctl.answer = 'Yes'
  await stop($)
  await w.clock.settle()
  expect(w.asks).toEqual(['Context is at 41%. Hand off and continue in a new session?'])
  expect(w.forks.length).toBe(1)
  expect(w.commands).toEqual(['clear'])
  expect(w.submits.length).toBe(1)
  expect(w.submits[0]).toContain('context reached 41% of the window and the user agreed to hand off')
  expect(w.get('snooze:S1')).toBeUndefined()
  expect((w.get('handoffs:C--proj') as { kind: string }[])[0]?.kind).toBe('threshold')
})

test('two Stops in quick succession: one question, one switch', async ($, on) => {
  const w = world(on)
  w.ctl.answer = 'Yes'
  await stop($)
  await stop($)
  await w.clock.settle()
  expect(w.asks.length).toBe(1)
  expect(w.commands).toEqual(['clear'])
  expect(w.submits.length).toBe(1)
})

test('/baton now while the question is open is refused', async ($, on) => {
  const w = world(on)
  await stop($)
  expect((await cmd($, 'now')).text).toContain('Another handoff is in progress')
  await w.clock.settle()
  expect(w.forks).toEqual([])
})

test('a subagent Stop or a blocked Stop does not ask', async ($, on) => {
  const w = world(on)
  await stop($, { agent_id: 'a1' } as never)
  w.ctl.stopBlock = 'keep going'
  await stop($)
  await w.clock.settle()
  expect(w.asks).toEqual([])
})

test('background task running: silent deferral, then the question once it finished', async ($, on) => {
  const w = world(on, 450_000)
  const running = [{ id: 'b1', type: 'shell', status: 'running', description: 'npm test' }]
  await stop($, { background_tasks: running } as never)
  await w.clock.settle()
  expect(w.asks).toEqual([])
  expect(w.logs).toEqual([])
  expect(w.toasts).toEqual([])
  await stop($, { background_tasks: [{ ...running[0], status: 'completed' }] } as never)
  await w.clock.settle()
  expect(w.asks.length).toBe(1)
})

test('running subagent or one-shot schedule: silent deferral', async ($, on) => {
  const w = world(on, 450_000)
  w.ctl.agents = [{ id: 'a1', status: 'running' }]
  await stop($)
  await w.clock.settle()
  expect(w.asks).toEqual([])
  w.ctl.agents = [{ id: 'a1', status: 'completed' }]
  await stop($, { session_crons: [{ id: 'c1', schedule: '0 9 * * *', recurring: false, prompt: 'check' }] } as never)
  await w.clock.settle()
  expect(w.asks).toEqual([])
  await stop($, { session_crons: [{ id: 'c1', schedule: '0 9 * * *', recurring: true, prompt: 'check' }] } as never)
  await w.clock.settle()
  expect(w.asks.length).toBe(1)
})

test('at 90% the question comes even with background work, and the handoff says so', async ($, on) => {
  const w = world(on, 900_000)
  w.ctl.answer = 'Yes'
  await stop($, { background_tasks: [{ id: 'b1', type: 'shell', status: 'running', description: 'sleep' }] } as never)
  await w.clock.settle()
  expect(w.asks.length).toBe(1)
  expect(w.submits[0]).toContain('background work was still running when context reached 90%')
})

test('/baton says when a handoff is held back by background work, and stops saying it once the work is done', async ($, on) => {
  const w = world(on, 450_000)
  w.ctl.agents = [{ id: 'a1', status: 'running' }]
  const running = [{ id: 'b1', type: 'shell', status: 'running', description: 'npm test' }]
  await stop($, { background_tasks: running } as never)
  await w.clock.settle()
  expect((await showStatus($)).text).toContain('Waiting for background work to finish before asking: 1 task, 0 one-off schedules, 1 subagent (asks anyway at 90%)')
  // Still silent: nothing logged or toasted by the Stop itself
  expect(w.toasts).toEqual([])
  w.ctl.agents = []
  await stop($, { background_tasks: [{ ...running[0], status: 'completed' }] } as never)
  await w.clock.settle()
  expect(w.asks.length).toBe(1)
  expect((await showStatus($)).text).not.toContain('Waiting for background work')
})

test('below the threshold, running work is not reported as holding anything back', async ($, on) => {
  const w = world(on, 100_000)
  await stop($, { background_tasks: [{ id: 'b1', type: 'shell', status: 'running', description: 'x' }] } as never)
  await w.clock.settle()
  expect((await showStatus($)).text).not.toContain('Waiting for background work')
})
