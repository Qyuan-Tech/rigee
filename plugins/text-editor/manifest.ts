import type { PluginManifest } from '@rigee/plugin-api/manifest'

/**
 * The text editor.
 *
 * It claims every file at the lowest possible priority, which makes it the floor of the editor
 * registry: anything else that matches wins, and a file nothing claims still opens. That is the
 * only reason the shell can be ignorant of Monaco — "open a file" resolves to a view type like
 * any other, and this plugin happens to answer when nobody else does.
 */
export const manifest: PluginManifest = {
  id: 'text-editor',
  version: '1.0.0',
  displayName: 'Text Editor',
  description: 'Monaco-backed text editing, and the fallback viewer for every file.',
  contributes: {
    editors: [
      {
        viewType: 'text-editor.monaco',
        displayName: 'Text Editor',
        icon: 'file',
        selector: { match: () => true },
        priority: -Infinity
      }
    ]
  },
  l10n: {
    'zh-CN': {
      'Text Editor': '文本编辑器',
      'Monaco-backed text editing, and the fallback viewer for every file.': '基于 Monaco 的文本编辑，也是所有文件的后备查看器。'
    }
  }
}
