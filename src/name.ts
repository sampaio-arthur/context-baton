// The plugin's names in one place. A rename is a change here plus "name" in .claude-plugin/plugin.json.
export const NAME = 'baton'
export const COMMAND = NAME
// Used when another command or skill already holds /baton
export const FALLBACK_COMMAND = `${NAME}-handoff`
// Prefix of every text this plugin submits into a conversation
export const TAG = `[${NAME}]`
