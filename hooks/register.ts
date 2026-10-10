// Baton hooks module. Derived from ctx-handoff-mod by cablate (MIT, Copyright (c) 2026 cablate):
// fork-based generation, pending submit, /clear + submit, held messages, and resend.
//
// Every function that calls $ lives in this file: Claude Code follows $ only into functions declared
// in the same file, never across an import. Everything else is pure and lives in ../src.
import type { EngineInterface, Register, Timer } from 'claude-code'
import { HANDOFF_TIMEOUT_MS, KEEP_HANDOFFS, resolveConfig } from '../src/config'
import type { Config } from '../src/config'
import { HEADER, NO, YES, consentOf, questionOf, rejectionOf, snoozeMarkOf } from '../src/consent'
import { DEFER_CAP_PERCENT, RETRY_MS, RETRY_TURNS, deferralOf, retryPaused, snapshotOf } from '../src/deferral'
import type { RetryPause, Snapshot, StopWork } from '../src/deferral'
import { HANDOFF_PROMPT, checkHandoff, describeCheck, forkFailure, heldBlock, normalizeHandoff, resendText, retryPrompt, submitText as buildSubmitText } from '../src/handoff'
import { M, failureOf, failureText, shortReason } from '../src/messages'
import { COMMAND, FALLBACK_COMMAND } from '../src/name'
import { percentOf, shouldPrompt } from '../src/monitor'
import { statusText, usageText } from '../src/status'
import { SEEN_KEY, describeUsage, documentId, encodeProject, failureKey, handedOffKey, handoffFolder, handoffsKey, latestForeignPending, pendingKey, pruneSeen, snoozeKey } from '../src/storage'
import type { Failure, HandoffFolder, Kind, Pending, Saved, Snooze, Stage, Usage } from '../src/storage'

// In-process state. A module reload clears it.
const rt = {
  // Mutex: one handoff at a time
  busy: false,
  // A handoff that will /clear is in progress: user messages are held and delivered with it
  presenting: false,
  held: [] as string[],
  presentStartedAt: undefined as number | undefined,
  // A handoff of this process that was not delivered (old session id)
  myPending: undefined as { sid: string } | undefined,
  pendingToasted: false,
  // The latest handoff of this process, used by resend when nothing is pending
  lastHandoff: undefined as { text: string } | undefined,
  // Background work at the latest main-conversation Stop
  snapshot: undefined as Snapshot | undefined,
  // Set while a handoff the threshold calls for is held back by running background work (for /baton status)
  deferring: undefined as { tasks: number; oneShot: number; agents: number } | undefined,
  seenKnown: new Set<string>(),
  // Sessions whose "could not ask" reason was already logged
  askIssueLogged: new Set<string>(),
  // Set by session.end while a handoff runs, when the session ends for a reason other than /clear
  // (exit, terminal closed, another session resumed): the handoff then stops before /clear and submit
  ending: undefined as string | undefined,
  // After a failed handoff, the question pauses (see retryPaused)
  retryPause: undefined as RetryPause | undefined,
}

function resetRuntime() {
  rt.busy = false
  rt.presenting = false
  rt.held = []
  rt.presentStartedAt = undefined
  rt.myPending = undefined
  rt.pendingToasted = false
  rt.lastHandoff = undefined
  rt.snapshot = undefined
  rt.deferring = undefined
  rt.seenKnown.clear()
  rt.askIssueLogged.clear()
  rt.ending = undefined
  rt.retryPause = undefined
}

// Waits at most ms; on timeout resolves to fallback (the promise keeps running, its result is ignored)
async function within<T, F>($: EngineInterface, p: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  let timer: Timer | undefined
  const late = new Promise<F>(resolve => { timer = $.clock.after(ms, () => resolve(fallback)) })
  try {
    return await Promise.race([p, late])
  } finally {
    timer?.cancel()
  }
}

type ForkResult = Awaited<ReturnType<EngineInterface['model']['fork']>>
type ForkOutcome = ForkResult | { isAnswered: false; reason: 'timeout' }
const forkWithin = ($: EngineInterface, prompt: string, ms: number): Promise<ForkOutcome> =>
  within($, $.model.fork({ prompt }), ms, { isAnswered: false as const, reason: 'timeout' as const })

// Project key: the session's root folder, encoded. A git worktree is its own project: no file is read
// Not $.session.repo(): that follows the current directory, which moves with Bash cd
async function projectKey($: EngineInterface) {
  const root = await $.session.root()
  return encodeProject(root)
}

