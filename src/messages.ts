// Every user-facing message. English only. Pure: no $.
// Wording derived from ctx-handoff-mod's English messages (MIT, Copyright (c) 2026 cablate).
import { COMMAND, DISPLAY_NAME, FALLBACK_COMMAND } from './name'
import type { IntKey } from './config'
import type { Stage } from './storage'

const s = (n: number) => (n === 1 ? '' : 's')

// A raw error made short enough to show: an error code (ENOTDIR, EACCES, ...) when there is one, else the last
// part of the message without the engine's "HooksError: <plugin>:" and "$.noun.call(...) failed:" prefixes.
// The raw text goes to the debug log
export function shortReason(raw: string) {
  const code = /\b(E[A-Z]{2,})\b/.exec(raw)?.[1]
  if (code) return code
  const text = raw
    .replace(/^HooksError:\s*[\w-]+:\s*/, '')
    .replace(/^(?:\w*Error:\s*)+/, '')
    .replace(/^\$\.[\w.]+(?:\([^)]*\))?\s*(?:failed)?:?\s*/, '')
    .trim()
  return text.length > 120 ? `${text.slice(0, 117)}...` : text
}

// The sentence shown when a handoff fails: what failed, where, and the state the user is left in
export function failureText(stage: Stage, why: string, where: { folder: string; file?: string }) {
  switch (stage) {
    case 'generate': return `Handoff failed: no handoff was generated (${why}). Nothing was cleared.`
    case 'validate': return `Handoff failed: the document was incomplete twice (${why}). Nothing was cleared.`
    case 'write': return where.file
      ? `Handoff failed: it could not be stored for delivery (${why}). Nothing was cleared; the document is saved at ${where.file}.`
      : `Handoff failed: the document could not be saved in ${where.folder} (${why}). Nothing was cleared.`
    case 'clear': return `Handoff failed: /clear did not run (${why}). You are still in the same session; the document is saved at ${where.file ?? where.folder}.`
    case 'submit': return `Handoff made but not delivered to the new session (${why}). Run /${COMMAND} resend; the document is saved at ${where.file ?? where.folder}.`
  }
}

// Why a hook failed, from the engine's HookFailure
export function failureOf(f: { kind: string; message?: string }) {
  if (f.kind === 'timeout') return f.message ? `timed out (${f.message})` : 'timed out'
  return f.message ?? f.kind
}

