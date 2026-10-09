// Background work seen at the end of a turn, and whether to wait for it. Pure: the Stop event is passed in.
// Derived from ctx-handoff-mod (MIT, Copyright (c) 2026 cablate).

// Background task states that no longer wake the session
export const STOPPED = new Set(['completed', 'failed', 'killed', 'stopped', 'cancelled', 'canceled', 'error'])
// Past this usage the handoff stops waiting for background work
export const DEFER_CAP_PERCENT = 90

export type StopWork = {
  background_tasks?: readonly { status: string }[]
  session_crons?: readonly { recurring: boolean }[]
}
export type Snapshot = { tasks: number; oneShot: number; recurring: number }

// Running background tasks and one-shot schedules will wake the session again; recurring ones are counted apart
export function snapshotOf(e: StopWork): Snapshot {
  const tasks = (e.background_tasks ?? []).filter(t => !STOPPED.has(t.status)).length
  const crons = e.session_crons ?? []
  const oneShot = crons.filter(c => !c.recurring).length
  return { tasks, oneShot, recurring: crons.length - oneShot }
}

// After a failed handoff the question pauses until the user sent this many more prompts or this much time
// passed, whichever comes first, so a failure does not make every Stop ask again
export const RETRY_TURNS = 3
export const RETRY_MS = 10 * 60_000
export type RetryPause = { turns: number; at: number }

export function retryPaused(pause: RetryPause | undefined, turns: number, now: number): boolean {
  if (pause === undefined) return false
  return turns - pause.turns < RETRY_TURNS && now - pause.at < RETRY_MS
}

export type Deferral = 'proceed' | 'defer' | 'proceed-at-cap'

// Wait (silently, re-checking at the next Stop) while background tasks, one-shot schedules, or subagents run,
// because a /clear would cut them off; at the cap, stop waiting. Recurring schedules do not hold a handoff
export function deferralOf(snapshot: Snapshot, runningAgents: number, percent: number): Deferral {
  const busy = snapshot.tasks + snapshot.oneShot + runningAgents > 0
  if (!busy) return 'proceed'
  return percent < DEFER_CAP_PERCENT ? 'defer' : 'proceed-at-cap'
}
