# Working on Baton

Instructions for contributors and the AI assistants they use in this repository.

## Working method

- Read `IMPLEMENTATION_PLAN.md` first. Work in small, planned steps; at the end of each step, stop and report what changed before going on.
- Confirm every Claude Code mods API call against the generated types in `.claude-plugin/types/` or the official reference before using it. The types appear the first time Claude Code loads the plugin in an interactive session (`claude --plugin-dir .`). If a call you need does not exist, stop and report it instead of working around it.
- Report only what was verified. Cite the command and its result; list everything else as "not verified". Record checks that need a real session in `tests/MANUAL.md`, with the date, Claude Code version, and result.
- Keep decision logic in pure functions in `src/`, with tests in `tests/`. Every function that calls the mods API (`$`) lives in `hooks/register.ts`: Claude Code follows `$` only into functions declared at the top level of the same file.
- Everything in this repository is written in English: code, comments, messages, documentation.
- Releases and marketplace publication are done by the maintainer.

## Checks

Run all three before reporting a change as done:

```bash
claude plugin validate .
claude plugin test .
npx -p typescript tsc -p .
```