// First time a session-scoped key was seen, for pruning; written once per key
async function touchSeen($: EngineInterface, key: string) {
  if (rt.seenKnown.has(key)) return
  rt.seenKnown.add(key)
  const seen = ((await $.store.get(SEEN_KEY)) as Record<string, number> | undefined) ?? {}
  if (seen[key] === undefined) await $.store.set(SEEN_KEY, { ...seen, [key]: await $.clock.now() })
}

async function prune($: EngineInterface) {
  const now = await $.clock.now()
  const seen = ((await $.store.get(SEEN_KEY)) as Record<string, number> | undefined) ?? {}
  const { changed, expired } = pruneSeen(await $.store.keys(), seen, now)
  for (const k of expired) await $.store.delete(k)
  if (changed) await $.store.set(SEEN_KEY, seen)
}

// Failures are stored so /baton status can show them, named by stage
async function recordFailure($: EngineInterface, kind: Kind, stage: Stage, reason: string, tokens: number | null, sid?: string, detail?: string) {
  const failure: Failure = {
    at: await $.clock.now(),
    sessionId: sid ?? await $.session.id(),
    kind,
    stage,
    reason,
    ...(detail !== undefined && detail !== reason ? { detail } : {}),
    tokens,
    turns: await $.session.turns(),
  }
  await $.store.set(failureKey(await projectKey($)), failure)
  // A failed real attempt pauses the question; a trial run does not
  if (kind !== 'dry') rt.retryPause = { turns: failure.turns, at: failure.at }
}

async function failHandoff($: EngineInterface, kind: Kind, stage: Stage, why: string, tokens: number | null, folder: string) {
  $.ui.log(failureText(stage, why, { folder }))
  $.ui.toast(M.handoff.failedToast)
  await recordFailure($, kind, stage, why, tokens)
  return undefined
}

// Generate → validate → at most one retry naming what was missing. Records a `generate` or `validate` failure
// and returns undefined when there is no complete document
async function makeHandoff($: EngineInterface, kind: Kind, tokens: number | null, folder: string) {
  const started = await $.clock.now()
  let r = await forkWithin($, HANDOFF_PROMPT, HANDOFF_TIMEOUT_MS)
  if (!r.isAnswered) return failHandoff($, kind, 'generate', forkFailure(r.reason), tokens, folder)
  let text = normalizeHandoff(r.text)
  let check = checkHandoff(text)
  const retried = !check.ok
  if (!check.ok) {
    $.ui.log(M.handoff.retryLog(describeCheck(check)))
    r = await forkWithin($, retryPrompt(check), HANDOFF_TIMEOUT_MS)
    if (!r.isAnswered) return failHandoff($, kind, 'generate', forkFailure(r.reason), tokens, folder)
    text = normalizeHandoff(r.text)
    check = checkHandoff(text)
    if (!check.ok) return failHandoff($, kind, 'validate', describeCheck(check), tokens, folder)
  }
  const usage: Usage = {
    input: r.usage.input_tokens,
    cacheRead: r.usage.cache_read_input_tokens,
    cacheCreation: r.usage.cache_creation_input_tokens,
    output: r.usage.output_tokens,
    ms: (await $.clock.now()) - started,
  }
  rt.lastHandoff = { text }
  $.ui.log(M.handoff.savedLog(kind, describeUsage(usage)))
  return { text, usage, retried }
}

// Where documents go: {projectRoot}/{handoffDir}, or ~/.baton/handoff when that would be inside Claude Code's
// own folder (CLAUDE_CONFIG_DIR, else ~/.claude) or the project root is inside a system folder
async function documentFolder($: EngineInterface, config: Config) {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  // System folders on Windows; unset elsewhere
  const systemDirs = [
    await $.env.get('SystemRoot'),
    await $.env.get('WINDIR'),
    await $.env.get('ProgramFiles'),
    await $.env.get('ProgramFiles(x86)'),
  ]
  return handoffFolder(await $.session.root(), config.handoffDir, home, await $.env.get('CLAUDE_CONFIG_DIR'), systemDirs)
}

