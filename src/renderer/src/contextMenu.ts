import { rpc } from './ipc'
import type { ContextMenuItem } from '@shared/ipc'

/**
 * Native context menus, for the places a menu drawn in the page would end up under a browser
 * tab's page — a native view composited over the whole document. The tab strip is one: right-
 * clicking a browser tab selects it, which puts its page on screen exactly where the menu opens.
 */

/**
 * Answers menus instead of showing them, for the smoke checks. A native menu cannot be clicked
 * from a script, and a check that opened one would sit waiting for somebody to come and pick a
 * row. Sees everything a menu offered, and says what was picked.
 */
export const menuProbe: { answer: ((items: ContextMenuItem[]) => string | null) | null } = { answer: null }

/** Show a menu at the pointer: the id of the row picked, or null if it was dismissed. */
export function popupMenu(items: ContextMenuItem[]): Promise<string | null> {
  if (menuProbe.answer) return Promise.resolve(menuProbe.answer(items))
  return rpc['menu:popup']({ items })
}
