# Changelog

All notable changes to Baton are recorded here. Versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### 0.1.0 (not yet released)

First version, derived from [ctx-handoff-mod](https://github.com/cablate/ctx-handoff-mod) 0.5.0 by cablate (MIT).

#### Added
- Percentage threshold (`thresholdPercent`, 10–90, default 40), using Claude Code's own context percentage.
- Consent question at the end of a turn. Only "Yes" hands off; "No", Esc, a timeout, typed text, or a rejected dialog count as "No". A rejection other than closing the dialog is logged once per session.
- Snooze after a "No" (`snoozePoints`, 1–50, default 10), stored per session so a plugin reload does not re-ask. The session a handoff created gets a snooze mark at its first turn.
- Handoff document with ten numbered sections, including Standing instructions, written in the user's language. Sections 2 and 7 hold only what the user said and decided. Structural validation with one bounded retry.
- Documents saved to `<handoffDir>/<session-id>.md` (`handoffDir`, default `.claude/handoff`), or to `~/.baton/handoff/` when that folder would be inside Claude Code's own folder or the project folder is inside the Windows folder or Program Files.
- `/baton` status, `/baton now`, `/baton dry`, `/baton resend`; `/baton-handoff` when `/baton` is taken. Status and command answers are shown in the terminal without entering the model's context.
- Stage-named failures (`generate`, `validate`, `write`, `clear`, `submit`) with a readable sentence; the raw error goes to the debug log.
- A pause after a failed handoff (3 messages or 10 minutes, whichever comes first).
- Silent wait while background tasks, one-off schedules, or subagents run (up to 90% usage); `/baton` says when a handoff is being held back.
- Safety when the session ends or changes during a handoff (`/exit`, closing the terminal, a typed `/clear` or `/resume`): Baton does not clear, keeps the document and the pending handoff, and `/baton resend` delivers it, also from a later session in the same project.
- Failure handlers on the Stop, prompt, and command hooks: on failure the Stop does nothing, the user's message goes through, and the command answers with a short error.

#### Removed (from the upstream engine)
- Idle prompt-cache refresh, away handoffs, project-notes distillation, guards, the panel, the retry and done-check nudges, the reply-language check, and the Traditional Chinese interface.
- Token-count thresholds.