// Writes the document ($.fs.write creates the folders) and returns how the new session and /baton name it:
// relative to the project, or absolute when the folder was redirected. The only file this plugin writes:
// <handoff folder>/<session-id>.md, with the id checked by documentId and the rest of the path fixed text
// wherever it can be (the redirect folder, the separators, the .md extension)
async function writeDocument($: EngineInterface, sid: string, text: string, folder: HandoffFolder) {
  const id = documentId(sid)
  if (folder.redirected) await $.fs.write(`${folder.home}/.baton/handoff/${id}.md`, `${text}
`)
  else await $.fs.write(`${folder.root}/${folder.sub}/${id}.md`, `${text}
`)
  const file = `${folder.shown}/${id}.md`
  $.ui.log(M.handoff.writtenLog(file))
  return file
}

// Metadata of recent handoffs for /baton status; the document itself is in the file
async function recordSaved($: EngineInterface, kind: Kind, tokens: number | null, usage: Usage, file?: string) {
  const saved: Saved = { at: await $.clock.now(), sessionId: await $.session.id(), kind, tokens, usage, ...(file ? { file } : {}) }
  const key = handoffsKey(await projectKey($))
  const list = ((await $.store.get(key)) as Saved[] | undefined) ?? []
  await $.store.set(key, [...list, saved].slice(-KEEP_HANDOFFS))
}

// $.prompt.submit returns { drop } instead of throwing when another hook drops the prompt: treat it as a failure
async function submitText($: EngineInterface, text: string) {
  const r = await $.prompt.submit({ text })
  if (r.drop !== undefined) throw new Error(M.handoff.dropped(r.drop))
}

// Why the handoff must not /clear now: the session is ending (exit, terminal closed, another session resumed),
// or it is no longer the session the handoff was made from (a /clear or /resume typed meanwhile)
async function sessionMoved($: EngineInterface, sid: string) {
  if (rt.ending !== undefined) return M.handoff.sessionEnding(rt.ending)
  if ((await $.session.id()) !== sid) return M.handoff.sessionChanged
  return undefined
}

// Stores the full text as pending, runs /clear, submits it to the new session, then deletes the pending key.
// Returns how it stopped:
// - `write`: the pending text could not be stored; nothing cleared, nothing pending
// - `clear` with `kept`: the session ended or changed first; Baton cleared nothing, the pending text is kept
//   for /baton resend (from this process, or a later one)
// - `clear`: /clear failed; still in the old session, nothing pending
// - `submit`: the new session is open (or the process is ending); the pending text is kept for /baton resend
async function clearAndSubmit($: EngineInterface, sid: string, text: string, file: string): Promise<{ stage: Stage; reason: string; kept?: boolean } | undefined> {
  const key = pendingKey(sid)
  try {
    const pending: Pending = { text, at: await $.clock.now(), sessionId: sid, project: await projectKey($), file }
    await $.store.set(key, pending)
    await touchSeen($, key)
  } catch (err) {
    return { stage: 'write', reason: String(err) }
  }
  rt.myPending = { sid }
  rt.pendingToasted = false
  const moved = await sessionMoved($, sid)
  if (moved !== undefined) return { stage: 'clear', reason: moved, kept: true }
  try {
    await $.command.run({ command: 'clear' })
  } catch (err) {
    await $.store.delete(key)
    rt.myPending = undefined
    return { stage: 'clear', reason: String(err) }
  }
  if (rt.ending !== undefined) return { stage: 'submit', reason: M.handoff.sessionEnding(rt.ending) }
  // Mark the new session before the handoff turn can end, so its first Stop sets a snooze mark instead of asking
  try {
    const created = handedOffKey(await $.session.id())
    await $.store.set(created, { at: await $.clock.now() })
    await touchSeen($, created)
  } catch {}
  try {
    await submitText($, text)
  } catch (err) {
    return { stage: 'submit', reason: String(err) }
  }
  await $.store.delete(key)
  rt.myPending = undefined
  return undefined
}

// Set synchronously when a handoff that will /clear starts, so later user messages are held
function beginPresent() {
  rt.busy = true
  rt.presenting = true
  rt.held = []
  rt.presentStartedAt = undefined
  rt.ending = undefined
}

