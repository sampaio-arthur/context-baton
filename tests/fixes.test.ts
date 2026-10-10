// Fixes after the manual checks: status and replies as separate log lines kept out of the transcript,
// no self-reference in the document, readable failure sentences, and no question right after a handoff
import { expect, test } from 'claude-code/testing'
import { HANDOFF_PROMPT } from '../src/handoff'
import { failureText, shortReason } from '../src/messages'
import { PROJECT, cmd, showStatus, stop, world } from './world'

// ---------- 1. status renders one line per log entry ----------

test('/baton status: one log line per text line, none containing a newline, no transcript text', async ($, on) => {
  const w = world(on)
  const before = w.logs.length
  const { reply, text } = await showStatus($)
  expect(reply.text).toBeUndefined()
  const lines = w.logs.slice(before).map(l => (JSON.parse(l) as { text: string }).text)
  expect(lines.length).toBeGreaterThan(5)
  for (const line of lines) {
    expect(line).not.toContain('\n')
    expect(line.trim()).not.toBe('')
  }
  expect(text).toContain('Usage:')
})

// ---------- 2. other replies stay out of the transcript too ----------

test('/baton now and /baton resend answer with log lines, not transcript text', async ($, on) => {
  const w = world(on)
  const now = await cmd($, 'now')
  expect(now.reply.text).toBeUndefined()
  expect(now.text).toBe('Creating the handoff, then /clear and send it')
  await w.clock.settle()
  const resend = await cmd($, 'resend')
  expect(resend.reply.text).toBeUndefined()
  expect(resend.text).toContain('Resending')
  const unknown = await cmd($, 'xyz')
  expect(unknown.reply.text).toBeUndefined()
  expect(unknown.text).toContain('Unknown subcommand "xyz"')
})

test('/baton dry still returns the document as the command output', async ($, on) => {
  world(on)
  const r = await cmd($, 'dry')
  expect(r.reply.text).toContain('HANDOFF: finish the test suite')
})

// ---------- 3. the document never names its own file or session ----------

test('prompt: the document must not name its own file, folder, or session id', () => {
  expect(HANDOFF_PROMPT).toContain('Do not name this document\'s own file, folder, or session id, and do not guess them')
})

// ---------- 4. readable failure sentences ----------

test('shortReason: an error code when there is one, else the message without engine prefixes', () => {
  expect(shortReason('HooksError: context-baton: $.fs.write(C:\\x\\blocked\\handoff\\S1.md) failed: ENOTDIR: not a directory, mkdir \'C:\\x\\blocked\'')).toBe('ENOTDIR')
  expect(shortReason('Error: dropped: submit boom')).toBe('dropped: submit boom')
  expect(shortReason('HooksError: context-baton: $.command.run failed: busy')).toBe('busy')
  expect(shortReason('x'.repeat(200)).length).toBe(120)
})

test('failureText: stage, where, and the state the user is left in', () => {
  expect(failureText('write', 'ENOTDIR', { folder: 'blocked/handoff' }))
    .toBe('Handoff failed: the document could not be saved in blocked/handoff (ENOTDIR). Nothing was cleared.')
  expect(failureText('submit', 'dropped', { folder: '.claude/handoff', file: '.claude/handoff/S1.md' }))
    .toBe('Handoff made but not delivered to the new session (dropped). Run /baton resend; the document is saved at .claude/handoff/S1.md.')
  expect(failureText('clear', 'busy', { folder: 'f', file: 'f/S1.md' })).toContain('You are still in the same session')
  expect(failureText('generate', 'timeout', { folder: 'f' })).toContain('no handoff was generated (timeout)')
  expect(failureText('validate', 'missing ## 2. Standing instructions', { folder: 'f' })).toContain('incomplete twice')
})

test('a write failure shows a readable sentence; the raw error goes to the debug log and the record', async ($, on) => {
  const w = world(on)
  w.ctl.failWrite = true
  await cmd($, 'now')
  await w.clock.settle()
  const shown = w.logs.map(l => JSON.parse(l) as { text: string; to?: string })
  const visible = shown.filter(l => l.to !== 'debug').map(l => l.text)
  const debug = shown.filter(l => l.to === 'debug').map(l => l.text)
  expect(visible).toContain('Handoff failed: the document could not be saved in .claude/handoff (disk full). Nothing was cleared.')
  expect(visible.join()).not.toContain('HooksError')
  expect(debug.join()).toContain('disk full')
  const f = w.get(`failure:${PROJECT}`) as { stage: string; reason: string; detail?: string }
  expect(f.stage).toBe('write')
  expect(f.reason).toBe('disk full')
  expect(f.detail).toContain('disk full')
  expect((await showStatus($)).text).toContain('stage write: disk full')
})

// ---------- 5. no question at the first Stop of a session a handoff created ----------

test('the session a handoff created is not asked at its first Stop; it gets a snooze mark instead', async ($, on) => {
  const w = world(on, 412_000)
  w.ctl.answer = 'Yes'
  await stop($)
  await w.clock.settle()
  expect(w.commands).toEqual(['clear'])
  expect(w.get('handedOff:S1-new')).toBeDefined()
  // The handoff turn ends in the new session, already above the threshold
  w.ctl.tokens = 450_000
  await stop($)
  await w.clock.settle()
  expect(w.asks.length).toBe(1)
  expect(w.get('snooze:S1-new')).toEqual({ mark: 55, at: 0, after: 'handoff' })
  expect(w.get('handedOff:S1-new')).toBeUndefined()
  expect((await showStatus($)).text).toContain('Snoozed after the handoff that started this session: will ask again at 55%')
  // It asks again once usage grew by snoozePoints
  w.ctl.answer = 'No'
  w.ctl.tokens = 550_000
  await stop($)
  await w.clock.settle()
  expect(w.asks.length).toBe(2)
})

test('the mark is set also when the new session starts below the threshold, and is then harmless', async ($, on) => {
  const w = world(on)
  await cmd($, 'now')
  await w.clock.settle()
  w.ctl.tokens = 50_000
  await stop($)
  await w.clock.settle()
  expect(w.get('snooze:S1-new')).toEqual({ mark: 15, at: 0, after: 'handoff' })
  w.ctl.tokens = 400_000
  await stop($)
  await w.clock.settle()
  expect(w.asks.length).toBe(1)
})

test('a handoff that was not delivered leaves no mark on the old session', async ($, on) => {
  const w = world(on)
  w.ctl.onClear = () => { throw new Error('clear boom') }
  await cmd($, 'now')
  await w.clock.settle()
  expect(w.keys().filter(k => k.startsWith('handedOff:'))).toEqual([])
})
