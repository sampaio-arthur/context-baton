// The consent question and how any answer or rejection maps to yes / no. Pure: no $.
export const YES = 'Yes'
export const NO = 'No'
// Shown as a chip beside the question (12 characters at most)
export const HEADER = 'Baton'

export const questionOf = (percent: number) => `Context is at ${percent}%. Hand off and continue in a new session?`

// Only the exact "Yes" label is a yes. Text typed under "Other" comes back as the answer: anything but the
// label, including "yes" typed by hand, is a no
export const consentOf = (answer: string): 'yes' | 'no' => (answer === YES ? 'yes' : 'no')

// Why $.ui.ask rejected. Every rejection is a "No"; `dismissed` (the user closed the dialog) needs no comment,
// anything else (the tool unavailable or denied, a timeout, another error) is logged once per session
export type Rejection = { kind: 'dismissed' } | { kind: 'unavailable' | 'other'; reason: string }

// Observed in 2.1.295: Esc → `$.ui.ask: no answer (The user doesn't want to proceed with this tool use...)`;
// an empty answer → `no answer (the dialog was dismissed)`; a hook or permission deny → `no answer (<deny text>)`;
// no dialog (claude -p) → `$.tool.call: no tool named "AskUserQuestion" in this session`
export function rejectionOf(err: unknown): Rejection {
  const text = err instanceof Error ? err.message : String(err)
  if (/no tool named "?AskUserQuestion"?/.test(text)) return { kind: 'unavailable', reason: text }
  if (/the dialog was dismissed|doesn't want to proceed with this tool use/i.test(text)) return { kind: 'dismissed' }
  const m = /no answer \(([\s\S]*)\)\s*$/.exec(text)
  return { kind: 'other', reason: m?.[1] ?? text }
}

// After a "No", ask again only once usage reaches this percentage
export const snoozeMarkOf = (percent: number, snoozePoints: number) => percent + snoozePoints
