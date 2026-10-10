// The engine beneath the plugin in tests: usage, store, fork, /clear, submit, all recorded.
// Modelled on ctx-handoff-mod's test world (MIT, Copyright (c) 2026 cablate).
import { mock } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine, MockClock } from 'claude-code/testing'

export const presentation = { isFullscreen: false, columns: 80 }
export const composer = { kind: 'composer' as const }
export const ROOT = 'C:/proj'
export const HOME = 'C:/Users/u'
export const PROJECT = 'C--proj'
export const TITLES = ['Goal', 'Standing instructions', 'Verified', 'Done but not verified', 'Failed approaches',
  'Still running or unfinished', 'Decisions', 'Key files and commands', 'Next step', 'Open questions']
// A complete document: first line and the ten numbered sections
export const HANDOFF = ['HANDOFF: finish the test suite', ...TITLES.map((t, i) => `## ${i + 1}. ${t}\nNone`)].join('\n')

const usage = (tokens: number) => ({
  input_tokens: 100, cache_read_input_tokens: tokens, cache_creation_input_tokens: 0, output_tokens: 500,
})

export type Ctl = {
  sid: string
  // The fork answers nothing-to-fork
  failFork: boolean
  // Awaited by every fork: lets a test hold the fork mid-flight
  forkGate?: () => Promise<void>
  // Runs inside /clear; throwing makes /clear fail
  onClear?: () => void | Promise<void>
  // The next n submits are dropped by a hook
  failSubmits: number
  // Command names already held by the user
  taken: Set<string>
  registered: string[]
  // $.session.usage refuses
  failUsage: boolean
  // The engine's own context.percent; undefined = absent, so the plugin falls back to tokens / window
  percent?: number
  // $.clock.now refuses
  failClock: boolean
  // Overrides the token count given to world(); null = not measured
  tokens?: number | null
  // How the AskUserQuestion dialog answers: a label or typed text, null = dismissed, { deny } = refused
  answer: string | null | { deny: string }
  // Subagents $.agent.list reports
  agents: { id: string; status: string }[]
  // A Stop hook beneath asks the turn to continue
  stopBlock?: string
  // Replies of the next forks, in order; when empty a fork answers HANDOFF
  forkReplies: string[]
  // $.fs.write refuses
  failWrite: boolean
  // Environment variables $.env.get reads
  env: Record<string, string>
  // What $.session.turns and $.session.root answer
  turns: number
  root: string
}