// Generate and validate → write the document → store pending → /clear → submit. /clear never runs before the
// document is validated, written, and stored as pending. Runs outside any command.run hook (scheduled with
// $.clock.after), because /clear from inside a command.run hook would wait on the turn that hook holds.
async function present($: EngineInterface, tokens: number | null, kind: Kind, why: string, config: Config, note?: string) {
  rt.presentStartedAt = await $.clock.now()
  const sid = await $.session.id()
  let stage: Stage = 'generate'
  // How many held messages are already accounted for: included in the submitted text, or sent separately
  let delivered = 0
  const drain = async (send: (batch: string) => Promise<void>) => {
    while (rt.held.length > delivered) {
      const batch = rt.held.slice(delivered).join('\n\n')
      delivered = rt.held.length
      await send(batch)
    }
  }
  const resubmit = async (batch: string) => {
    try { await submitText($, batch) } catch (err) { $.ui.log(M.handoff.resubmitFailed(String(err))) }
  }
  let folder = config.handoffDir
  let file: string | undefined
  try {
    const where = await documentFolder($, config)
    folder = where.shown
    const made = await makeHandoff($, kind, tokens, folder)
    if (made === undefined) { await drain(resubmit); return }
    stage = 'write'
    file = await writeDocument($, sid, made.text, where)
    await recordSaved($, kind, tokens, made.usage, file)
    const included = [...rt.held]
    delivered = included.length
    const text = buildSubmitText(why, made.text, included, note, file)
    const failed = await clearAndSubmit($, sid, text, file)
    if (failed === undefined) {
      rt.retryPause = undefined
      // Messages that arrived after the text was built follow the handoff turn
      await drain(resubmit)
      return
    }
    stage = failed.stage
    const reason = failed.kept ? failed.reason : shortReason(failed.reason)
    $.ui.log(failed.kept ? M.handoff.notDelivered(failed.reason, file) : failureText(failed.stage, reason, { folder, file }))
    if (!failed.kept) $.ui.log(failed.reason, { to: 'debug' })
    await recordFailure($, kind, failed.stage, reason, tokens, sid, failed.reason)
    if (failed.stage === 'submit' || failed.kept) {
      $.ui.toast(M.handoff.submitFailedToast)
      // The handoff is pending for /baton resend: messages that arrived after the text was built are appended
      // to it, so they are delivered together
      let pending = text
      await drain(async batch => {
        pending += included.length === 0 && pending === text ? `\n\n${heldBlock([batch])}` : `\n\n${batch}`
        const rec = (await $.store.get(pendingKey(sid))) as Pending | undefined
        if (rec) await $.store.set(pendingKey(sid), { ...rec, text: pending })
      })
    } else {
      // Still in the old session: every held message goes back to it
      delivered = 0
      await drain(resubmit)
    }
  } catch (err) {
    const reason = shortReason(String(err))
    $.ui.log(failureText(stage, reason, { folder, ...(stage === 'write' ? {} : file ? { file } : {}) }))
    $.ui.log(String(err), { to: 'debug' })
    try {
      await recordFailure($, kind, stage, reason, tokens, sid, String(err))
      delivered = 0
      await drain(resubmit)
    } catch (err2) {
      $.ui.log(M.handoff.failedCleanup(String(err2)))
    }
  } finally {
    rt.presenting = false
    rt.held = []
    rt.busy = false
  }
}

// End of a main-conversation turn: record background work, then decide whether to ask. Asks at most once per
// Stop, never mid-turn. The question itself runs after the Stop returns (scheduled), holding the mutex until
// it is answered, so a second Stop or /baton now cannot start another one meanwhile
async function onStop($: EngineInterface, e: StopWork & { agent_id?: string }, config: Config) {
  if (e.agent_id !== undefined) return
  const snapshot = snapshotOf(e)
  rt.snapshot = snapshot
  if (rt.busy) return
  rt.deferring = undefined
  const { context } = await $.session.usage()
  const percent = percentOf(context)
  if (percent === undefined) return
  const sid = await $.session.id()
  // The first measured Stop of a session a Baton handoff created: it may already start above the threshold, so
  // it gets a snooze mark (its first percent plus snoozePoints) instead of a question
  if ((await $.store.get(handedOffKey(sid))) !== undefined) {
    const mark: Snooze = { mark: snoozeMarkOf(percent, config.snoozePoints), at: await $.clock.now(), after: 'handoff' }
    await $.store.set(snoozeKey(sid), mark)
    await touchSeen($, snoozeKey(sid))
    await $.store.delete(handedOffKey(sid))
    return
  }
  if (!shouldPrompt(percent, config.thresholdPercent)) return
  const snooze = (await $.store.get(snoozeKey(sid))) as Snooze | undefined
  if (!shouldPrompt(percent, config.thresholdPercent, snooze?.mark)) return
  // A recent failed handoff: do not ask again until a few more prompts or some minutes passed
  if (retryPaused(rt.retryPause, await $.session.turns(), await $.clock.now())) return
  // Background work would be cut off by /clear: wait silently and look again at the next Stop
  const agents = (await $.agent.list()).filter(a => a.status === 'running').length
  const deferral = deferralOf(snapshot, agents, percent)
  if (deferral === 'defer') {
    rt.deferring = { tasks: snapshot.tasks, oneShot: snapshot.oneShot, agents }
    return
  }
  rt.busy = true
  const tokens = context.tokens ?? null
  const note = deferral === 'proceed-at-cap' ? M.stop.atCap(DEFER_CAP_PERCENT) : undefined
  $.clock.after(0, () => void askAndHandOff($, sid, percent, tokens, config, note))
}

