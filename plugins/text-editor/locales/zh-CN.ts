import type { Messages } from '@rigee/plugin-api/l10n'

/**
 * The text editor in Simplified Chinese: each English string its code says, to what it is in
 * Chinese. `pnpm l10n:check` holds it to the code.
 *
 * Only the plugin's own words. Monaco's — its find widget, its context menu — come from Monaco's
 * language packs, and the reason a save failed, when the OS gives one, is shown as the OS put it.
 */
const messages: Messages = {
  // The editor
  'Save': '保存',
  'File is too large to open in the editor.': '文件太大，无法在编辑器中打开。',
  'This file is not UTF-8, so it is shown read-only — saving would replace every character it could not decode.':
    '此文件不是 UTF-8 编码，因此以只读方式显示：保存会把所有无法解码的字符替换掉。',
  'Not saved: {reason}': '未保存：{reason}',

  // Saving, and why it did not happen
  '{name} is not UTF-8, so it is read-only here': '{name} 不是 UTF-8 编码，因此在这里是只读的',
  'could not check {name} before saving: {message}': '保存前无法检查 {name}：{message}',
  '{name} has been deleted or moved on disk since it was opened here.\n\nSave it again anyway?':
    '{name} 在这里打开后，已在磁盘上被删除或移动。\n\n仍要重新保存吗？',
  '{name} was deleted on disk; not saved': '{name} 已在磁盘上被删除，未保存',
  '{name} has changed on disk since it was opened here — another program, or an agent in a terminal, wrote to it.\n\nOverwrite it with the version in the editor? Cancel keeps the file on disk as it is.':
    '{name} 在这里打开后，已在磁盘上被更改：其他程序或终端中的智能体写入了它。\n\n要用编辑器中的版本覆盖它吗？如果取消，磁盘上的文件将保持原样。',
  '{name} changed on disk; not overwritten': '{name} 已在磁盘上被更改，未覆盖'
}

export default messages
