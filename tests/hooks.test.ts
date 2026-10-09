// Failure handlers (.catch) of the gating hooks: Stop does nothing, a message goes through, a command answers an error
import { expect, test } from 'claude-code/testing'
import { cmd, gate, say, stop, world } from './world'

test('command.run failure answers a short error text', async ($, on) => {
  const w = world(on)
  w.ctl.failUsage = true
  const r = await cmd($, '')
  expect(r.text).toStartWith('/baton failed: ')
  expect(r.text).toContain('usage boom')
  expect(w.logs.join()).not.toContain('/baton failed')
  expect(w.forks).toEqual([])
})

test('prompt.submit failure lets the user message through unchanged (not held)', async ($, on) => {
  const w = world(on, 400_000, 1_000_000, { manualClock: true })
  const g = gate()
  const forking = gate()
  w.ctl.forkGate = () => { forking.open(); return g.wait() }
  await cmd($, 'now')
  await forking.wait()
  // While a handoff runs the hook reads the clock to report the wait; make that fail
  w.ctl.failClock = true
  const r = await say($, 'hello')
  w.ctl.failClock = false
  expect(JSON.stringify(r)).not.toContain('drop')
  expect(w.submits).toEqual(['hello'])
  expect(w.logs.join()).toContain('message check failed, the message was sent unchanged')
  const delivered = w.nextSubmit()
  g.open()
  await delivered
  // The handoff still completes once, without the message in its held block
  expect(w.commands).toEqual(['clear'])
  expect(w.submits.length).toBe(2)
  expect(w.submits[1]).not.toContain('Messages the user sent during the handoff')
})

test('Stop failure does nothing: no fork, no clear, the Stop result stands', async ($, on) => {
  const w = world(on)
  // A malformed task entry makes the Stop hook throw
  const r = await stop($, { background_tasks: [null] as never })
  expect(r.block).toBeUndefined()
  await w.clock.settle()
  expect(w.forks).toEqual([])
  expect(w.commands).toEqual([])
  expect(w.logs.join()).toContain('Stop check failed')
})

test('the handoff submit (re-entry into prompt.submit) is not logged as a failure', async ($, on) => {
  const w = world(on)
  await cmd($, 'now')
  await w.clock.settle()
  expect(w.submits.length).toBe(1)
  expect(w.logs.join()).not.toContain('message check failed')
})
