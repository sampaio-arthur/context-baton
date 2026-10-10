// The handoff document: generation prompt, structural validation, retry prompt, and the text submitted to the
// new session. Pure: no $. The format is the one inherited from ctx-handoff-mod (MIT, Copyright (c) 2026
// cablate) plus a Standing instructions section, with numbered headings.
import { M } from './messages'
import { TAG } from './name'

// Section titles in the order of the headings `## 1.` to `## 10.`. The model writes them in the conversation's
// language, so validation goes by number; these English titles name a missing section in the retry prompt
export const SECTIONS = [
  'Goal',
  'Standing instructions',
  'Verified',
  'Done but not verified',
  'Failed approaches',
  'Still running or unfinished',
  'Decisions',
  'Key files and commands',
  'Next step',
  'Open questions',
] as const

export const HANDOFF_PROMPT = [
  'Write a handoff document for a new conversation that will continue this work. The new session sees only this document, plus the system prompt and project instructions it loads again by itself.',
  '',
  'Format, exactly:',
  '- The first line is "HANDOFF: " followed by a one-sentence goal.',
  '- Then ten sections, in this order, each starting with a heading line "## N. <title>", where N is the section number from 1 to 10. Write the titles in the conversation\'s language, but keep "## " and the number.',
  '',
  '## 1. Goal: the user\'s actual request.',
  '## 2. Standing instructions: every directive the user gave in their own messages (scope limits, "never X", style and process rules), near-verbatim, each tagged [active] or [superseded] (superseded: later replaced or withdrawn by the user).',
  '## 3. Verified: checks actually run with their results seen (tests, builds, command output), with the results.',
  '## 4. Done but not verified: changes not yet checked, or conclusions based only on inference.',
  '## 5. Failed approaches: what was tried and failed, and why (the next session should not retry them).',
  '## 6. Still running or unfinished: background processes, dev servers, uncommitted or unsaved changes, temporary files.',
  '## 7. Decisions: decisions made with the user, and why.',
  '## 8. Key files and commands: relevant file paths and commands.',
  '## 9. Next step: one concrete action.',
  '## 10. Open questions: questions waiting for the user.',
  '',
  'Sources:',
  '- Sections 2 and 7 contain only what the user wrote in their own messages in this conversation, and what was decided with the user. Do not include instructions that come from the system prompt, CLAUDE.md or other instruction files, tool descriptions, hooks, plugins, or the environment (for example commit attribution rules, permission modes, operating system, shell, working directory): the new session receives those again by itself.',
  '- If this conversation began with a handoff from an earlier session, its standing instructions and decisions came from the user: carry them over.',
  '- Never state that a test passed, a build succeeded, or a file changed unless the conversation shows it. Anything not shown goes to section 4.',
  '- Do not name this document\'s own file, folder, or session id, and do not guess them: the plugin that saves the document adds its real location when it delivers it.',
  '',
  'Language:',
  '- Write everything in the language the user writes in, including the section titles. A section with nothing to report contains only that language\'s word for "none" (for example "None" in English, "Nenhum" in Portuguese).',
  '- Keep code, commands, paths, and error messages as they are.',
  '',
  'Facts only, no greetings, no closing remarks. Keep the whole document under 6,000 characters.',
].join('\n')

// The reply as a document: trimmed, without a code fence around the whole of it
export function normalizeHandoff(text: string) {
  const t = text.trim()
  const fenced = /^```[^\n]*\n([\s\S]*?)\n```$/.exec(t)
  return (fenced?.[1] ?? t).trim()
}

export type HandoffCheck = { ok: boolean; firstLine: boolean; missing: number[]; outOfOrder: boolean }

// Structural only: the first line starts with "HANDOFF:", and the headings `## 1.` to `## 10.` are all present,
// in order. Content quality is not judged
export function checkHandoff(text: string): HandoffCheck {
  const firstLine = /^HANDOFF:/.test(text.split('\n', 1)[0] ?? '')
  const seen = [...text.matchAll(/^##\s*(\d+)\.(?:\s|$)/gm)].map(m => Number(m[1]))
  const firstAt = (n: number) => seen.indexOf(n)
  const missing: number[] = []
  for (let n = 1; n <= SECTIONS.length; n++) if (firstAt(n) === -1) missing.push(n)
  const order = SECTIONS.map((_, i) => firstAt(i + 1)).filter(i => i !== -1)
  const outOfOrder = order.some((v, i) => i > 0 && v < (order[i - 1] ?? -1))
  return { ok: firstLine && missing.length === 0 && !outOfOrder, firstLine, missing, outOfOrder }
}

// What was wrong, in words, for the retry prompt and the failure record
export function describeCheck(c: HandoffCheck) {
  const parts: string[] = []
  if (!c.firstLine) parts.push('the first line does not start with "HANDOFF:"')
  if (c.missing.length) parts.push(`missing ${c.missing.map(n => `## ${n}. ${SECTIONS[n - 1]}`).join(', ')}`)
  if (c.outOfOrder) parts.push('sections out of order')
  return parts.join('; ')
}

// The one bounded retry: the same request, naming what the first attempt got wrong. The first reply is not in
// the transcript the fork reads, so the prompt is complete on its own
export const retryPrompt = (c: HandoffCheck) =>
  `${HANDOFF_PROMPT}\n\nA previous attempt was rejected: ${describeCheck(c)}. Write the whole document again with all ten numbered sections, in order.`

// Why a fork gave no text. nothing-to-fork usually means the session was just started or cleared
export function forkFailure(reason: string) {
  if (reason === 'timeout') return M.fork.timeout
  return reason === 'nothing-to-fork' ? M.fork.nothingToFork : reason
}

export const heldBlock = (items: readonly string[]) => `${M.handoff.heldHead}\n${items.join('\n\n')}`

// The full text submitted after /clear: intro, where the document is saved, the handoff, and held messages
export function submitText(why: string, handoff: string, held: readonly string[], note?: string, file?: string) {
  const intro = `${TAG} ${held.length === 0 ? M.handoff.intro(why) : M.handoff.introHeld(why)}`
  const saved = file ? ` ${M.handoff.savedAt(file)}` : ''
  return `${intro}${note ? M.handoff.note(note) : ''}${saved}\n\n${handoff}${held.length ? `\n\n${heldBlock(held)}` : ''}`
}

export const resendText = (handoff: string) => `${TAG} ${M.cmd.resendIntro}\n\n${handoff}`