export const M = {
  ind: '  ',
  list: ', ',

  fork: {
    timeout: 'timeout: the fork did not answer in time, gave up waiting',
    nothingToFork: 'nothing-to-fork: this session was just started or cleared, so there is nothing to build on yet. Send a message, wait for the reply, then try again',
  },

  handoff: {
    failedLog: (why: string) => `handoff failed: ${why}`,
    failedToast: 'Handoff failed',
    savedLog: (kind: string, usage: string) => `handoff (${kind}) ${usage}`,
    dropped: (reason: string) => `dropped: ${reason}`,
    stageFailed: (stage: Stage, reason: string) => `${stage} failed: ${reason}`,
    resubmitFailed: (r: string) => `could not resend the messages received during handoff: ${r}`,
    submitFailedToast: `Handoff created but not sent. Run /${COMMAND} resend to send it again`,
    failedCleanup: (r: string) => `cleanup after the failed handoff also failed: ${r}`,
    whyManual: `the user ran /${COMMAND} now`,
    whyPercent: (percent: number) => `context reached ${percent}% of the window and the user agreed to hand off`,
    intro: (why: string) =>
      `The previous conversation was cleared automatically because ${why}. Here is the handoff: read it, tell me in a few lines the current state and next step as you understand them, then wait for the user's instructions. Do not start working yet.`,
    introHeld: (why: string) =>
      `The previous conversation was cleared automatically because ${why}. Here is the handoff and the messages the user sent during the handoff: respond to the user's last message below, using the handoff as context.`,
    note: (note: string) => ` (${note})`,
    heldHead: '---\nMessages the user sent during the handoff:',
    savedAt: (file: string) => `The handoff is also saved at ${file}.`,
    retryLog: (problems: string) => `handoff incomplete (${problems}), asking once more`,
    writtenLog: (file: string) => `handoff saved to ${file}`,
    badSessionId: (sid: string) => `the session id ${JSON.stringify(sid.slice(0, 40))} is not a valid document name`,
    sessionEnding: (reason: string) => `the session is ending (${reason})`,
    sessionChanged: 'the session changed while the handoff was being made (a /clear or /resume)',
    notDelivered: (why: string, file: string) =>
      `handoff not delivered: ${why}. Baton did not clear anything. It is saved at ${file}; run /${COMMAND} resend to deliver it`,
  },

  stop: {
    failed: (err: string) => `Stop check failed: ${err}`,
    atCap: (cap: number) => `background work was still running when context reached ${cap}%`,
  },

  consent: {
    notAsked: (reason: string) => `could not ask whether to hand off, treated as No (${reason}). Run /${COMMAND} now to hand off by hand`,
    failed: (err: string) => `handoff question failed, treated as No: ${err}`,
  },

  config: {
    notInteger: (setting: IntKey, given: string, d: number) => `${setting}: ${given} is not a whole number, using ${d}`,
    outOfRange: (setting: IntKey, given: number, min: number, max: number, d: number) => `${setting}: ${given} is outside ${min}–${max}, using ${d}`,
    badDir: (given: string, d: string) => `handoffDir: "${given}" is not a folder inside the project, using ${d}`,
    loadedDir: (given: string, d: string) => `handoffDir: "${given}" is a folder Claude Code loads commands, agents, skills, rules or output styles from, using ${d}`,
    problemsLog: (problems: readonly string[]) => `settings ignored: ${problems.join('; ')}`,
  },

  hook: {
    submitFailed: (err: string) => `message check failed, the message was sent unchanged: ${err}`,
    commandFailed: (err: string) => `/${COMMAND} failed: ${err}`,
  },

  start: {
    description: `${DISPLAY_NAME}: status; now / dry / resend`,
    taken: (err: string) => `/${COMMAND} is already taken (${err}), using /${FALLBACK_COMMAND} instead`,
    registerFailed: (err: string) => `could not register the command: ${err}`,
    pruneFailed: (err: string) => `could not tidy the store at startup: ${err}`,
    foreignPending: (sid: string, file: string | undefined) =>
      `an undelivered handoff from session ${sid} is saved${file ? ` at ${file}` : ''}; run /${COMMAND} resend to deliver it here`,
    redirected: (why: 'claude' | 'system', configured: string, used: string, root: string) => why === 'claude'
      ? `handoff folder ${configured} would be inside Claude Code's own folder; documents go to ${used}`
      : `the project folder ${root} is a system folder; documents go to ${used}`,
  },

  submit: {
    wait: (sec: number, max: number) => `${sec}s so far, usually done within a minute, up to about ${max} minutes`,
    attach: 'Images and other attachments cannot be held. Paste them again after the handoff.',
    busy: (wait: string, attach: string) => `Handoff in progress (${wait}).${attach ? ` ${attach}` : ''}`,
    dup: (wait: string, attach: string) => `Handoff in progress (${wait}). This message is already held and will not be sent twice.${attach ? ` ${attach}` : ''}`,
    held: (wait: string, attach: string) => `Handoff in progress (${wait}). This message is held and will be sent in the new conversation.${attach ? ` ${attach}` : ''}`,
    pendingToast: `A handoff was not delivered. Run /${COMMAND} resend to send it again`,
  },

  cmd: {
    unknown: (sub: string) => `Unknown subcommand "${sub}"`,
    usageHead: 'Usage:',
    usageLines: [
      `  /${COMMAND}           status`,
      `  /${COMMAND} now       create a handoff, /clear, and send it to the new session`,
      `  /${COMMAND} dry       trial handoff, no /clear`,
      `  /${COMMAND} resend    resend a handoff that did not arrive (no /clear)`,
    ],
    context: (percent: number, used: string, window: string, threshold: number, reached: boolean) =>
      `Context: ${percent}% (${used} of ${window} tokens) · threshold ${threshold}% (${reached ? 'reached' : 'not reached'})`,
    contextUnknown: (window: string, threshold: number) =>
      `Context: not measured yet (start of session or right after /clear; window ${window} tokens) · threshold ${threshold}%`,
    settings: (threshold: number, snooze: number, dir: string) =>
      `Settings: threshold ${threshold}%, snooze ${snooze} points, handoff folder ${dir}`,
    redirected: (why: 'claude' | 'system', configured: string, used: string, root: string) => why === 'claude'
      ? `Handoff folder ${configured} would be inside Claude Code's own folder, so documents go to ${used}`
      : `The project folder ${root} is a system folder, so documents go to ${used}`,
    documents: (folder: string) =>
      `Handoff documents are saved in ${folder}. Baton never deletes them; remove old ones when you no longer need them`,
    paused: (turnsLeft: number, until: string) =>
      `Paused after a failed handoff: will ask again after ${turnsLeft} more message${s(turnsLeft)} or at ${until}, whichever comes first`,
    foreignPending: (sid: string, file: string | undefined) =>
      `Undelivered handoff from session ${sid}${file ? ` (saved at ${file})` : ''}: /${COMMAND} resend delivers it here`,
    resendingFrom: (sid: string) => `Resending the undelivered handoff of session ${sid} (no /clear)`,
    settingIgnored: (problem: string) => `Setting ignored: ${problem}`,
    snoozed: (mark: number, after: 'no' | 'handoff') =>
      `Snoozed after ${after === 'handoff' ? 'the handoff that started this session' : 'a No'}: will ask again at ${mark}%`,
    latest: (last: { at: string; kind: string; used: string; file?: string } | undefined) =>
      `Latest handoff: ${last ? `${last.at} ${last.kind}, context ${last.used}${last.file ? `, saved to ${last.file}` : ''}` : 'none'}`,
    latestFailure: (at: string, kind: string, stage: Stage, reason: string) => `Latest failure: ${at} ${kind}, stage ${stage}: ${reason}`,
    undelivered: `Undelivered handoff: yes (/${COMMAND} resend to send it again)`,
    inProgress: 'A handoff is in progress',
    deferring: (tasks: number, oneShot: number, agents: number, cap: number) =>
      `Waiting for background work to finish before asking: ${tasks} task${s(tasks)}, ${oneShot} one-off schedule${s(oneShot)}, ${agents} subagent${s(agents)} (asks anyway at ${cap}%)`,
    background: (tasks: number, oneShot: number, recurring: number) =>
      `Background (last Stop): ${tasks} task${s(tasks)}, ${oneShot} one-off schedule${s(oneShot)}, ${recurring} recurring schedule${s(recurring)}`,
    busy: 'Another handoff is in progress',
    nowStarted: 'Creating the handoff, then /clear and send it',
    dryFailed: 'Trial run failed, see the log above for the reason',
    dryDone: (used: string, retried: boolean) =>
      `Trial run done (no /clear, nothing saved), context ${used}${retried ? '; the first attempt was incomplete and was retried once' : ''}`,
    resendIntro: 'Resending the previous handoff. Read it, tell me in a few lines the current state and next step as you understand them, then wait for the user\'s instructions. Do not start working yet.',
    nothingToResend: 'No handoff to resend in this session',
    resendFailed: (err: string) => `resend failed: ${err}`,
    resending: 'Resending the handoff (no /clear)',
  },
}
