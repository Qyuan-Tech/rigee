import type { PluginManifest } from '@shared/plugin'

/**
 * The in-app Chromium browser.
 *
 * Each tab is a native WebContentsView composited over the React shell by the main process, which
 * is why this plugin needs the window itself (`ctx.shell.window()`) rather than only a command
 * channel. The overlay is the HTTP auth prompt: it cannot be needed before a view exists, so
 * mounting it on activation rather than at boot costs the shell nothing.
 */
export const manifest: PluginManifest = {
  id: 'browser',
  version: '1.0.0',
  displayName: 'Browser',
  description: 'Chromium tabs inside the workspace, with a persistent session.',
  contributes: {
    tabs: [
      {
        viewType: 'browser.page',
        displayName: 'Browser',
        icon: 'globe',
        // Not a document: "Close Other Files" must not throw away navigation state, for the same
        // reason it leaves terminals alone.
        isDocument: false,
        // The native WebContentsView is keyed by tab id: a copy would either share the live view
        // or start a second page with none of the session the first one has.
        split: 'move',
        legacyKind: 'browser',
        creatable: { label: 'New browser tab' }
      }
    ],
    overlays: [{ id: 'browser.auth' }]
  }
}
