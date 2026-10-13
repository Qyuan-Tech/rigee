import type { PluginManifest } from '@rigee/plugin-api/manifest'

/** The preview's view type, which its renderer half also opens linked Markdown files in. */
export const PREVIEW_VIEW = 'markdown.preview'

/** What counts as Markdown: the extensions VS Code gives the language, lower-case, no dot. */
export const MARKDOWN_EXTENSIONS = ['md', 'markdown', 'mdown', 'markdn', 'mkd', 'mkdn', 'mdwn', 'mdtxt', 'mdtext']

/**
 * The Markdown preview.
 *
 * Offered, never chosen. A Markdown file is source, and clicking one has to go on opening it in the
 * text editor to be written; the preview is the second way of looking at it, and it is asked for —
 * Open Preview, in the file's menu. Hence `onRequest`: the shell never picks this editor by itself.
 *
 * Two halves. The renderer reads the file through the shell and draws it; main watches it, so a
 * file an agent rewrites in the terminal next door is shown again the moment it is saved, and reads
 * the pictures a document shows, which the renderer cannot reach.
 *
 * `net` is for exactly one thing: pictures on the web, fetched only when the user presses the button
 * that asks for them. Until then a remote picture is a placeholder and nothing leaves the machine.
 */
export const manifest: PluginManifest = {
  id: 'markdown',
  version: '1.0.0',
  displayName: 'Markdown Preview',
  description: 'Read a Markdown file the way it renders — GitHub-flavoured, and kept current as it changes on disk.',
  permissions: ['files:read', 'net'],
  contributes: {
    editors: [
      {
        viewType: PREVIEW_VIEW,
        displayName: 'Markdown Preview',
        icon: 'preview',
        selector: { extensions: MARKDOWN_EXTENSIONS },
        onRequest: { label: 'Open Preview', tabPrefix: 'Preview' }
      }
    ]
  }
}