// manualClock: instead of mock.clock, a clock whose now can refuse (ctl.failClock); waits of 0 ms run at once,
// longer ones never. For the one test that needs $.clock.now to fail (the harness allows one clock.now hook)
// tokens: null = not measured yet (session start, right after /clear)
// store: entries the plugin's store holds at the start (e.g. what an earlier load of the plugin wrote)
export function world(on: On, tokensOrNull: number | null = 400_000, window = 1_000_000, opts: { manualClock?: boolean; store?: Record<string, unknown> } = {}) {
  const ctl: Ctl = { sid: 'S1', failFork: false, failSubmits: 0, taken: new Set(), registered: [], failUsage: false, failClock: false, answer: 'No', agents: [], forkReplies: [], failWrite: false, env: { USERPROFILE: HOME }, turns: 3, root: ROOT }
  // The order of the operations that matter for a handoff: fork, write, pending:set, clear, submit, pending:delete
  const ops: string[] = []
  const tokensNow = () => (ctl.tokens === undefined ? tokensOrNull : ctl.tokens) ?? undefined
  const asks: string[] = []
  const forks: string[] = []
  const commands: string[] = []
  const submits: string[] = []
  const logs: string[] = []
  const toasts: string[] = []
  latestLogs = logs
  const submitWaiters: (() => void)[] = []
  let clock: MockClock
  if (opts.manualClock) {
    on('clock.now', () => (ctl.failClock ? { deny: 'clock boom' } : { value: 0 }))
    on('clock.after', (_$, e: { ms: number }) => (e.ms === 0 ? { value: undefined } : new Promise<never>(() => {})))
    clock = { settle: async () => {}, advance: async () => {} } as unknown as MockClock
  } else {
    clock = mock.clock(on)
  }
  on('ui.log', (_$, e: unknown) => { logs.push(JSON.stringify(e)); return { value: undefined } })
  on('ui.toast', (_$, e: unknown) => { toasts.push(JSON.stringify(e)); return { value: undefined } })
  on('ui.status', () => ({ value: undefined }))
  // Values round-trip through JSON, as in the real store
  const kv = new Map<string, unknown>(Object.entries(opts.store ?? {}))
  on('store.get', (_$, e: { key: string }) => ({ value: kv.has(e.key) ? JSON.parse(JSON.stringify(kv.get(e.key))) : undefined }))
  on('store.set', (_$, e: { key: string; value: unknown }) => {
    if (e.key.startsWith('pendingSubmit:') && !kv.has(e.key)) ops.push('pending:set')
    kv.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', (_$, e: { key: string }) => {
    if (e.key.startsWith('pendingSubmit:')) ops.push('pending:delete')
    kv.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...kv.keys()] }))
  on('session.id', () => ({ value: ctl.sid }))
  on('session.turns', () => ({ value: ctl.turns }))
  on('session.root', () => ({ value: ctl.root }))
  on('session.end', (_$, e) => e as never)
  on('session.usage', () => {
    if (ctl.failUsage) return { deny: 'usage boom' }
    return { value: { startedAt: 0, context: { tokens: tokensNow(), window, ...(ctl.percent === undefined ? {} : { percent: ctl.percent }) }, rateLimits: [] } }
  })
  on('env.get', (_$, e: { name: string }) => ({ value: ctl.env[e.name] }))
  // Written files by path, forward slashes
  const files = new Map<string, string>()
  on('fs.write', (_$, e: { path: string; text: string }) => {
    if (ctl.failWrite) return { deny: 'disk full' }
    files.set(e.path.split(String.fromCharCode(92)).join('/'), e.text)
    ops.push('write')
    return { value: undefined }
  })
  on('model.fork', async (_$, e: { prompt: string }) => {
    forks.push(e.prompt)
    ops.push('fork')
    await ctl.forkGate?.()
    if (ctl.failFork) return { value: { isAnswered: false as const, reason: 'nothing-to-fork' as const } }
    return { value: { isAnswered: true as const, text: ctl.forkReplies.shift() ?? HANDOFF, usage: usage(tokensNow() ?? 0) } }
  })
  on('command.register', (_$, e: { name: string }) => {
    ctl.registered.push(e.name)
    return ctl.taken.has(e.name) ? { deny: `"/${e.name}" is the user's /${e.name}` } : { value: { command: e.name } }
  })
  on('command.run', async (_$, e: { command: string }) => {
    commands.push(e.command)
    if (e.command === 'clear') ops.push('clear')
    if (e.command === 'clear') {
      await ctl.onClear?.()
      ctl.sid = `${ctl.sid}-new`
    }
    return { text: '' }
  })
  on('prompt.submit', (_$, e: { text: string }) => {
    if (ctl.failSubmits > 0) { ctl.failSubmits -= 1; return { drop: 'submit boom' } }
    submits.push(e.text)
    ops.push('submit')
    for (const w of submitWaiters.splice(0)) w()
    return { text: e.text }
  })
  on('session.start', (_$, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('classic.Stop', () => (ctl.stopBlock === undefined ? {} : { block: ctl.stopBlock }))
  on('agent.list', () => ({ value: ctl.agents.map(a => ({ ...a, description: '', type: 'general-purpose' })) as never }))
  // $.ui.ask runs as a tool.call of AskUserQuestion
  on('tool.call', (_$, e: { tool: string; questions?: { question: string }[] }) => {
    if (e.tool !== 'AskUserQuestion') return { result: 'ok' }
    const question = e.questions?.[0]?.question ?? ''
    asks.push(question)
    const a = ctl.answer
    if (a !== null && typeof a === 'object') return { deny: a.deny }
    return { result: { answers: a === null ? {} : { [question]: a } } }
  })
  // Resolves at the next submit that reaches the conversation
  const nextSubmit = () => new Promise<void>(resolve => { submitWaiters.push(resolve) })
  return { ctl, clock, ops, asks, forks, commands, submits, logs, toasts, files, nextSubmit, get: (key: string) => kv.get(key), keys: () => [...kv.keys()] }
}

// The logs of the latest world(), for showStatus
let latestLogs: string[] = []

// /baton answers with $.ui.log lines (kept out of the model's context) and no transcript text. Runs a /baton
// subcommand and returns the engine's reply and what the user saw: the reply text, else the logged lines
export async function cmd($: Engine, args: string) {
  const before = latestLogs.length
  const reply = await $.command.run({ command: 'baton', args, origin: composer, presentation })
  const shown = latestLogs.slice(before)
    .map(l => JSON.parse(l) as { text: string; to?: string })
    .filter(l => l.to !== 'debug')
    .map(l => l.text)
    .join('\n')
  return { reply, text: reply.text ?? shown }
}
export const showStatus = ($: Engine) => cmd($, '')
export const say = ($: Engine, text: string) => $.prompt.submit({ text, origin: composer, wait: false })
export const startSession = ($: Engine) => $.session.start({ cwd: ROOT, surface: null, isInteractive: true })
export const stop = ($: Engine, extra: Partial<Parameters<Engine['classic']['Stop']>[0]> = {}) =>
  $.classic.Stop({ stop_hook_active: false, background_tasks: [], session_crons: [], ...extra })

// A gate a test opens by hand
export function gate() {
  let open = () => {}
  const opened = new Promise<void>(resolve => { open = resolve })
  return { wait: () => opened, open }
}
