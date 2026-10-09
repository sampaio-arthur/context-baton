// Switch hardening: ordering, a failure at each stage, the session ending or changing mid-handoff, resend across
// processes, the retry pause, the handoff folder outside Claude Code's own folder, and status kept out of context
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { RETRY_MS, retryPaused } from '../src/deferral'
import { handoffFolder, latestForeignPending } from '../src/storage'
import { HANDOFF, HOME, PROJECT, cmd, gate, say, showStatus, startSession, stop, world } from './world'

const ORDER = ['fork', 'write', 'pending:set', 'clear', 'submit', 'pending:delete']
const count = (ops: readonly string[], op: string) => ops.filter(o => o === op).length
const endSession = ($: Engine, reason: string, sessionId = 'S1') =>
  $.session.end({ reason, sessionId, resume: sessionId } as never)

// ---------- pure ----------

test('handoffFolder: the project folder normally, ~/.baton/handoff when it would be inside Claude Code\'s folder', () => {
  expect(handoffFolder('C:/proj', '.claude/handoff', 'C:/Users/u', undefined))
    .toEqual({ dir: 'C:/proj/.claude/handoff', shown: '.claude/handoff', redirected: false })
  expect(handoffFolder('C:/Users/u', '.claude/handoff', 'C:/Users/u', undefined))
    .toEqual({ dir: 'C:/Users/u/.baton/handoff', shown: 'C:/Users/u/.baton/handoff', redirected: true, why: 'claude' })
  // Windows paths compare without case; backslashes are normalised
  expect(handoffFolder('c:\\users\\U\\', '.claude/handoff', 'C:\\Users\\u', undefined).redirected).toBe(true)
  // POSIX paths compare with case
  expect(handoffFolder('/home/u', '.claude/handoff', '/home/u', undefined).redirected).toBe(true)
  expect(handoffFolder('/home/U', '.claude/handoff', '/home/u', undefined).redirected).toBe(false)
  // CLAUDE_CONFIG_DIR replaces ~/.claude
  expect(handoffFolder('C:/proj', 'cfg/handoff', 'C:/Users/u', 'C:/proj/cfg').redirected).toBe(true)
  expect(handoffFolder('C:/Users/u', '.claude/handoff', 'C:/Users/u', 'D:/claude-config').redirected).toBe(false)
  // A sibling with the same prefix is not inside
  expect(handoffFolder('C:/Users/u', '.claude-notes/handoff', 'C:/Users/u', undefined).redirected).toBe(false)
  // No home known: no redirect
  expect(handoffFolder('C:/Users/u', '.claude/handoff', undefined, undefined).redirected).toBe(false)
})

test('latestForeignPending: newest settled pending of this project from another session', () => {
  const p = (sessionId: string, at: number, project = PROJECT) => ({ text: `t-${sessionId}`, at, sessionId, project })
  const entries = [p('S0', 0), p('S9', 30_000), p('X', 50_000, 'other'), 'legacy string', undefined, p('S1', 0)]
  expect(latestForeignPending(entries, PROJECT, 'S1', 100_000)?.sessionId).toBe('S9')
  // Younger than a minute: may still be in flight in a live process
  expect(latestForeignPending(entries, PROJECT, 'S1', 80_000)?.sessionId).toBe('S0')
  expect(latestForeignPending(entries, PROJECT, 'S1', 59_999)).toBeUndefined()
})

test('retryPaused: until 3 more prompts or 10 minutes, whichever comes first', () => {
  const pause = { turns: 4, at: 0 }
  expect(retryPaused(undefined, 4, 0)).toBe(false)
  expect(retryPaused(pause, 4, 0)).toBe(true)
  expect(retryPaused(pause, 6, RETRY_MS - 1)).toBe(true)
  expect(retryPaused(pause, 7, 0)).toBe(false)
  expect(retryPaused(pause, 4, RETRY_MS)).toBe(false)
})

// ---------- ordering and stage failures ----------

test('ordering: fork → write → pending → clear → submit → delete pending', async ($, on) => {
  const w = world(on)
  await cmd($, 'now')
  await w.clock.settle()
  expect(w.ops).toEqual(ORDER)
})

test('ordering with the retry: two forks, then the same sequence once', async ($, on) => {
  const w = world(on)
  w.ctl.forkReplies = ['incomplete']
  await cmd($, 'now')
  await w.clock.settle()
  expect(w.ops).toEqual(['fork', ...ORDER])
})

