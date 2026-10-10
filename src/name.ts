// The plugin's names in one place, each a fixed string. A rename of the plugin is a change here plus "name" in
// .claude-plugin/plugin.json and .claude-plugin/marketplace.json; the command and the tag keep the short name.
export const NAME = 'context-baton'
export const DISPLAY_NAME = 'Context Baton'
export const COMMAND = 'baton'
// Used when another command or skill already holds /baton
export const FALLBACK_COMMAND = 'baton-handoff'
// Prefix of every text this plugin submits into a conversation
export const TAG = '[baton]'
