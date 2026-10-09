// The handoff document: prompt rules, structural validation, one bounded retry, the file, /baton dry
import { expect, test } from 'claude-code/testing'
import { HANDOFF_PROMPT, SECTIONS, checkHandoff, describeCheck, normalizeHandoff, retryPrompt } from '../src/handoff'
import { HANDOFF, PROJECT, ROOT, TITLES, cmd, gate, say, world, showStatus } from './world'

const doc = (numbers: readonly number[], first = 'HANDOFF: goal', titles: readonly string[] = TITLES) =>
  [first, ...numbers.map(n => `## ${n}. ${titles[n - 1] ?? 'x'}\nNone`)].join('\n')
const ALL = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]

// ---------- the prompt ----------

test('prompt: ten numbered sections in the order of section 3.5, Standing instructions second', () => {
  expect(SECTIONS.length).toBe(10)
  SECTIONS.forEach((title, i) => expect(HANDOFF_PROMPT).toContain(`## ${i + 1}. ${title}:`))
  expect(SECTIONS[1]).toBe('Standing instructions')
  expect(HANDOFF_PROMPT).toContain('[active] or [superseded]')
})

test('prompt: standing instructions and decisions come only from the user, not from system or environment context', () => {
  expect(HANDOFF_PROMPT).toContain('Sections 2 and 7 contain only what the user wrote in their own messages')
  for (const source of ['system prompt', 'CLAUDE.md', 'tool descriptions', 'hooks', 'plugins', 'commit attribution rules', 'working directory']) {
    expect(HANDOFF_PROMPT).toContain(source)
  }
})

test('prompt: one language rule, including the word for an empty section', () => {
  expect(HANDOFF_PROMPT).toContain('Write everything in the language the user writes in, including the section titles')
  expect(HANDOFF_PROMPT).toContain('that language\'s word for "none"')
  // No competing instruction to write the English word
  expect(HANDOFF_PROMPT).not.toContain('Write "None"')
})

test('prompt: no unevidenced completion claims', () => {
  expect(HANDOFF_PROMPT).toContain('Never state that a test passed, a build succeeded, or a file changed unless the conversation shows it')
})

// ---------- validation ----------

test('a complete document passes', () => {
  expect(checkHandoff(doc(ALL))).toEqual({ ok: true, firstLine: true, missing: [], outOfOrder: false })
  expect(checkHandoff(HANDOFF).ok).toBe(true)
})

test('titles in another language pass: validation goes by number', () => {
  const pt = ['Objetivo', 'Instruções permanentes', 'Verificado', 'Feito mas não verificado', 'Abordagens que falharam',
    'Em execução ou inacabado', 'Decisões', 'Arquivos e comandos', 'Próximo passo', 'Perguntas em aberto']
  expect(checkHandoff(doc(ALL, 'HANDOFF: objetivo', pt)).ok).toBe(true)
})

test('each missing section is reported by number and title', () => {
  for (const n of ALL) {
    const c = checkHandoff(doc(ALL.filter(x => x !== n)))
    expect(c.ok).toBe(false)
    expect(c.missing).toEqual([n])
    expect(describeCheck(c)).toBe(`missing ## ${n}. ${SECTIONS[n - 1]}`)
  }
})

test('sections out of order fail', () => {
  const c = checkHandoff(doc([1, 2, 4, 3, 5, 6, 7, 8, 9, 10]))
  expect(c).toEqual({ ok: false, firstLine: true, missing: [], outOfOrder: true })
  expect(describeCheck(c)).toBe('sections out of order')
})

test('a wrong first line fails', () => {
  for (const first of ['Handoff: goal', '# HANDOFF: goal', '', 'Here is the handoff:']) {
    const c = checkHandoff(doc(ALL, first))
    expect(c.ok).toBe(false)
    expect(c.firstLine).toBe(false)
  }
})

test('## 1. is not confused with ## 10., and old unnumbered headings do not count', () => {
  expect(checkHandoff(doc([2, 3, 4, 5, 6, 7, 8, 9, 10])).missing).toEqual([1])
  expect(checkHandoff('HANDOFF: x\n## Goal\nNone').missing).toEqual(ALL)
})

test('normalizeHandoff removes a fence around the whole reply and outer whitespace', () => {
  expect(normalizeHandoff(`\n\`\`\`markdown\n${HANDOFF}\n\`\`\`\n`)).toBe(HANDOFF)
  expect(normalizeHandoff(`  ${HANDOFF}  `)).toBe(HANDOFF)
  expect(checkHandoff(normalizeHandoff(`\`\`\`\n${HANDOFF}\n\`\`\``)).ok).toBe(true)
})