// The question. Only the exact "Yes" label is a yes; "Other" text, Esc, a timeout, or any rejection is a no.
// A rejection other than the user closing the dialog (tool unavailable or denied, ...) is logged once per session
async function askConsent($: EngineInterface, sid: string, percent: number) {
  try {
    return consentOf(await $.ui.ask(questionOf(percent), { options: [YES, NO], header: HEADER })) === 'yes'
  } catch (err) {
    const r = rejectionOf(err)
    if (r.kind !== 'dismissed' && !rt.askIssueLogged.has(sid)) {
      rt.askIssueLogged.add(sid)
      $.ui.log(M.consent.notAsked(r.reason))
    }
    return false
  }
}

async function askAndHandOff($: EngineInterface, sid: string, percent: number, tokens: number | null, config: Config, note?: string) {
  let yes = false
  try {
    yes = await askConsent($, sid, percent)
    if (!yes) {
      // Stored, not kept in memory: a settings change reloads the plugin, and must not re-ask right after a "No"
      const snooze: Snooze = { mark: snoozeMarkOf(percent, config.snoozePoints), at: await $.clock.now(), after: 'no' }
      await $.store.set(snoozeKey(sid), snooze)
      await touchSeen($, snoozeKey(sid))
    }
  } catch (err) {
    yes = false
    $.ui.log(M.consent.failed(String(err)))
  } finally {
    if (!yes) rt.busy = false
  }
  if (!yes) return
  beginPresent()
  await present($, tokens, 'threshold', M.handoff.whyPercent(percent), config, note)
}

async function status($: EngineInterface, settings: { config: Config; problems: readonly string[] }) {
  const { context } = await $.session.usage()
  const pk = await projectKey($)
  const list = ((await $.store.get(handoffsKey(pk))) as Saved[] | undefined) ?? []
  const failure = (await $.store.get(failureKey(pk))) as Failure | undefined
  const snooze = (await $.store.get(snoozeKey(await $.session.id()))) as Snooze | undefined
  const folder = await documentFolder($, settings.config)
  const turns = await $.session.turns()
  const now = await $.clock.now()
  const pause = rt.retryPause && retryPaused(rt.retryPause, turns, now)
    ? { turnsLeft: rt.retryPause.turns + RETRY_TURNS - turns, until: new Date(rt.retryPause.at + RETRY_MS).toLocaleTimeString() }
    : undefined
  const foreign = rt.myPending ? undefined : await foreignPending($)
  return statusText({
    context,
    ...(snooze ? { snooze: { mark: snooze.mark, after: snooze.after ?? 'no' } } : {}),
    config: settings.config,
    problems: settings.problems,
    last: list.at(-1),
    failure,
    undelivered: rt.myPending !== undefined,
    busy: rt.busy,
    snapshot: rt.snapshot,
    ...(rt.deferring ? { deferring: rt.deferring } : {}),
    folder: { shown: folder.shown, root: await $.session.root(), ...(folder.redirected ? { redirected: folder.why } : {}) },
    ...(pause ? { pause } : {}),
    ...(foreign ? { foreignPending: { sessionId: foreign.sessionId, ...(foreign.file ? { file: foreign.file } : {}) } } : {}),
  })
}

async function handoffNow($: EngineInterface, config: Config) {
  if (rt.busy) return { text: M.cmd.busy }
  const { context } = await $.session.usage()
  const tokens = context.tokens ?? null
  beginPresent()
  $.clock.after(0, () => void present($, tokens, 'manual', M.handoff.whyManual, config))
  return { text: M.cmd.nowStarted }
}

