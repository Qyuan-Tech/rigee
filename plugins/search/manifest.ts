import type { PluginManifest } from '@rigee/plugin-api/manifest'

/**
 * Search: find a keyword in every file of the workspace, VS Code's Cmd+Shift+F.
 *
 * A panel in the activity bar beside the explorer, and a main half that runs the search — through
 * ripgrep when it is installed, `git grep` in a repository when it is not, and a plain walk of
 * the folders when neither is there. The shell knows none of it; the shortcut that opens it is a
 * line in the keymap naming this panel.
 */
export const manifest: PluginManifest = {
  id: 'search',
  version: '1.0.0',
  displayName: 'Search',
  description: 'Find text in every file of the workspace.',
  permissions: ['files:read', 'process:spawn'],
  contributes: {
    views: [{ id: 'search.panel', title: 'Search', slot: 'left', icon: 'search', order: 1 }]
  }
}