test('the retry prompt is the full prompt plus what was wrong', () => {
  const p = retryPrompt(checkHandoff(doc(ALL.filter(x => x !== 2 && x !== 8))))
  expect(p).toStartWith(HANDOFF_PROMPT)
  expect(p).toContain('missing ## 2. Standing instructions, ## 8. Key files and commands')
})

// ---------- the flow ----------

test('valid at once: one fork, the file written, then /clear and submit naming the file', async ($, on) => {
  const w = world(on)
  await cmd($, 'now')
  await w.clock.settle()
  expect(w.forks.length).toBe(1)
  expect(w.files.get(`${ROOT}/.claude/handoff/S1.md`)).toBe(`${HANDOFF}\n`)
  expect(w.commands).toEqual(['clear'])
  expect(w.submits.length).toBe(1)
  expect(w.submits[0]).toContain('The handoff is also saved at .claude/handoff/S1.md.')
  expect(w.submits[0]).toContain(HANDOFF)
  expect((await showStatus($)).text).toContain('saved to .claude/handoff/S1.md')
})

test('incomplete once: one retry naming the missing section, then the switch', async ($, on) => {
  const w = world(on)
  w.ctl.forkReplies = [doc(ALL.filter(x => x !== 6))]
  await cmd($, 'now')
  await w.clock.settle()
  expect(w.forks.length).toBe(2)
  expect(w.forks[1]).toContain('missing ## 6. Still running or unfinished')
  expect(w.logs.join()).toContain('asking once more')
  expect(w.files.size).toBe(1)
  expect(w.commands).toEqual(['clear'])
  expect(w.submits.length).toBe(1)
})

test('incomplete twice: stage validate, nothing written, no /clear, held messages go back', async ($, on) => {
  const w = world(on)
  const g = gate()
  w.ctl.forkGate = g.wait
  w.ctl.forkReplies = ['no structure at all', doc(ALL.filter(x => x !== 2))]
  await cmd($, 'now')
  await w.clock.advance(0)
  await say($, 'still there?')
  g.open()
  await w.clock.settle()
  expect(w.forks.length).toBe(2)
  expect(w.files.size).toBe(0)
  expect(w.commands).toEqual([])
  expect(w.submits).toEqual(['still there?'])
  const f = w.get(`failure:${PROJECT}`) as { stage: string; reason: string }
  expect(f.stage).toBe('validate')
  expect(f.reason).toBe('missing ## 2. Standing instructions')
  expect(w.keys().filter(k => k.startsWith('pendingSubmit:'))).toEqual([])
})

test('the retry fork failing is a generate failure', async ($, on) => {
  const w = world(on)
  w.ctl.forkReplies = ['no structure at all']
  let n = 0
  w.ctl.forkGate = async () => { n += 1; if (n === 2) w.ctl.failFork = true }
  await cmd($, 'now')
  await w.clock.settle()
  expect(w.forks.length).toBe(2)
  expect((w.get(`failure:${PROJECT}`) as { stage: string }).stage).toBe('generate')
  expect(w.commands).toEqual([])
})

test('write failure: stage write, no /clear, nothing pending', async ($, on) => {
  const w = world(on)
  w.ctl.failWrite = true
  await cmd($, 'now')
  await w.clock.settle()
  expect(w.commands).toEqual([])
  expect(w.submits).toEqual([])
  expect((w.get(`failure:${PROJECT}`) as { stage: string }).stage).toBe('write')
  expect(w.keys().filter(k => k.startsWith('pendingSubmit:'))).toEqual([])
})

test('the configured handoffDir is used', { options: { handoffDir: 'docs/handoffs' } }, async ($, on) => {
  const w = world(on)
  await cmd($, 'now')
  await w.clock.settle()
  expect([...w.files.keys()]).toEqual([`${ROOT}/docs/handoffs/S1.md`])
  expect(w.submits[0]).toContain('saved at docs/handoffs/S1.md')
})

test('/baton dry validates, retries once, shows the document, writes nothing, does not /clear', async ($, on) => {
  const w = world(on)
  w.ctl.forkReplies = [doc(ALL.filter(x => x !== 10))]
  const text = (await cmd($, 'dry')).text ?? ''
  expect(text).toContain('Trial run done (no /clear, nothing saved)')
  expect(text).toContain('the first attempt was incomplete and was retried once')
  expect(text).toContain(HANDOFF)
  expect(w.forks.length).toBe(2)
  expect(w.files.size).toBe(0)
  expect(w.commands).toEqual([])
})

test('/baton dry with an incomplete document twice reports the failure', async ($, on) => {
  const w = world(on)
  w.ctl.forkReplies = ['x', 'y']
  const text = (await cmd($, 'dry')).text ?? ''
  expect(text).toContain('Trial run failed')
  expect((w.get(`failure:${PROJECT}`) as { stage: string; kind: string })).toMatchObject({ stage: 'validate', kind: 'dry' })
})
