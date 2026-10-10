// Store records, key names, cleanup rules, and the path helpers behind the project key. Pure: no $.
// Derived from ctx-handoff-mod (MIT, Copyright (c) 2026 cablate).
import { M } from './messages'

export type Kind = 'threshold' | 'manual' | 'dry'
// The stage a handoff failed at. `write` covers saving the document file and storing the pending submit before /clear.
export type Stage = 'generate' | 'validate' | 'write' | 'clear' | 'submit'
export type Usage = { input: number; cacheRead: number; cacheCreation: number; output: number; ms: number }
// The document itself is in the file (`file`, relative to the project); a dry run writes none
export type Saved = { at: number; sessionId: string; kind: Kind; tokens: number | null; usage?: Usage; file?: string }
// `reason` is the short form shown to the user; `detail` the raw error, when there was one
export type Failure = { at: number; sessionId: string; kind: Kind; stage: Stage; reason: string; detail?: string; tokens: number | null; turns: number }

// Session-scoped: the full text to submit, kept until the new session received it. Stored before /clear, so a
// handoff cut off by an exit or a crash can still be delivered later with /baton resend, from any process
export const pendingKey = (sessionId: string) => `pendingSubmit:${sessionId}`
export type Pending = { text: string; at: number; sessionId: string; project: string; file?: string }

// A pending handoff left by another session of this project (for example one cut off by /exit), for
// /baton resend in a later process. Entries younger than a minute may still be in flight in a live process
export const PENDING_SETTLE_MS = 60_000
export function latestForeignPending(entries: readonly unknown[], project: string, currentSid: string, now: number): Pending | undefined {
  const candidates = entries.filter((p): p is Pending => {
    const r = p as Partial<Pending> | undefined
    return typeof r?.text === 'string' && typeof r.at === 'number' && typeof r.sessionId === 'string' && r.project === project
  }).filter(p => p.sessionId !== currentSid && now - p.at >= PENDING_SETTLE_MS)
  return candidates.sort((a, b) => b.at - a.at)[0]
}
// Session-scoped: the snooze mark after a "No", kept across plugin reloads (a settings change reloads it)
export const snoozeKey = (sessionId: string) => `snooze:${sessionId}`
// `after`: why the mark was set, a "No" (absent in older records) or the start of a session a handoff created
export type Snooze = { mark: number; at: number; after?: 'no' | 'handoff' }
// Session-scoped: set on the session a Baton handoff created; its first measured Stop sets a snooze mark
// instead of asking (a session that starts above the threshold would otherwise be asked at once)
export const handedOffKey = (sessionId: string) => `handedOff:${sessionId}`
// Project-scoped: recent handoffs and the latest failure
export const handoffsKey = (project: string) => `handoffs:${project}`
export const failureKey = (project: string) => `failure:${project}`
// First time each session-scoped key was seen, for pruning
export const SEEN_KEY = 'seen'

export function describeUsage(u: Usage) {
  const total = u.input + u.cacheRead + u.cacheCreation
  const ratio = total === 0 ? 0 : (u.cacheRead / total) * 100
  const n = (v: number) => v.toLocaleString('en-US')
  return `input ${n(total)} (cache read ${n(u.cacheRead)} = ${ratio.toFixed(2)}%, written ${n(u.cacheCreation)}, uncached ${n(u.input)}) · output ${n(u.output)} · ${(u.ms / 1000).toFixed(1)}s`
}

const PRUNE_MS = 30 * 24 * 60 * 60_000
const isSessionKey = (k: string) => /^(?:pendingSubmit|snooze|handedOff):[^:]+$/.test(k)

// Records unseen session keys in `seen` (mutating it) and returns whether it changed and which keys
// expired (also removed from `seen`)
export function pruneSeen(keys: readonly string[], seen: Record<string, number>, now: number) {
  let changed = false
  const expired: string[] = []
  for (const k of keys) {
    if (isSessionKey(k) && seen[k] === undefined) { seen[k] = now; changed = true }
  }
  for (const [k, at] of Object.entries(seen)) {
    if (now - at <= PRUNE_MS) continue
    expired.push(k)
    delete seen[k]
    changed = true
  }
  return { changed, expired }
}

export const slash = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
export const encodeProject = (p: string) => slash(p).replace(/[^A-Za-z0-9]/g, '-')

// Where documents are written. Normally {root}/{handoffDir}. Redirected to ~/.baton/handoff when:
// - `claude`: that folder falls inside Claude Code's own folder (the project root is the home folder, so
//   .claude/handoff is ~/.claude/handoff);
// - `system`: the project root is inside a system folder (the Windows folder or Program Files, for example
//   C:\WINDOWS\system32 in an administrator shell).
// `shown` is how the new session and /baton name it: relative to the project, or absolute when redirected.
// Without a known home folder there is nowhere to redirect to, and the project folder is used
// `root` + `sub` (the project and the checked handoffDir) or `home` say where the folder is, so the writer can spell
// the rest of the path as fixed text; `dir` is the same folder in one string.
export const REDIRECT_DIR = '.baton/handoff'
export type HandoffFolder =
  | { dir: string; shown: string; redirected: false; root: string; sub: string }
  | { dir: string; shown: string; redirected: true; why: 'claude' | 'system'; home: string }
export function handoffFolder(root: string, handoffDir: string, home: string | undefined, configDir: string | undefined, systemDirs: readonly (string | undefined)[] = []): HandoffFolder {
  const project = { dir: `${slash(root)}/${handoffDir}`, shown: handoffDir, redirected: false as const, root: slash(root), sub: handoffDir }
  if (!home) return project
  const claudeDir = configDir ? slash(configDir) : `${slash(home)}/.claude`
  const why = isInside(project.dir, claudeDir) ? 'claude'
    : systemDirs.some(s => s !== undefined && s.trim() !== '' && isInside(slash(root), slash(s))) ? 'system'
    : undefined
  if (why === undefined) return project
  const redirected = `${slash(home)}/${REDIRECT_DIR}`
  return { dir: redirected, shown: redirected, redirected: true, why, home: slash(home) }
}

// The file name part of a handoff document, <session-id> in <handoff folder>/<session-id>.md. Claude Code's
// session ids are UUIDs; any id that is not letters, digits, - and _ (at most 128) is refused, so the name can
// neither leave the handoff folder nor change the .md extension
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/
export function documentId(sessionId: string) {
  if (!SESSION_ID.test(sessionId)) throw new Error(M.handoff.badSessionId(sessionId))
  return sessionId
}

// Windows paths compare without case; POSIX paths with it
function isInside(path: string, folder: string) {
  const windows = /^[A-Za-z]:\//.test(folder)
  const p = windows ? path.toLowerCase() : path
  const f = windows ? folder.toLowerCase() : folder
  return p === f || p.startsWith(`${f}/`)
}
