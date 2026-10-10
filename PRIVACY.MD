# Privacy

Context Baton runs entirely on your machine, inside Claude Code. Its author operates no server and receives no data from it.

## What the plugin handles

- **Handoff documents.** When you agree to a handoff (or run `/baton now`), the plugin asks the model for a summary of the current conversation and saves it as a file on your machine: `<handoff folder>/<session-id>.md`, or `~/.baton/handoff/` when the project is your home folder or a system folder. The document can contain anything you wrote in that conversation, including personal data.
- **Plugin state.** Small entries in the plugin's own store inside Claude Code: pending handoffs, snooze marks, and the latest handoff and failure. Entries tied to a session are removed after 30 days.

## Where data goes

- Nothing is sent to the author or to any third-party service. The plugin makes no network requests of its own and collects no telemetry or analytics.
- Generating a handoff is a model call made by Claude Code on your own Claude account, with your conversation as input. That call is covered by the terms and privacy policy of your Claude account, not by this plugin.
- The plugin reads no files and lists no folders. It reads a few environment variables only to decide where to save documents; their values are never put into a prompt.

## Retention and deletion

Handoff documents stay on your disk until you delete them. The plugin never deletes them. To remove everything it stored, delete the handoff folder and uninstall the plugin.

## Contact

Questions or concerns: open an issue at <https://github.com/sampaio-arthur/context-baton/issues>.