// Generates and validates a handoff and shows it; writes no file and does not /clear
async function handoffDry($: EngineInterface, config: Config) {
  if (rt.busy) return { text: M.cmd.busy }
  const { context } = await $.session.usage()
  const tokens = context.tokens ?? null
  rt.busy = true
  try {
    const made = await makeHandoff($, 'dry', tokens, (await documentFolder($, config)).shown)
    if (made === undefined) return { text: M.cmd.dryFailed }
    await recordSaved($, 'dry', tokens, made.usage)
    return { text: `${M.cmd.dryDone(String(context.tokens ?? '?'), made.retried)}\n${describeUsage(made.usage)}\n\n${made.text}` }
  } finally {
    rt.busy = false
  }
}

// Resubmits an undelivered handoff. Only this process's own record, never another session's
// pendingSubmit; no /clear
async function resend($: EngineInterface) {
  let text: string | undefined
  let key: string | undefined
  let reply: string = M.cmd.resending
  // 1. This process's own undelivered handoff
  if (rt.myPending) {
    key = pendingKey(rt.myPending.sid)
    text = ((await $.store.get(key)) as Pending | undefined)?.text
  }
  // 2. This process's latest handoff, sent again
  if (text === undefined && rt.lastHandoff) text = resendText(rt.lastHandoff.text)
  // 3. An undelivered handoff another session of this project left behind (for example one cut off by /exit)
  if (text === undefined) {
    const foreign = await foreignPending($)
    if (foreign) {
      key = pendingKey(foreign.sessionId)
      text = foreign.text
      reply = M.cmd.resendingFrom(foreign.sessionId)
    }
  }
  if (text === undefined) return { text: M.cmd.nothingToResend }
  const body = text
  $.clock.after(0, () => {
    void submitText($, body)
      .then(async () => {
        if (key !== undefined) await $.store.delete(key)
        rt.myPending = undefined
      })
      .catch(err => $.ui.log(M.cmd.resendFailed(String(err))))
  })
  return { text: reply }
}

// The newest undelivered handoff of another session of this project, settled for at least a minute
async function foreignPending($: EngineInterface) {
  const keys = (await $.store.keys()).filter(k => k.startsWith('pendingSubmit:'))
  const entries = await Promise.all(keys.map(k => $.store.get(k)))
  return latestForeignPending(entries, await projectKey($), await $.session.id(), await $.clock.now())
}

// A command's answer shown with $.ui.log, which is not sent to the model, and no transcript text, so it stays out
// of the conversation (verified in 2.1.295: with no text, no command output is recorded). One log line per text
// line: the terminal draws a newline inside one log line as a replacement character
function show($: EngineInterface, text: string) {
  for (const line of text.split('\n')) if (line.trim() !== '') $.ui.log(line)
  return {}
}

// At session start: an undelivered handoff another session of this project left (for example cut off by /exit),
// and a handoff folder redirected out of Claude Code's own folder or a system folder
async function startNotices($: EngineInterface, config: Config) {
  const foreign = await foreignPending($)
  if (foreign) $.ui.log(M.start.foreignPending(foreign.sessionId, foreign.file))
  const folder = await documentFolder($, config)
  if (folder.redirected) $.ui.log(M.start.redirected(folder.why, config.handoffDir, folder.shown, await $.session.root()))
}

// For the failure handlers (.catch) below. A handler is asked when its hook throws, overruns its budget, or
// is not run because the event rose beneath this plugin's own call (re-entry, e.g. the handoff submit raising
// prompt.submit). Its `next` is replay-safe: when the hook had already called it, next(e) returns that result
// without running the hooks beneath again. Its own $ calls may reject, so logging is best-effort and skipped
// on re-entry.
function logFailure($: EngineInterface, kind: string, text: string) {
  if (kind === 're-entry') return
  try { $.ui.log(text) } catch {}
}

// The subcommands of /baton (and of /baton-handoff)
async function runCommand($: EngineInterface, args: string, settings: { config: Config; problems: readonly string[] }) {
  const [sub = ''] = args.trim().split(/\s+/)
  switch (sub) {
    case '': return show($, await status($, settings))
    case 'now': return show($, (await handoffNow($, settings.config)).text)
    // The trial document is returned as the command's output, so it can be read and copied in full
    case 'dry': return handoffDry($, settings.config)
    case 'resend': return show($, (await resend($)).text)
    default: return show($, `${M.cmd.unknown(sub)}
${usageText()}`)
  }
}

