import type { PluginManifest } from '@rigee/plugin-api/manifest'

/**
 * The file tree.
 *
 * A plugin rather than shell furniture, which is the distinction the activity bar makes visible:
 * the workspace list above it is the shell's, because a workspace is part of the app's model, and
 * a tree over that workspace's folders is one way of looking at it among several. Nothing in the
 * shell knows this view exists beyond the icon its manifest asks for.
 */
export const manifest: PluginManifest = {
  id: 'explorer',
  version: '1.0.0',
  displayName: 'Explorer',
  description: 'The file tree, and dropping folders onto it to build a workspace.',
  contributes: {
    views: [{ id: 'explorer.files', title: 'Explorer', slot: 'left', icon: 'files', order: 0 }]
  }
}
