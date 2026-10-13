import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import type { ContextMenuItem } from '@shared/ipc'

/**
 * Native context menus, answered with the id of the row picked.
 *
 * Native because the page cannot draw over a browser tab: its page is a WebContentsView composited
 * above the whole document, and a menu in the DOM opened anywhere near one ends up underneath it.
 */

/**
 * How long a closed menu waits for the click that may still be on its way.
 *
 * Picking a row fires both the row's click and the menu's close callback, and the platforms do not
 * agree on the order — on macOS and Windows the close can arrive first. So a close settles nothing
 * until a click has had its chance. Only a dismissal ever waits this out, and a dismissal does
 * nothing either way.
 */
const CLICK_GRACE_MS = 100

/** Menus on screen, held so none can be collected while it is still open. */
const showing = new Set<Menu>()

export function popupContextMenu(window: BrowserWindow, items: readonly ContextMenuItem[]): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false
    const settle = (id: string | null): void => {
      if (settled) return
      settled = true
      resolve(id)
    }
    const menu = Menu.buildFromTemplate(
      items.map(
        (item): MenuItemConstructorOptions =>
          item.kind === 'separator'
            ? { type: 'separator' }
            : {
                label: item.label,
                enabled: item.enabled !== false,
                // Drawn, never registered: whoever asked for the menu answers the key itself, and a
                // registered accelerator would act on it a second time.
                ...(item.accelerator ? { accelerator: item.accelerator, registerAccelerator: false } : {}),
                click: () => settle(item.id)
              }
      )
    )
    showing.add(menu)
    menu.popup({
      window,
      callback: () => {
        showing.delete(menu)
        setTimeout(() => settle(null), CLICK_GRACE_MS)
      }
    })
  })
}
