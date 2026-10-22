import type { Messages } from '@rigee/plugin-api/l10n'

/**
 * Search in Simplified Chinese: each English string its code says, to what it is in Chinese.
 * `pnpm l10n:check` holds it to the code.
 *
 * The options are named as VS Code names them. What ripgrep, git, V8 or the OS says — a pattern
 * that does not compile, a file that cannot be read — is passed on as they say it, and the engines
 * keep their names; only the plugin's own words are here.
 */
const messages: Messages = {
  // The panel
  'Search': '搜索',
  'Collapse panel': '折叠面板',
  'Match case': '区分大小写',
  'Match whole word': '全字匹配',
  'Use regular expression': '使用正则表达式',
  'Open a workspace to search it.': '打开工作区后即可在其中搜索。',
  'This workspace has no folders to search. Add one from the explorer.': '此工作区没有可搜索的文件夹。请从资源管理器添加一个。',
  '{engine}, {ms} ms': '{engine}，用时 {ms} 毫秒',
  'No results': '没有结果',
  // {files} is already words, 3 个文件, and ends in Chinese: nothing goes between it and 中.
  '{results} in {files}': '{files}中有 {results}',
  '{n} results': '{n} 个结果',
  '{n} files': '{n} 个文件',
  ' — the first ones only; narrow the search to see the rest': '，仅显示最先找到的部分；缩小搜索范围可查看其余结果',
  'Searching…': '正在搜索…',

  // Main: the search's own notes, shown where an error would be
  'Stopped after {seconds} s — showing what was found by then': '{seconds} 秒后已停止，显示的是此前找到的结果',
  'ripgrep is not installed': '未安装 ripgrep',
  'cannot read {dir}': '无法读取 {dir}',
  '{dir} is not a git repository': '{dir} 不是 Git 仓库'
}

export default messages