test('a failure at each stage stops there; never two clears or two submits', async ($, on) => {
  const w = world(on)
  // generate
  w.ctl.failFork = true
  await cmd($, 'now')
  await w.clock.settle()
  expect(w.ops).toEqual(['fork'])
  w.ctl.failFork = false
  // validate
  w.ops.length = 0
  w.ctl.forkReplies = ['x', 'y']
  await cmd($, 'now')
  await w.clock.settle()
  expect(w.ops).toEqual(['fork', 'fork'])
  // write
  w.ops.length = 0
  w.ctl.failWrite = true
  await cmd($, 'now')
  await w.clock.settle()
  expect(w.ops).toEqual(['fork'])
  w.ctl.failWrite = false
  // clear: the pending text is removed again, still in the old session
  w.ops.length = 0
  w.ctl.onClear = () => { throw new Error('clear boom') }
  await cmd($, 'now')
  await w.clock.settle()
  expect(w.ops).toEqual(['fork', 'write', 'pending:set', 'clear', 'pending:delete'])
  w.ctl.onClear = undefined
  // submit: the pending text stays for /baton resend
  w.ops.length = 0
  w.ctl.failSubmits = 1
  await cmd($, 'now')
  await w.clock.settle()
  expect(w.ops).toEqual(['fork', 'write', 'pending:set', 'clear'])
  expect(count(w.ops, 'clear')).toBe(1)
  expect(w.submits).toEqual([])
  expect((w.get(`failure:${PROJECT}`) as { stage: string }).stage).toBe('submit')
})

// ---------- the session ends or changes mid-handoff ----------

test('/exit while the handoff is generated: no clear, no submit; document and pending kept; held message kept with it', async ($, on) => {
  const w = world(on)
  const g = gate()
  w.ctl.forkGate = g.wait
  await cmd($, 'now')
  await w.clock.advance(0)
  await say($, 'one more thing')
  await endSession($, 'prompt_input_exit')
  g.open()
  await w.clock.settle()
  expect(w.ops).toEqual(['fork', 'write', 'pending:set'])
  expect(w.commands).toEqual([])
  expect(w.submits).toEqual([])
  expect(w.files.get('C:/proj/.claude/handoff/S1.md')).toBe(`${HANDOFF}\n`)
  const pending = w.get('pendingSubmit:S1') as { text: string; file: string }
  expect(pending.file).toBe('.claude/handoff/S1.md')
  expect(pending.text).toContain(HANDOFF)
  expect(pending.text).toContain('Messages the user sent during the handoff:\none more thing')
  expect(w.logs.join()).toContain('handoff not delivered: the session is ending (prompt_input_exit). Baton did not clear anything')
  expect((w.get(`failure:${PROJECT}`) as { stage: string }).stage).toBe('clear')
})

test('the session ending during /clear: no submit into the dying process, pending kept', async ($, on) => {
  const w = world(on)
  w.ctl.onClear = async () => { await endSession($, 'other') }
  await cmd($, 'now')
  await w.clock.settle()
  expect(w.ops).toEqual(['fork', 'write', 'pending:set', 'clear'])
  expect(w.submits).toEqual([])
  expect(w.get('pendingSubmit:S1')).toBeDefined()
  expect((w.get(`failure:${PROJECT}`) as { stage: string; reason: string })).toMatchObject({ stage: 'submit', reason: 'the session is ending (other)' })
})

test('our own /clear (reason clear) does not count as the session ending', async ($, on) => {
  const w = world(on)
  w.ctl.onClear = async () => { await endSession($, 'clear') }
  await cmd($, 'now')
  await w.clock.settle()
  expect(w.ops).toEqual(ORDER)
})

test('a /clear typed during the handoff: Baton does not clear the new session; /baton resend delivers there', async ($, on) => {
  const w = world(on)
  const g = gate()
  w.ctl.forkGate = g.wait
  await cmd($, 'now')
  await w.clock.advance(0)
  // The user's /clear went through: the process is under another session id now
  w.ctl.sid = 'S2'
  await say($, 'context for the next step')
  g.open()
  await w.clock.settle()
  expect(w.commands).toEqual([])
  expect(w.submits).toEqual([])
  expect(w.logs.join()).toContain('the session changed while the handoff was being made')
  expect((await showStatus($)).text).toContain('Undelivered handoff: yes')
  expect((await cmd($, 'resend')).text).toContain('Resending')
  await w.clock.settle()
  expect(w.submits.length).toBe(1)
  expect(w.submits[0]).toContain(HANDOFF)
  expect(w.submits[0]).toContain('context for the next step')
  expect(w.get('pendingSubmit:S1')).toBeUndefined()
})

