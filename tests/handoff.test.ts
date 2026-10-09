// The handoff engine kept from ctx-handoff-mod: /baton now, dry, resend, held messages, stage-named failures
import { expect, test } from 'claude-code/testing'
import { HANDOFF, PROJECT, cmd, gate, say, startSession, stop, world, showStatus } from './world'

test('/baton now returns at once, then forks once, clears once, submits once', async ($, on) => {
  const w = world(on)
  const r = await cmd($, 'now')
  expect(r.text).toContain('Creating the handoff')
  expect(w.forks.length).toBe(0)
  await w.clock.settle()
  expect(w.forks.length).toBe(1)
  expect(w.commands).toEqual(['clear'])
  expect(w.submits.length).toBe(1)
  expect(w.submits[0]).toStartWith('[baton] ')
  expect(w.submits[0]).toContain(HANDOFF)
  expect(w.submits[0]).toContain('the user ran /baton now')
  // Delivered: nothing pending
  expect(w.keys().filter(k => k.startsWith('pendingSubmit:'))).toEqual([])
  expect((w.get(`handoffs:${PROJECT}`) as unknown[]).length).toBe(1)
})

test('/baton now while a handoff runs is refused', async ($, on) => {
  const w = world(on)
  const g = gate()
  w.ctl.forkGate = g.wait
  await cmd($, 'now')
  await w.clock.advance(0)
  expect((await cmd($, 'now')).text).toContain('Another handoff is in progress')
  g.open()
  await w.clock.settle()
  expect(w.commands).toEqual(['clear'])
  expect(w.submits.length).toBe(1)
})

test('messages typed during the handoff are held and delivered with it', async ($, on) => {
  const w = world(on)
  const g = gate()
  w.ctl.forkGate = g.wait
  await cmd($, 'now')
  await w.clock.advance(0)
  const r1 = await say($, 'also fix the lint')
  expect(JSON.stringify(r1)).toContain('held')
  // The same text again is held once
  const r2 = await say($, 'also fix the lint')
  expect(JSON.stringify(r2)).toContain('already held')
  g.open()
  await w.clock.settle()
  expect(w.submits.length).toBe(1)
  expect(w.submits[0]).toContain('Messages the user sent during the handoff:')
  expect(w.submits[0]?.match(/also fix the lint/g)?.length).toBe(1)
})

test('generate failure: no clear, no submit, failure stored with stage generate, held messages go back', async ($, on) => {
  const w = world(on)
  const g = gate()
  w.ctl.forkGate = g.wait
  w.ctl.failFork = true
  await cmd($, 'now')
  await w.clock.advance(0)
  await say($, 'are you there?')
  g.open()
  await w.clock.settle()
  expect(w.commands).toEqual([])
  expect(w.submits).toEqual(['are you there?'])
  const f = w.get(`failure:${PROJECT}`) as { stage: string; kind: string; sessionId: string }
  expect(f.stage).toBe('generate')
  expect(f.kind).toBe('manual')
  expect(f.sessionId).toBe('S1')
  expect((await showStatus($)).text).toContain('stage generate')
})

test('fork that never answers times out as a generate failure', async ($, on) => {
  const w = world(on)
  w.ctl.forkGate = () => new Promise<void>(() => {})
  await cmd($, 'now')
  await w.clock.advance(3 * 60_000)
  await w.clock.settle()
  expect(w.commands).toEqual([])
  const f = w.get(`failure:${PROJECT}`) as { stage: string; reason: string }
  expect(f.stage).toBe('generate')
  expect(f.reason).toContain('timeout')
  expect((await cmd($, 'now')).text).toContain('Creating the handoff')
})

test('clear failure: stays in the old session, nothing pending, stage clear', async ($, on) => {
  const w = world(on)
  w.ctl.onClear = () => { throw new Error('clear boom') }
  await cmd($, 'now')
  await w.clock.settle()
  expect(w.commands).toEqual(['clear'])
  expect(w.submits).toEqual([])
  expect(w.keys().filter(k => k.startsWith('pendingSubmit:'))).toEqual([])
  expect((w.get(`failure:${PROJECT}`) as { stage: string }).stage).toBe('clear')
  expect((await cmd($, 'resend')).text).toContain('Resending')
})

test('submit failure: pending kept, stage submit, /baton resend delivers it and clears pending', async ($, on) => {
  const w = world(on)
  w.ctl.failSubmits = 1
  await cmd($, 'now')
  await w.clock.settle()
  expect(w.commands).toEqual(['clear'])
  expect(w.submits).toEqual([])
  expect(w.get('pendingSubmit:S1')).toMatchObject({ sessionId: 'S1', project: 'C--proj', file: '.claude/handoff/S1.md' })
  expect((w.get('pendingSubmit:S1') as { text: string }).text).toContain(HANDOFF)
  expect((w.get(`failure:${PROJECT}`) as { stage: string }).stage).toBe('submit')
  expect(w.toasts.join()).toContain('/baton resend')
  expect((await showStatus($)).text).toContain('Undelivered handoff: yes')
  expect((await cmd($, 'resend')).text).toContain('Resending')
  await w.clock.settle()
  expect(w.submits.length).toBe(1)
  expect(w.submits[0]).toContain(HANDOFF)
  expect(w.get('pendingSubmit:S1')).toBeUndefined()
  // Still exactly one clear for one request
  expect(w.commands).toEqual(['clear'])
})

test('/baton dry generates and shows the handoff without clearing', async ($, on) => {
  const w = world(on)
  const r = await cmd($, 'dry')
  expect(r.text).toContain('Trial run done')
  expect(r.text).toContain(HANDOFF)
  expect(w.commands).toEqual([])
  expect(w.submits).toEqual([])
})

test('/baton resend with nothing to resend says so', async ($, on) => {
  world(on)
  expect((await cmd($, 'resend')).text).toContain('No handoff to resend')
})

test('/baton status shows context, background work, and usage', async ($, on) => {
  world(on, 123_456)
  await stop($, { background_tasks: [{ id: 'b1', type: 'shell', status: 'running', description: 'sleep' }] as never })
  const text = (await showStatus($)).text
  expect(text).toContain('Context: 12% (123,456 of 1,000,000 tokens) · threshold 40% (not reached)')
  expect(text).toContain('Background (last Stop): 1 task, 0 one-off schedules, 0 recurring schedules')
  expect(text).toContain('/baton now')
})

test('unknown subcommand lists usage', async ($, on) => {
  world(on)
  const text = (await cmd($, 'distill')).text
  expect(text).toContain('Unknown subcommand "distill"')
  expect(text).toContain('Usage:')
})

test('a Stop without a Yes never hands off', async ($, on) => {
  const w = world(on, 990_000)
  await stop($)
  await w.clock.settle()
  expect(w.forks).toEqual([])
  expect(w.commands).toEqual([])
})

test('falls back to /baton-handoff when /baton is taken', async ($, on) => {
  const w = world(on)
  w.ctl.taken.add('baton')
  await startSession($)
  expect(w.ctl.registered).toEqual(['baton', 'baton-handoff'])
  expect(w.logs.join()).toContain('using /baton-handoff instead')
})
