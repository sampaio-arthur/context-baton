// Pure modules in src/
import { expect, test } from 'claude-code/testing'
import { snapshotOf } from '../src/deferral'
import { forkFailure, submitText } from '../src/handoff'
import { encodeProject, pruneSeen, workspaceOf } from '../src/storage'

test('snapshotOf counts running tasks and splits one-shot from recurring schedules', () => {
  expect(snapshotOf({
    background_tasks: [{ status: 'running' }, { status: 'completed' }, { status: 'killed' }],
    session_crons: [{ recurring: false }, { recurring: true }, { recurring: true }],
  })).toEqual({ tasks: 1, oneShot: 1, recurring: 2 })
  expect(snapshotOf({})).toEqual({ tasks: 0, oneShot: 0, recurring: 0 })
})

test('submitText: intro, handoff, and held messages', () => {
  const plain = submitText('why', 'HANDOFF: x', [])
  expect(plain).toStartWith('[baton] ')
  expect(plain).toContain('wait for the user')
  expect(plain).not.toContain('Messages the user sent')
  const held = submitText('why', 'HANDOFF: x', ['one', 'two'], 'note')
  expect(held).toContain('respond to the user\'s last message')
  expect(held).toContain(' (note)')
  expect(held).toEndWith('Messages the user sent during the handoff:\none\n\ntwo')
})

test('forkFailure explains timeout and nothing-to-fork, passes others through', () => {
  expect(forkFailure('timeout')).toContain('did not answer in time')
  expect(forkFailure('nothing-to-fork')).toContain('just started or cleared')
  expect(forkFailure('api-error')).toBe('api-error')
})

test('workspaceOf: plain folder, worktree with absolute and relative gitdir', () => {
  expect(workspaceOf('C:\\proj\\', '')).toBe('C:/proj')
  expect(workspaceOf('C:/wt/a', 'gitdir: C:/proj/.git/worktrees/a\n')).toBe('C:/proj')
  expect(workspaceOf('C:/proj/wt/a', 'gitdir: ../../.git/worktrees/a')).toBe('C:/proj')
  expect(encodeProject('C:/proj')).toBe('C--proj')
})

test('pruneSeen records new session keys and expires them after 30 days', () => {
  const DAY = 24 * 60 * 60_000
  const seen: Record<string, number> = {}
  const first = pruneSeen(['pendingSubmit:S1', 'snooze:S1', 'handoffs:C--proj', 'seen'], seen, 0)
  expect(first).toEqual({ changed: true, expired: [] })
  expect(seen).toEqual({ 'pendingSubmit:S1': 0, 'snooze:S1': 0 })
  expect(pruneSeen(['pendingSubmit:S1', 'snooze:S1'], seen, 30 * DAY)).toEqual({ changed: false, expired: [] })
  expect(pruneSeen(['pendingSubmit:S1', 'snooze:S1'], seen, 31 * DAY)).toEqual({ changed: true, expired: ['pendingSubmit:S1', 'snooze:S1'] })
  expect(seen).toEqual({})
})
