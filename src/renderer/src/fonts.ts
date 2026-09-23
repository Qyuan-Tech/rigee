import { platform } from './ipc'

/**
 * VS Code's own font stacks, so rigee's chrome, editor and terminal read as the same product
 * the user already has open on the other monitor.
 *
 * These must be concrete font lists, not `var(--font-mono)`. Monaco and xterm.js both measure
 * glyph geometry in JavaScript to lay out a character grid; handed a CSS custom property they
 * measure the fallback and every column lands in the wrong place. The CSS variables below exist
 * for the React chrome only, and are set *from* these constants rather than the other way round.
 */

/** VS Code EDITOR_FONT_DEFAULTS.fontFamily */
const MONO: Record<string, string> = {
  darwin: "Menlo, Monaco, 'Courier New', monospace",
  win32: "Consolas, 'Courier New', monospace",
  linux: "'Droid Sans Mono', 'monospace', monospace"
}

/** VS Code DEFAULT_FONT_FAMILY (the workbench chrome) */
const UI: Record<string, string> = {
  darwin: '-apple-system, BlinkMacSystemFont, sans-serif',
  win32: "'Segoe WPC', 'Segoe UI', sans-serif",
  linux: "system-ui, 'Ubuntu', 'Droid Sans', sans-serif"
}

/**
 * Editor and terminal size.
 *
 * A point above VS Code's defaults (12/14/14), deliberately. Those are tuned for an editor you
 * glance at between other windows; this is an app you read a terminal in all day, and 12px Menlo
 * on a Retina panel is small enough that people lean in without noticing they are doing it.
 */
const EDITOR_SIZE: Record<string, number> = { darwin: 14, win32: 15, linux: 15 }

function pick<T>(table: Record<string, T>, fallback: T): T {
  return table[platform()] ?? fallback
}

export const monoFamily = (): string => pick(MONO, MONO.linux!)
export const uiFamily = (): string => pick(UI, UI.linux!)
export const editorFontSize = (): number => pick(EDITOR_SIZE, 14)

/** Workbench chrome size. VS Code uses 13px; one more, for the same reason as EDITOR_SIZE. */
export const UI_FONT_SIZE = 14

/**
 * Publish the resolved stacks as CSS variables for the parts of the UI that are plain DOM.
 * Called once at boot, before React renders, so nothing paints with the wrong metrics first.
 */
export function applyFonts(): void {
  const root = document.documentElement
  root.style.setProperty('--font-ui', uiFamily())
  root.style.setProperty('--font-mono', monoFamily())
  root.style.setProperty('--font-ui-size', `${UI_FONT_SIZE}px`)
  // Lets stylesheets key off the platform the way VS Code's .mac / .windows / .linux classes do.
  root.classList.add(`platform-${platform()}`)
}
