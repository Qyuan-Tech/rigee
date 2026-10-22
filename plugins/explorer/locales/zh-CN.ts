import type { Messages } from '@rigee/plugin-api/l10n'

/**
 * The explorer in Simplified Chinese: each English string its code says, to what it is in Chinese.
 * `pnpm l10n:check` holds it to the code.
 *
 * Shared by both halves. A sentence that names where deleted files go is here twice over — the
 * Trash, which is the Mac's 废纸篓, and the Recycle Bin, Windows's 回收站 and Linux's (see
 * `recycleBin` in main/files.ts).
 */
const messages: Messages = {
  // The tree
  'Explorer': '资源管理器',
  'New File…': '新建文件…',
  'New Folder…': '新建文件夹…',
  'Refresh': '刷新',
  'Collapse all folders': '折叠所有文件夹',
  'Expand folders': '展开文件夹',
  'Open a workspace to browse files.': '打开工作区以浏览文件。',
  'No folders here. Terminals still work — drop a folder to make a workspace.':
    '这里没有文件夹。终端照常可用，拖入文件夹即可创建工作区。',
  "The folder this workspace's .code-workspace file is in, where new terminals start.":
    '此工作区的 .code-workspace 文件所在的文件夹，新终端从这里启动。',
  'Workspace': '工作区',
  'This folder is no longer there.': '此文件夹已不存在。',
  'The explorer is switched off.': '资源管理器已禁用。',

  // A row's right-click menu
  'Reveal in Finder': '在访达中显示',
  'Reveal in File Explorer': '在文件资源管理器中显示',
  'Open Containing Folder': '打开所在的文件夹',
  'Open in Terminal Tab': '在终端标签页中打开',
  'Open in Terminal Split': '在终端拆分窗格中打开',
  'Remove Folder from Workspace': '从工作区中移除文件夹',
  'Cut': '剪切',
  'Copy': '复制',
  'Paste': '粘贴',
  'Copy Path': '复制路径',
  'Copy Relative Path': '复制相对路径',
  'Rename…': '重命名…',
  'Delete': '删除',

  // The name box, and what it refuses
  'Rename {name}': '重命名 {name}',
  'New folder name': '新文件夹名',
  'New file name': '新文件名',
  'A file or folder name must be provided.': '必须提供文件或文件夹名称。',
  'A name cannot contain a NUL character.': '名称不能包含 NUL 字符。',
  'A name cannot contain a slash.': '名称不能包含斜杠。',
  'A name cannot start or end with a slash, or have two in a row.': '名称不能以斜杠开头或结尾，也不能包含连续的两个斜杠。',
  '“{name}” is not a valid file or folder name.': '“{name}”不是有效的文件或文件夹名称。',
  'A name cannot contain any of < > : " | ? *': '名称不能包含以下任何字符：< > : " | ? *',
  '“{name}” already exists here. Choose a different name.': '此处已存在“{name}”。请选择其他名称。',
  '“{name}” already exists here.': '此处已存在“{name}”。',
  'The name starts or ends with a space.': '名称以空格开头或结尾。',
  'It has unsaved changes. Save or undo them first.': '此文件有未保存的更改。请先保存或撤销。',
  '“{name}” in it has unsaved changes. Save or undo them first.': '其中的“{name}”有未保存的更改。请先保存或撤销。',

  // Copying and moving
  '“{name}” has unsaved changes.': '“{name}”有未保存的更改。',
  '{n} files have unsaved changes.': '{n} 个文件有未保存的更改。',
  'Save or undo the changes first, and then move it.': '请先保存或撤销更改，然后再移动它。',
  'Save or undo the changes first, and then move them.': '请先保存或撤销更改，然后再移动它们。',
  'Add “{name}” to the workspace, or copy it into “{folder}”?': '要将“{name}”添加到工作区，还是复制到“{folder}”中？',
  'Add these {n} folders to the workspace, or copy them into “{folder}”?':
    '要将这 {n} 个文件夹添加到工作区，还是复制到“{folder}”中？',
  'Add Folder to Workspace': '将文件夹添加到工作区',
  'Add Folders to Workspace': '将文件夹添加到工作区',
  'Copy Folder': '复制文件夹',
  'Copy Folders': '复制文件夹',
  'Cancel': '取消',
  'Cannot copy “{name}” into itself.': '无法将“{name}”复制到其自身中。',
  'Cannot move “{name}” into itself.': '无法将“{name}”移动到其自身中。',
  'Two of these are called “{name}”.': '其中有两项都叫“{name}”。',
  'Only one of them can go into “{folder}”.': '只能将其中一项放入“{folder}”。',
  '“{name}” cannot be replaced by something inside it.': '“{name}”不能被其内部的项替换。',
  '“{name}” already exists in “{folder}”. Replace it?': '“{folder}”中已存在“{name}”。要替换它吗？',
  '{n} of these already exist in “{folder}”. Replace them?': '其中 {n} 项已存在于“{folder}”中。要替换它们吗？',
  'What is replaced goes to the Trash.': '被替换的项会移到废纸篓。',
  'What is replaced goes to the Recycle Bin.': '被替换的项会移到回收站。',
  'Replace': '替换',
  'Could not copy “{name}”.': '无法复制“{name}”。',
  'Could not move “{name}”.': '无法移动“{name}”。',

  // Deleting
  'Are you sure you want to delete “{name}”?': '确定要删除“{name}”吗？',
  'Are you sure you want to delete these {n} items?': '确定要删除这 {n} 项吗？',
  'Are you sure you want to permanently delete “{name}”?': '确定要永久删除“{name}”吗？',
  'Are you sure you want to permanently delete these {n} items?': '确定要永久删除这 {n} 项吗？',
  'You can restore it from the Trash.': '可以从废纸篓中恢复它。',
  'You can restore them from the Trash.': '可以从废纸篓中恢复它们。',
  'You can restore it from the Recycle Bin.': '可以从回收站中恢复它。',
  'You can restore them from the Recycle Bin.': '可以从回收站中恢复它们。',
  'This cannot be undone.': '此操作无法撤销。',
  'Its unsaved changes will be lost.': '其未保存的更改将会丢失。',
  'Unsaved changes to “{name}” will be lost.': '“{name}”中未保存的更改将会丢失。',
  'Unsaved changes to {n} files will be lost.': '{n} 个文件中未保存的更改将会丢失。',
  'Move to Trash': '移到废纸篓',
  'Move to Recycle Bin': '移到回收站',
  '“{name}” could not be moved to the Trash. Delete it permanently instead?': '无法将“{name}”移到废纸篓。要改为永久删除吗？',
  '“{name}” could not be moved to the Recycle Bin. Delete it permanently instead?': '无法将“{name}”移到回收站。要改为永久删除吗？',
  'Delete Permanently': '永久删除',
  'Could not delete “{name}”.': '无法删除“{name}”。',

  // Said in any of the questions above
  '…and {n} more': '…还有 {n} 项',
  'OK': '确定',
  'Permission denied.': '权限不足。',
  'It is no longer there.': '它已不存在。',
  'It is in use by another program.': '另一个程序正在使用它。',
  'The disk is full.': '磁盘已满。',
  'The disk is read-only.': '磁盘是只读的。',
  'The name is too long.': '名称过长。'
}

export default messages