// `options` are the plugin's userConfig values, defaults filled in and types checked by the engine. A change
// to them reloads the plugin and runs register again, which also resets the in-process state above
export const register: Register = (on, options) => {
  resetRuntime()
  const settings = resolveConfig(options)

  on('session.start', async ($, e, next) => {
    // /baton may already be taken (a user command or skill): fall back to /baton-handoff
    try {
      await $.command.register({ name: COMMAND, description: M.start.description })
    } catch (err) {
      try {
        await $.command.register({ name: FALLBACK_COMMAND, description: M.start.description })
        $.ui.log(M.start.taken(String(err)))
      } catch (err2) {
        $.ui.log(M.start.registerFailed(String(err2)))
      }
    }
    try {
      await prune($)
    } catch (err) {
      $.ui.log(M.start.pruneFailed(String(err)))
    }
    // Rejected settings are not dropped silently: named once per session here, and in /baton status
    if (settings.problems.length > 0) $.ui.log(M.config.problemsLog(settings.problems))
    try {
      await startNotices($, settings.config)
    } catch {}
    return next(e)
  })

  // A session that ends for any reason but /clear while a handoff runs (/exit, ctrl+c, the terminal closing,
  // another session resumed): the handoff stops before /clear and submit, keeping the document and the pending
  // text. /exit reaches no prompt.submit or command.run hook, so this is the only signal
  on('session.end', async (_$, e, next) => {
    if (rt.presenting && e.reason !== 'clear') rt.ending = e.reason
    return next(e)
  }).catch((_$, e, next) => next(e))

  on('classic.Stop', async ($, e, next) => {
    const out = await next(e)
    // Another Stop hook asked to continue: the turn has not really ended
    if (out.block !== undefined) return out
    await onStop($, e, settings.config)
    return out
  }).catch(($, e, next) => {
    // On failure the Stop does nothing
    logFailure($, next.error.kind, M.stop.failed(failureOf(next.error)))
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const isHuman = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
    if (!isHuman) return next(e)
    const isSlash = e.text.trimStart().startsWith('/')
    // Handoff in progress: hold the message and deliver it with the handoff
    const hasAttachments = (e.attachments?.length ?? 0) > 0
    if (rt.presenting && !isSlash && (e.text.trim() || hasAttachments)) {
      const elapsed = rt.presentStartedAt === undefined ? 0 : Math.round(((await $.clock.now()) - rt.presentStartedAt) / 1000)
      const wait = M.submit.wait(elapsed, Math.round(HANDOFF_TIMEOUT_MS / 60_000))
      // Only text can be held: a mod cannot read attachment contents
      const attachNote = hasAttachments ? M.submit.attach : ''
      if (!e.text.trim()) return { drop: M.submit.busy(wait, attachNote) }
      // Re-sent because it looked stuck: hold the same text once
      if (rt.held.some(h => h.trim() === e.text.trim())) return { drop: M.submit.dup(wait, attachNote) }
      rt.held.push(e.text)
      return { drop: M.submit.held(wait, attachNote) }
    }
    if (rt.myPending && !rt.busy && !rt.pendingToasted) {
      rt.pendingToasted = true
      $.ui.toast(M.submit.pendingToast)
    }
    return next(e)
  }).catch(($, e, next) => {
    // On failure the user's message goes through unchanged
    logFailure($, next.error.kind, M.hook.submitFailed(failureOf(next.error)))
    return next(e)
  })

  // One command with subcommands; with no argument it shows status and usage. It answers under its own name and
  // under the fallback name, each registered with a literal so the validator lists both (it cannot follow a loop
  // variable). Keep the literals equal to COMMAND and FALLBACK_COMMAND (tests/hooks.test.ts checks this)
  // On failure a command answers with a short error. This plugin never runs /baton itself, so re-entry passes through
  on('command.run', { command: 'baton' }, ($, e) => runCommand($, e.args, settings)).catch((_$, e, next) => {
    if (next.error.kind === 're-entry') return next(e)
    return { text: M.hook.commandFailed(failureOf(next.error)) }
  })
  on('command.run', { command: 'baton-handoff' }, ($, e) => runCommand($, e.args, settings)).catch((_$, e, next) => {
    if (next.error.kind === 're-entry') return next(e)
    return { text: M.hook.commandFailed(failureOf(next.error)) }
  })
}
