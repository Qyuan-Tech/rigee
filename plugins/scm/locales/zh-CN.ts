import type { Messages } from '@rigee/plugin-api/l10n'

/**
 * Source control in Simplified Chinese: each English string its code says, to what it is in
 * Chinese. `pnpm l10n:check` holds it to the code.
 *
 * Git's verbs are VS Code's — 暂存, 取消暂存, 放弃, 储藏 — and HEAD, a branch name and a commit id
 * are left as git writes them. Only the plugin's own words are here: what git itself says, on
 * stderr, is passed on to the panel as it is.
 */
const messages: Messages = {
  // The panel
  'No workspace open.': '没有打开的工作区。',
  'No git repository in this workspace.': '此工作区中没有 Git 仓库。',
  'reading {name}…': '正在读取 {name}…',
  'detached @ {commit}': '分离于 {commit}',
  'stash {n}': '储藏 {n}',
  'Message ({key}+Enter to commit)': '消息（按 {key}+Enter 提交）',
  'Commit': '提交',
  'Commit {n}': '提交 {n}',
  'Amend the last commit': '修正上次提交',
  'Amend': '修正',
  'Stage everything': '暂存所有更改',
  'Stage all': '全部暂存',
  'Working tree clean.': '工作树是干净的。',
  'Merge changes': '合并更改',
  'Staged': '已暂存',
  'Changes': '更改',
  // Also what an untracked file's badge says in the explorer.
  'Untracked': '未跟踪',
  'Discard changes': '放弃更改',
  'Unstage': '取消暂存',
  'Stage': '暂存',
  'Source control': '源代码管理',
  'Collapse panel': '折叠面板',

  // A diff tab
  'This diff tab is missing the file it pointed at.': '此差异标签页丢失了它所指向的文件。',
  'Hunks': '按块',
  'Side by side': '并排',
  'Binary file — no text diff available.': '二进制文件，没有可显示的文本差异。',
  'File is too large to diff.': '文件太大，无法显示差异。',
  'Binary file — individual lines cannot be staged.': '二进制文件，无法逐行暂存。',
  'reading diff…': '正在读取差异…',
  'No changes in this file.': '此文件没有更改。',
  '{n} lines selected': '已选择 {n} 行',
  'Select lines to stage': '选择要暂存的行',
  'Clear': '清除',
  'Select all': '全选',
  'Discard': '放弃',
  'Toggle this hunk': '选择或取消选择此块',
  'no newline at end of file': '文件末尾没有换行符',

  // The explorer's badges, on hover
  'Conflicted': '有冲突',
  'Modified': '已修改',
  'Type changed': '类型已更改',
  'Deleted': '已删除',
  'Added': '已添加',
  'Renamed': '已重命名',
  'Copied': '已复制',

  // Main: what the service says itself, after git's own message or instead of one
  'cannot stage part of a binary file': '无法暂存二进制文件的一部分',
  'The file changed on disk. Refresh and try again.': '文件在磁盘上已被更改。请刷新后重试。'
}

export default messages
