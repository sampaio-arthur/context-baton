// The /baton status text. Pure: register.ts reads the data and passes it in.
// Derived from ctx-handoff-mod (MIT, Copyright (c) 2026 cablate).
import type { Config } from './config'
import { DEFER_CAP_PERCENT } from './deferral'
import type { Snapshot } from './deferral'
import { M } from './messages'
import { percentOf, shouldPrompt } from './monitor'
import type { ContextUsage } from './monitor'
import { describeUsage } from './storage'
import type { Failure, Saved } from './storage'

export const usageText = () => [M.cmd.usageHead, ...M.cmd.usageLines].join('\n')

export type StatusInput = {
  context: ContextUsage
  // Snooze mark of this session, when the user answered No
  snooze?: { mark: number; after: 'no' | 'handoff' }
  config: Config
  problems: readonly string[]
  last: Saved | undefined
  failure: Failure | undefined
  undelivered: boolean
  busy: boolean
  snapshot: Snapshot | undefined
  // A handoff the threshold calls for, held back by running background work
  deferring?: { tasks: number; oneShot: number; agents: number }
  // Where documents go, and how many .md files that folder holds (undefined when it cannot be listed)
  folder: { shown: string; redirected?: 'claude' | 'system'; root: string }
  documents: number | undefined
  // The question is paused after a failed handoff
  pause?: { turnsLeft: number; until: string }
  // An undelivered handoff of another session of this project
  foreignPending?: { sessionId: string; file?: string }
}

const n = (v: number) => v.toLocaleString('en-US')

// The context line: the percentage, with the token counts beside it (the system prompt and tools already
// take part of the window, so a low threshold can be reached early)
export function contextLine(context: ContextUsage, thresholdPercent: number) {
  const percent = percentOf(context)
  if (percent === undefined) return M.cmd.contextUnknown(n(context.window), thresholdPercent)
  const tokens = context.tokens === undefined ? '?' : n(context.tokens)
  return M.cmd.context(percent, tokens, n(context.window), thresholdPercent, shouldPrompt(percent, thresholdPercent))
}

export function statusText(s: StatusInput) {
  const { last, failure, config } = s
  return [
    contextLine(s.context, config.thresholdPercent),
    ...(s.snooze ? [M.cmd.snoozed(s.snooze.mark, s.snooze.after)] : []),
    ...(s.pause ? [M.cmd.paused(s.pause.turnsLeft, s.pause.until)] : []),
    M.cmd.settings(config.thresholdPercent, config.snoozePoints, config.handoffDir),
    ...s.problems.map(p => `${M.ind}${M.cmd.settingIgnored(p)}`),
    ...(s.folder.redirected ? [`${M.ind}${M.cmd.redirected(s.folder.redirected, config.handoffDir, s.folder.shown, s.folder.root)}`] : []),
    ...(s.documents !== undefined ? [M.cmd.documents(s.documents, s.folder.shown)] : []),
    M.cmd.latest(last ? { at: new Date(last.at).toLocaleString(), kind: last.kind, tokens: String(last.tokens ?? '?'), file: last.file } : undefined),
    ...(last?.usage ? [`${M.ind}${describeUsage(last.usage)}`] : []),
    // A failure older than the latest handoff is no longer news
    ...(failure && (!last || failure.at >= last.at)
      ? [`${M.ind}${M.cmd.latestFailure(new Date(failure.at).toLocaleString(), failure.kind, failure.stage, failure.reason)}`]
      : []),
    ...(s.undelivered ? [M.cmd.undelivered] : []),
    ...(!s.undelivered && s.foreignPending ? [M.cmd.foreignPending(s.foreignPending.sessionId, s.foreignPending.file)] : []),
    ...(s.busy ? [M.cmd.inProgress] : []),
    ...(s.deferring ? [M.cmd.deferring(s.deferring.tasks, s.deferring.oneShot, s.deferring.agents, DEFER_CAP_PERCENT)] : []),
    ...(s.snapshot ? [M.cmd.background(s.snapshot.tasks, s.snapshot.oneShot, s.snapshot.recurring)] : []),
    '',
    usageText(),
  ].join('\n')
}
