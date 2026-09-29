import { app, Menu, type MenuItemConstructorOptions } from 'electron'

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
 */
export function installMenu(): void {
  const mac = process.platform === 'darwin'
  const dev = !app.isPackaged

  const view: MenuItemConstructorOptions[] = [
    ...(dev ? ([{ role: 'reload' }, { role: 'forceReload' }] as MenuItemConstructorOptions[]) : []),
    { role: 'toggleDevTools' },
    { type: 'separator' },
    // Page zoom, for everything but terminals: a focused terminal answers these keys itself and
    // resizes its own text, as Ghostty does, so they only reach here from the rest of the window.
    { role: 'resetZoom' },
    { role: 'zoomIn' },
    { role: 'zoomOut' },
    { type: 'separator' },
    { role: 'togglefullscreen' }
  ]

  const template: MenuItemConstructorOptions[] = [
    ...(mac ? ([{ role: 'appMenu' }] as MenuItemConstructorOptions[]) : []),
    {
      label: 'File',
      submenu: mac
        ? [{ role: 'close', accelerator: 'Shift+Command+W' }]
        : [{ label: 'Quit', click: () => app.quit() }]
    },
    { role: 'editMenu' },
    { label: 'View', submenu: view },
    ...(mac
      ? ([{ role: 'windowMenu' }, { role: 'help', submenu: [] }] as MenuItemConstructorOptions[])
      : ([{ label: 'Window', submenu: [{ role: 'minimize' }] }] as MenuItemConstructorOptions[]))
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