test('another slash command during the handoff passes through, and the handoff completes', async ($, on) => {
  const w = world(on)
  const g = gate()
  w.ctl.forkGate = g.wait
  await cmd($, 'now')
  await w.clock.advance(0)
  const r = await say($, '/model haiku')
  expect(JSON.stringify(r)).not.toContain('drop')
  g.open()
  await w.clock.settle()
  expect(w.submits[0]).toBe('/model haiku')
  // The slash command's own submit comes first; then the handoff in order
  expect(w.ops).toEqual(['fork', 'submit', ...ORDER.slice(1)])
})

test('a later process finds the undelivered handoff, says so at start and in /baton, and resends it', async ($, on) => {
  const old = { text: '[baton] old handoff', at: 0, sessionId: 'S0', project: PROJECT, file: '.claude/handoff/S0.md' }
  const w = world(on, 400_000, 1_000_000, { store: { 'pendingSubmit:S0': old, 'pendingSubmit:Z': { ...old, sessionId: 'Z', project: 'other' } } })
  await w.clock.advance(61_000)
  await startSession($)
  expect(w.logs.join()).toContain('an undelivered handoff from session S0 is saved at .claude/handoff/S0.md; run /baton resend to deliver it here')
  expect((await showStatus($)).text).toContain('Undelivered handoff from session S0 (saved at .claude/handoff/S0.md): /baton resend delivers it here')
  expect((await cmd($, 'resend')).text).toBe('Resending the undelivered handoff of session S0 (no /clear)')
  await w.clock.settle()
  expect(w.submits).toEqual(['[baton] old handoff'])
  expect(w.get('pendingSubmit:S0')).toBeUndefined()
  // The other project's entry is untouched
  expect(w.get('pendingSubmit:Z')).toBeDefined()
})

// ---------- retry pause ----------

test('after a failed handoff the question pauses for 3 prompts', async ($, on) => {
  const w = world(on)
  w.ctl.answer = 'Yes'
  w.ctl.failFork = true
  await stop($)
  await w.clock.settle()
  expect(w.asks.length).toBe(1)
  await stop($)
  await w.clock.settle()
  expect(w.asks.length).toBe(1)
  expect((await showStatus($)).text).toContain('Paused after a failed handoff: will ask again after 3 more messages')
  w.ctl.turns = 5
  await stop($)
  await w.clock.settle()
  expect(w.asks.length).toBe(1)
  w.ctl.turns = 6
  w.ctl.failFork = false
  await stop($)
  await w.clock.settle()
  expect(w.asks.length).toBe(2)
  expect(w.commands).toEqual(['clear'])
})

test('after a failed handoff the question pauses for 10 minutes; /baton now still works', async ($, on) => {
  const w = world(on)
  w.ctl.answer = 'Yes'
  w.ctl.failFork = true
  await stop($)
  await w.clock.settle()
  await w.clock.advance(RETRY_MS - 1)
  await stop($)
  await w.clock.settle()
  expect(w.asks.length).toBe(1)
  w.ctl.failFork = false
  expect((await cmd($, 'now')).text).toContain('Creating the handoff')
  await w.clock.settle()
  expect(w.commands).toEqual(['clear'])
})

test('a No or a trial run does not pause the question', async ($, on) => {
  const w = world(on)
  w.ctl.forkReplies = ['x', 'y']
  await cmd($, 'dry')
  await stop($)
  await w.clock.settle()
  expect(w.asks.length).toBe(1)
})

// ---------- handoff folder ----------

