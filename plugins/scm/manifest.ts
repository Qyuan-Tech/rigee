import type { PluginManifest } from '@rigee/plugin-api/manifest'

/**
 * Source control.
 *
 * The largest of the plugins, and the one that proves the contribution points are real: it owns a
 * side-bar panel, a tab type, a status bar item, a filesystem watcher and eleven commands, and
 * the shell contains not one line that knows what a commit is.
 */
export const manifest: PluginManifest = {
  id: 'scm',
  version: '1.0.0',
  displayName: 'Source Control',
  description: 'Git status, staging down to the line, commits, and diffs.',
  contributes: {
    views: [{ id: 'scm.panel', title: 'Source control', slot: 'right', icon: 'branch', order: 0 }],
    tabs: [
      {
        viewType: 'scm.diff',
        displayName: 'Diff',
        icon: 'diff',
        // A diff is a document: "Close Other Files" should sweep it up, the way it always did.
        isDocument: true,
        // Two revisions of one file, side by side, is the reason anybody splits an editor.
        split: 'copy',
        legacyKind: 'diff'
      }
    ],
    statusBar: [{ id: 'scm.branch', align: 'left', order: 10 }]
  },
  l10n: {
    'zh-CN': {
      'Source Control': '源代码管理',
      'Git status, staging down to the line, commits, and diffs.': 'Git 状态、精确到行的暂存、提交和差异。',
      'Source control': '源代码管理',
      Diff: '差异'
    }
  }
}
