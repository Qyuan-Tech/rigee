import { app, Menu, type MenuItemConstructorOptions } from 'electron'
import { t } from '@shared/l10n'

/**
 * The application menu, stated outright instead of left to Electron's default.
 *
 * The default was a hazard, not a convenience. Its accelerators act on every key the page does
 * not cancel, and a terminal passes most keys on: Cmd+W closed the whole WINDOW — every shell and
 * every Claude Code session in it — from anywhere the keymap did not happen to claim the chord,
 * the shortcuts dialog and the terminal's find bar included, and on Windows and Linux that was
 * the last window and so the app. Cmd+R reloaded the renderer out from under a running terminal.
 * Cmd+V is the same mechanism, and it is why paste used to happen twice.
 *
 * So, deliberately:
 * - Edit keeps every standard role. Text fields, Monaco and browser pages get their copy, paste
 *   and undo from these on macOS; without them Cmd+V would stop working everywhere but terminals.
 * - Close Window moves to Shift+Cmd+W, Ghostty's `close_window`. Plain Cmd+W belongs to the
 *   keymap — pane, then tab — and never to the window. Off macOS it is not in the menu at all:
 *   Ctrl+W is the shell's delete-word, and the window has its close button and Alt+F4 (which the
 *   terminal deliberately leaves alone for exactly this; see TerminalPane).
 * - Quit off macOS has no key at all. A terminal does not cancel Ctrl+Shift+<letter>, so any
 *   accelerator there would be one slip from Ctrl+Shift+W away from killing every shell at once.
 * - Reload exists only in development, where it is how you pick up a renderer change.
 * - Window and Help keep their roles on macOS: the role is what makes AppKit add the window list,
 *   the tiling items that fn+Ctrl+arrow drive, and the menu search field.
 *
 * Every item is named here, in the language Rigee is in, rather than left to its role's label —
 * Electron's are English whatever the language — and the submenus the roles would fill in are
 * spelled out for the same reason, item for item as Electron 44 has them. Installed again when the
 * language changes. What AppKit adds by itself — Start Dictation, the tiling items — is in the
 * system's language, as it is in every other app.
 */
export function installMenu(): void {
  const mac = process.platform === 'darwin'
  const dev = !app.isPackaged
  const name = app.name

  const view: MenuItemConstructorOptions[] = [
    ...(dev
      ? ([
          { role: 'reload', label: t('Reload') },
          { role: 'forceReload', label: t('Force Reload') }
        ] as MenuItemConstructorOptions[])
      : []),
    { role: 'toggleDevTools', label: t('Toggle Developer Tools') },
    { type: 'separator' },
    // Page zoom, for everything but terminals: a focused terminal answers these keys itself and
    // resizes its own text, as Ghostty does, so they only reach here from the rest of the window.
    { role: 'resetZoom', label: t('Actual Size') },
    { role: 'zoomIn', label: t('Zoom In') },
    { role: 'zoomOut', label: t('Zoom Out') },
    { type: 'separator' },
    { role: 'togglefullscreen', label: t('Toggle Full Screen') }
  ]

  const edit: MenuItemConstructorOptions[] = [
    { role: 'undo', label: t('Undo') },
    { role: 'redo', label: t('Redo') },
    { type: 'separator' },
    { role: 'cut', label: t('Cut') },
    { role: 'copy', label: t('Copy') },
    { role: 'paste', label: t('Paste') },
    ...(mac
      ? ([
          { role: 'pasteAndMatchStyle', label: t('Paste and Match Style') },
          { role: 'delete', label: t('Delete') },
          { role: 'selectAll', label: t('Select All') },
          { type: 'separator' },
          {
            label: t('Substitutions'),
            submenu: [
              { role: 'showSubstitutions', label: t('Show Substitutions') },
              { type: 'separator' },
              { role: 'toggleSmartQuotes', label: t('Smart Quotes') },
              { role: 'toggleSmartDashes', label: t('Smart Dashes') },
              { role: 'toggleTextReplacement', label: t('Text Replacement') }
            ]
          },
          {
            label: t('Speech'),
            submenu: [
              { role: 'startSpeaking', label: t('Start Speaking') },
              { role: 'stopSpeaking', label: t('Stop Speaking') }
            ]
          }
        ] as MenuItemConstructorOptions[])
      : ([
          { role: 'delete', label: t('Delete') },
          { type: 'separator' },
          { role: 'selectAll', label: t('Select All') }
        ] as MenuItemConstructorOptions[]))
  ]

  const template: MenuItemConstructorOptions[] = [
    ...(mac
      ? ([
          {
            role: 'appMenu',
            submenu: [
              { role: 'about', label: t('About {name}', { name }) },
              { type: 'separator' },
              { role: 'services', label: t('Services') },
              { type: 'separator' },
              { role: 'hide', label: t('Hide {name}', { name }) },
              { role: 'hideOthers', label: t('Hide Others') },
              { role: 'unhide', label: t('Show All') },
              { type: 'separator' },
              { role: 'quit', label: t('Quit {name}', { name }) }
            ]
          }
        ] as MenuItemConstructorOptions[])
      : []),
    {
      label: t('File'),
      submenu: mac
        ? [{ role: 'close', label: t('Close Window'), accelerator: 'Shift+Command+W' }]
        : [{ label: t('Quit'), click: () => app.quit() }]
    },
    { role: 'editMenu', label: t('Edit'), submenu: edit },
    { label: t('View'), submenu: view },
    ...(mac
      ? ([
          {
            role: 'windowMenu',
            label: t('Window'),
            submenu: [
              { role: 'minimize', label: t('Minimize') },
              { role: 'zoom', label: t('Zoom') },
              { type: 'separator' },
              { role: 'front', label: t('Bring All to Front') }
            ]
          },
          { role: 'help', label: t('Help'), submenu: [] }
        ] as MenuItemConstructorOptions[])
      : ([{ label: t('Window'), submenu: [{ role: 'minimize', label: t('Minimize') }] }] as MenuItemConstructorOptions[]))
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
