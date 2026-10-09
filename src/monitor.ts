// Context percentage and the threshold decision. Pure: the usage is passed in.

// The live context window as $.session.usage() reports it
export type ContextUsage = { tokens?: number; window: number; percent?: number }

// The engine's own percentage (what the status line shows); when it has none, floor(tokens / window * 100).
// Undefined when neither is known: at session start and right after /clear, until the first response
export function percentOf(c: ContextUsage): number | undefined {
  if (typeof c.percent === 'number' && Number.isFinite(c.percent)) return Math.floor(c.percent)
  if (typeof c.tokens !== 'number' || !Number.isFinite(c.tokens) || !(c.window > 0)) return undefined
  return Math.floor((c.tokens / c.window) * 100)
}

// Ask when usage is known, at or above the threshold, and at or above the snooze mark when one is set.
// An unknown percentage counts as below the threshold
export function shouldPrompt(percent: number | undefined, thresholdPercent: number, snoozeMark?: number): boolean {
  if (percent === undefined) return false
  if (percent < thresholdPercent) return false
  return snoozeMark === undefined || percent >= snoozeMark
}