test('project root is the home folder: the document goes to ~/.baton/handoff, and Baton says so', async ($, on) => {
  const w = world(on)
  w.ctl.root = HOME
  await startSession($)
  expect(w.logs.join()).toContain('handoff folder .claude/handoff would be inside Claude Code\'s own folder; documents go to C:/Users/u/.baton/handoff')
  await cmd($, 'now')
  await w.clock.settle()
  expect([...w.files.keys()]).toEqual(['C:/Users/u/.baton/handoff/S1.md'])
  expect(w.submits[0]).toContain('The handoff is also saved at C:/Users/u/.baton/handoff/S1.md.')
  const text = (await showStatus($)).text
  expect(text).toContain('Handoff folder .claude/handoff would be inside Claude Code\'s own folder, so documents go to C:/Users/u/.baton/handoff')
  expect(text).toContain('Handoff documents: 1 in C:/Users/u/.baton/handoff')
})

// ---------- /baton status ----------

test('/baton status is logged, not returned as transcript text, and counts the documents', async ($, on) => {
  const w = world(on)
  await cmd($, 'now')
  await w.clock.settle()
  const { reply, text } = await showStatus($)
  expect(reply.text).toBeUndefined()
  expect(text).toContain('Handoff documents: 1 in .claude/handoff (old ones are not deleted automatically')
  expect(text).not.toContain('keep')
})

test('/baton status before any document: no count line', async ($, on) => {
  world(on)
  expect((await showStatus($)).text).not.toContain('Handoff documents')
})

// ---------- system folder as project root ----------

// Windows paths with backslashes, as the environment gives them
const win = (...parts: string[]) => parts.join(String.fromCharCode(92))
const WINDOWS = win('C:', 'WINDOWS')
const SYSTEM32 = win('C:', 'WINDOWS', 'system32')
const SYSTEM = [WINDOWS, WINDOWS, win('C:', 'Program Files'), win('C:', 'Program Files (x86)')]

test('handoffFolder: a project root inside the Windows folder or Program Files is redirected', () => {
  expect(handoffFolder(SYSTEM32, '.claude/handoff', 'C:/Users/u', undefined, SYSTEM))
    .toEqual({ dir: 'C:/Users/u/.baton/handoff', shown: 'C:/Users/u/.baton/handoff', redirected: true, why: 'system' })
  // Case does not matter on Windows
  expect(handoffFolder('c:/windows/System32', '.claude/handoff', 'C:/Users/u', undefined, SYSTEM).redirected).toBe(true)
  expect(handoffFolder('C:/Program Files/Tool', 'notes', 'C:/Users/u', undefined, SYSTEM).redirected).toBe(true)
  expect(handoffFolder('C:/Program Files (x86)', 'notes', 'C:/Users/u', undefined, SYSTEM).redirected).toBe(true)
  // A sibling with the same prefix is not a system folder
  expect(handoffFolder('C:/WINDOWS-tools/proj', '.claude/handoff', 'C:/Users/u', undefined, SYSTEM).redirected).toBe(false)
  expect(handoffFolder('C:/Program Files Extra/proj', 'notes', 'C:/Users/u', undefined, SYSTEM).redirected).toBe(false)
  // Unset variables (other systems) change nothing
  expect(handoffFolder('/usr/src/proj', '.claude/handoff', '/home/u', undefined, [undefined, undefined, '']).redirected).toBe(false)
  // The Claude Code folder reason wins when both apply
  expect(handoffFolder('C:/Users/u', '.claude/handoff', 'C:/Users/u', undefined, SYSTEM)).toMatchObject({ why: 'claude' })
})

test('project root in the Windows system32 folder: the document goes to ~/.baton/handoff, and Baton says why', async ($, on) => {
  const w = world(on)
  w.ctl.root = SYSTEM32
  w.ctl.env = { USERPROFILE: HOME, SystemRoot: WINDOWS, ProgramFiles: win('C:', 'Program Files') }
  await startSession($)
  const notices = w.logs.map(l => (JSON.parse(l) as { text: string }).text)
  expect(notices).toContain(`the project folder ${SYSTEM32} is a system folder; documents go to C:/Users/u/.baton/handoff`)
  await cmd($, 'now')
  await w.clock.settle()
  expect([...w.files.keys()]).toEqual(['C:/Users/u/.baton/handoff/S1.md'])
  expect(w.submits[0]).toContain('The handoff is also saved at C:/Users/u/.baton/handoff/S1.md.')
  expect((await showStatus($)).text).toContain(`The project folder ${SYSTEM32} is a system folder, so documents go to C:/Users/u/.baton/handoff`)
})
