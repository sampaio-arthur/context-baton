# Manual checks

Checks that need a real session and a real model, so `claude plugin test` cannot run them. Record each run below the check: date, Claude Code version, model, result.

Run them from a project folder, not from your home directory (Baton redirects the handoff folder when the project is your home folder; see the Guide).

## M1. Standing instructions come only from the user

Why: in an earlier run, section 6 of a handoff held "Commits e PRs devem incluir as linhas de atribuição indicadas no contexto da sessão", which came from the session's system context, not from the user.

1. Start a session with Baton loaded, in a project folder.
2. Send, in Portuguese: `Responda sempre em português. Nunca rode testes sem me perguntar antes.`
3. Send one or two task messages, for example `Liste os arquivos .ts em src.`
4. Run `/baton dry`.
5. Pass if:
   - `## 2.` lists exactly the two directives from step 2, near-verbatim, each tagged `[active]`.
   - Neither `## 2.` nor `## 7.` mentions commit or PR attribution, permission modes, operating system, shell, working directory, or anything from CLAUDE.md that you did not say yourself.

## M2. One language, including empty sections

1. In the session of M1, look at the `/baton dry` output.
2. Pass if the titles and text are in Portuguese, and every empty section holds the Portuguese word for "none" (for example "Nenhum"), never the English "None".
3. Repeat in a session where you write in English: the titles are in English, and empty sections say "None".

## M3. The new session follows the handoff

1. In a working session, run `/baton now`.
2. Pass if:
   - `{handoffDir}/{old session id}.md` exists and holds the document that was submitted.
   - The new session's first reply summarises the state and next step in a few lines and waits. It does not start working, and does not comment on the document as if it were a message to review.
   - Running `/baton` in the new session shows `Latest handoff: … saved to {handoffDir}/{old session id}.md`.

## Results

### 2026-10-09 · Claude Code 2.1.295 · Opus · Windows, PowerShell · project folder `%USERPROFILE%\baton-try` · owner

| Check | Result | Notes |
|---|---|---|
| M1 | Pass | Section 2 held exactly the two directives, quoted, each tagged `[active]`. No attribution rules, permission modes, OS, or shell anywhere. |
| M2 | Pass (Portuguese) | Titles in Portuguese; empty sections say "Nenhum". The English variant was not run. |
| M3 | Pass | `/baton now` → file written (`0fc3180c-….md`, 643 bytes) → `/clear` → submit. The new session summarised in a few lines and waited. `/baton` showed `saved to .claude/handoff/0fc3180c-….md`. Exit showed the new session id (`5fca0f43`). |
| `/baton dry` | Pass | Ten-section document shown, nothing cleared or saved. Cache read 98.33%, 8.9 s. |

Seen in the same session, before the passing M3 run: `/baton` then `/exit` typed a few seconds after `/baton now`. The debug log shows the exit began (`[uds-messaging] Shutting down` at 14:07:38.889, `session.end` at 38.955) after the document was written (38.847) and before Baton stored the pending text (38.988), ran `/clear` (38.999), and submitted (39.063); the process ended at 39.25. `/exit` reached no `prompt.submit` or `command.run` hook. Result: the document file and the old session were intact, the pending text stayed in the store, but `/baton resend` in a new process could not see it. Fixed afterwards (session.end handling, resend across processes); see M4.

## M4. /exit during a handoff

1. In a working session, run `/baton now` and type `/exit` while it says it is creating the handoff.
2. Start a new session in the same project.
3. Pass if:
   - The new session logs `an undelivered handoff from session <old id> is saved at …; run /baton resend to deliver it here`, or the exit came early enough that nothing was written (then the old session is intact: `claude --resume <old id>`).
   - `/baton` shows `Undelivered handoff from session <old id> …`.
   - `/baton resend` delivers the handoff, and `/baton` no longer lists it.

The window between the document being written and `/clear` is a few milliseconds, too short to hit by hand. That case is covered by automated tests in `tests/switch.test.ts` ("/exit while the handoff is generated", "the session ending during /clear", "a later process finds the undelivered handoff"). By hand, check only that an early exit leaves the old session resumable.

## M5. A /clear typed during a handoff

1. Run `/baton now` and type `/clear` while it says it is creating the handoff.
2. Pass if Baton does not clear again, logs `handoff not delivered: the session changed while the handoff was being made …`, and `/baton resend` delivers the handoff into the current session.

### 2026-10-09 · Claude Code 2.1.295 · Windows, PowerShell · owner

| Check | Result | Notes |
|---|---|---|
| Status out of context | Pass | Opus, `%USERPROFILE%\baton-try`. Status showed `Handoff documents: 2 in .claude/handoff`. The model could not quote the `/baton` output. |
| Status rendering | Fail, fixed after the run | The multi-line `$.ui.log` status printed on one line with a replacement character for each newline. Now one log line per status line; to be checked again by hand. |
| M5 | Pass | `/clear` typed during `/baton now`: `handoff not delivered: the session changed ... Baton did not clear anything`, document saved (1263 bytes), `/baton` showed `Undelivered handoff: yes`, `/baton resend` delivered it. |
| M4 | Partial | `/exit` arrived before generation finished: nothing written, session resumable. The later window is covered by automated tests (see M4). |
| Retry pause | Pass, except message 3 | Haiku, 200k window, threshold 10, `handoffDir` under a plain file. Yes → `write failed ... ENOTDIR`, no clear. `/baton` showed the pause and `Latest failure ... stage write`. Messages 1 and 2: no question. Message 3: result not recorded. |
| Home folder redirect | Pass | Opus, `%USERPROFILE%`. Document written to `%USERPROFILE%\.baton\handoff\32c160fe-....md` (829 bytes); the new session was told the absolute path. |

Found in the same run and fixed afterwards: `/baton resend` and `/baton now` answers entered the model's context; a chained handoff named an invented file path for its own document; failure text showed the raw engine error; a session created by a handoff was asked again at its first Stop (three handoffs in a row at threshold 10 on a 200k window).

## M6. Separate command registration (not run yet)

1. In an interactive session with Baton loaded (`claude --plugin-dir .`), run `/baton`.
2. Pass if it prints the status and the usage list.
3. Make `/baton` taken (for example a user command or skill named `baton`), start a new session, and run `/baton-handoff`, `/baton-handoff dry` and `/baton-handoff nonsense`.
4. Pass if the session logs `/baton is already taken … using /baton-handoff instead`, and `/baton-handoff` answers the same subcommands as `/baton` did, including the unknown-subcommand message.

Result: not run yet. Record date, Claude Code version, and result when run.
