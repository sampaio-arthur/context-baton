// User configuration: defaults and validation of the options register(on, options) receives, plus fixed limits.
// Pure: no $. The engine fills in the manifest's defaults and checks each value's type before the module loads;
// ranges and the handoff folder are checked here, and a bad value falls back to its default with a problem line.
import { M } from './messages'

export type Config = {
  // Context usage, in percent of the window, that triggers the question
  thresholdPercent: number
  // After a "No", how many points usage must grow before asking again
  snoozePoints: number
  // Where handoff documents are written, relative to the project. Never pruned: the mods API cannot delete files
  handoffDir: string
}

export const DEFAULTS: Config = { thresholdPercent: 40, snoozePoints: 10, handoffDir: '.claude/handoff' }

const RANGES = {
  thresholdPercent: { min: 10, max: 90 },
  snoozePoints: { min: 1, max: 50 },
} as const

export type IntKey = keyof typeof RANGES

function intValue(key: IntKey, raw: unknown, problems: string[]): number {
  const d = DEFAULTS[key]
  if (raw === undefined) return d
  const { min, max } = RANGES[key]
  if (typeof raw !== 'number' || !Number.isInteger(raw)) {
    problems.push(M.config.notInteger(key, String(raw), d))
    return d
  }
  if (raw < min || raw > max) {
    problems.push(M.config.outOfRange(key, raw, min, max, d))
    return d
  }
  return raw
}

// A folder inside the project: relative, never climbing above the project root. Returns it normalized
// (forward slashes, no `.` segments, no trailing slash), or undefined when it is not acceptable
export function projectRelativeDir(raw: string): string | undefined {
  const p = raw.trim().replace(/\\/g, '/')
  if (p === '' || p.startsWith('/') || p.startsWith('~') || /^[A-Za-z]:/.test(p)) return undefined
  const parts: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (parts.length === 0) return undefined
      parts.pop()
      continue
    }
    parts.push(seg)
  }
  return parts.length === 0 ? undefined : parts.join('/')
}

// Folders Claude Code loads .md files from as commands, agents, skills, rules or output styles: a handoff document
// there would become one of them, so the handoff folder may be neither one of these nor inside one
const LOADED_DIRS = ['.claude/commands', '.claude/agents', '.claude/skills', '.claude/rules', '.claude/output-styles']
export function isLoadedDir(dir: string) {
  const d = dir.toLowerCase()
  return LOADED_DIRS.some(l => d === l || d.startsWith(`${l}/`))
}

function dirValue(raw: unknown, problems: string[]): string {
  if (raw === undefined) return DEFAULTS.handoffDir
  const dir = typeof raw === 'string' ? projectRelativeDir(raw) : undefined
  if (dir === undefined) {
    problems.push(M.config.badDir(String(raw), DEFAULTS.handoffDir))
    return DEFAULTS.handoffDir
  }
  if (isLoadedDir(dir)) {
    problems.push(M.config.loadedDir(dir, DEFAULTS.handoffDir))
    return DEFAULTS.handoffDir
  }
  return dir
}

// Every value checked; each rejected one is replaced by its default and named in `problems`
export function resolveConfig(options: Readonly<Record<string, unknown>>): { config: Config; problems: string[] } {
  const problems: string[] = []
  const config: Config = {
    thresholdPercent: intValue('thresholdPercent', options.thresholdPercent, problems),
    snoozePoints: intValue('snoozePoints', options.snoozePoints, problems),
    handoffDir: dirValue(options.handoffDir, problems),
  }
  return { config, problems }
}

// Fixed limits. Values derived from ctx-handoff-mod (MIT, Copyright (c) 2026 cablate).

// Handoffs kept in the store per project; the documents themselves are files
export const KEEP_HANDOFFS = 5
// $.model.fork takes no timeout or abort signal: past this the handoff is abandoned
// (held messages go back to the old conversation) and a late reply is ignored
export const HANDOFF_TIMEOUT_MS = 3 * 60_000
