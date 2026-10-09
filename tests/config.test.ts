// Configuration: defaults and validation (src/config.ts), and what /baton shows for it
import { expect, test } from 'claude-code/testing'
import { DEFAULTS, projectRelativeDir, resolveConfig } from '../src/config'
import { cmd, startSession, world, showStatus } from './world'

test('no options: the defaults, no problems', () => {
  expect(resolveConfig({})).toEqual({ config: DEFAULTS, problems: [] })
  expect(DEFAULTS).toEqual({ thresholdPercent: 40, snoozePoints: 10, handoffDir: '.claude/handoff' })
})

test('valid values are kept, including the range ends', () => {
  const { config, problems } = resolveConfig({ thresholdPercent: 10, snoozePoints: 50, handoffDir: 'docs/handoffs/' })
  expect(problems).toEqual([])
  expect(config).toEqual({ thresholdPercent: 10, snoozePoints: 50, handoffDir: 'docs/handoffs' })
  expect(resolveConfig({ thresholdPercent: 90, snoozePoints: 1 }).problems).toEqual([])
})

test('out-of-range values are rejected with a clear message and fall back to the default', () => {
  const { config, problems } = resolveConfig({ thresholdPercent: 9, snoozePoints: 51 })
  expect(config).toEqual(DEFAULTS)
  expect(problems).toEqual([
    'thresholdPercent: 9 is outside 10–90, using 40',
    'snoozePoints: 51 is outside 1–50, using 10',
  ])
  expect(resolveConfig({ thresholdPercent: 91 }).problems).toEqual(['thresholdPercent: 91 is outside 10–90, using 40'])
})

test('non-integer values are rejected', () => {
  const { config, problems } = resolveConfig({ thresholdPercent: 40.5, snoozePoints: '10' })
  expect(config.thresholdPercent).toBe(40)
  expect(config.snoozePoints).toBe(10)
  expect(problems).toEqual([
    'thresholdPercent: 40.5 is not a whole number, using 40',
    'snoozePoints: 10 is not a whole number, using 10',
  ])
})

test('handoffDir must stay inside the project', () => {
  expect(projectRelativeDir('.claude/handoff')).toBe('.claude/handoff')
  expect(projectRelativeDir('./notes\\handoff/')).toBe('notes/handoff')
  expect(projectRelativeDir('a/../b')).toBe('b')
  for (const bad of ['', '  ', '.', '..', '../x', 'a/../../x', '/etc', 'C:/x', 'c:x', '~/x', '\\\\server\\share']) {
    expect(projectRelativeDir(bad)).toBeUndefined()
  }
  expect(resolveConfig({ handoffDir: '../outside' })).toEqual({
    config: DEFAULTS,
    problems: ['handoffDir: "../outside" is not a folder inside the project, using .claude/handoff'],
  })
})

test('/baton shows the configured threshold and the real percentage', { options: { thresholdPercent: 30 } }, async ($, on) => {
  world(on, 312_000)
  const text = (await showStatus($)).text
  expect(text).toContain('Context: 31% (312,000 of 1,000,000 tokens) · threshold 30% (reached)')
  expect(text).toContain('Settings: threshold 30%, snooze 10 points, handoff folder .claude/handoff')
  expect(text).not.toContain('Setting ignored')
})

test('/baton uses the engine percent when present', async ($, on) => {
  const w = world(on, 399_999)
  w.ctl.percent = 40
  expect((await showStatus($)).text).toContain('Context: 40% (399,999 of 1,000,000 tokens) · threshold 40% (reached)')
  w.ctl.percent = undefined
  expect((await showStatus($)).text).toContain('Context: 39% (399,999 of 1,000,000 tokens) · threshold 40% (not reached)')
})

test('/baton on a 200k window', async ($, on) => {
  world(on, 80_000, 200_000)
  expect((await showStatus($)).text).toContain('Context: 40% (80,000 of 200,000 tokens) · threshold 40% (reached)')
})

test('/baton before the first response: not measured yet', async ($, on) => {
  world(on, null)
  expect((await showStatus($)).text).toContain('Context: not measured yet (start of session or right after /clear; window 1,000,000 tokens) · threshold 40%')
})

test('rejected settings are shown in /baton and logged once at session start', { options: { thresholdPercent: 5 } }, async ($, on) => {
  const w = world(on)
  await startSession($)
  expect(w.logs.join()).toContain('settings ignored: thresholdPercent: 5 is outside 10–90, using 40')
  const text = (await showStatus($)).text
  expect(text).toContain('Settings: threshold 40%')
  expect(text).toContain('Setting ignored: thresholdPercent: 5 is outside 10–90, using 40')
})
