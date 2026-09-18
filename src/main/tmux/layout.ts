import type { TmuxLayoutNode } from '@shared/types'

/**
 * tmux `window_layout` strings.
 *
 * Grammar (layout-custom.c layout_dump / layout_construct), verified on tmux 3.6a:
 *
 *   layout   := checksum "," cell
 *   checksum := exactly 4 lowercase hex digits  (layout_parse does `layout += 5`)
 *   cell     := geom                              -- container, immediately followed by { or [
 *             | geom "," paneid                   -- leaf
 *             | geom "{" cell ("," cell)+ "}"     -- children side by side (left/right)
 *             | geom "[" cell ("," cell)+ "]"     -- children stacked   (top/bottom)
 *   geom     := sx "x" sy "," xoff "," yoff
 *   paneid   := decimal pane id, WITHOUT the '%' sigil
 *
 * The discriminator after the geometry's four numbers is the next character: ',' introduces a
 * pane id (leaf), '{' or '[' introduces a container.
 *
 * Example from a real 4-pane 200x50 window:
 *   0b87,200x50,0,0{100x50,0,0[100x25,0,0,0,100x24,0,26,3],99x50,101,0[...]}
 */

/** Rotate-right-by-1 then add, over the body after the "xxxx," prefix (layout_checksum). */
export function layoutChecksum(body: string): string {
  let csum = 0
  for (let i = 0; i < body.length; i++) {
    csum = ((csum >>> 1) + ((csum & 1) << 15)) & 0xffff
    csum = (csum + body.charCodeAt(i)) & 0xffff
  }
  return csum.toString(16).padStart(4, '0')
}

/** Prepend the correct checksum to a layout body. Required by `select-layout`. */
export function withChecksum(body: string): string {
  return `${layoutChecksum(body)},${body}`
}

export class LayoutParseError extends Error {}

/**
 * Parse a full layout string (checksum included) into a tree.
 * Throws LayoutParseError on anything malformed rather than returning a partial tree.
 */
export function parseLayout(layout: string): TmuxLayoutNode {
  // layout_parse does sscanf("%hx,") then skips exactly 5 characters.
  if (layout.length < 6 || layout[4] !== ',') {
    throw new LayoutParseError(`missing 4-hex-digit checksum prefix: ${layout.slice(0, 16)}`)
  }
  const p = new Cursor(layout, 5)
  const node = parseCell(p)
  if (!p.atEnd()) throw new LayoutParseError(`trailing junk at ${p.pos}: ${layout.slice(p.pos, p.pos + 16)}`)
  return node
}

class Cursor {
  constructor(readonly s: string, public pos: number) {}
  peek(): string { return this.s[this.pos] ?? '' }
  take(): string { return this.s[this.pos++] ?? '' }
  atEnd(): boolean { return this.pos >= this.s.length }
  expect(ch: string): void {
    if (this.take() !== ch) throw new LayoutParseError(`expected '${ch}' at ${this.pos - 1}`)
  }
  number(): number {
    const start = this.pos
    while (this.pos < this.s.length && this.s[this.pos]! >= '0' && this.s[this.pos]! <= '9') this.pos++
    if (this.pos === start) throw new LayoutParseError(`expected digits at ${start}`)
    return Number(this.s.slice(start, this.pos))
  }
}

function parseCell(p: Cursor): TmuxLayoutNode {
  const width = p.number()
  p.expect('x')
  const height = p.number()
  p.expect(',')
  const x = p.number()
  p.expect(',')
  const y = p.number()

  const next = p.peek()

  if (next === '{' || next === '[') {
    const direction = next === '{' ? 'horizontal' : 'vertical'
    const close = next === '{' ? '}' : ']'
    p.take()
    const children: TmuxLayoutNode[] = [parseCell(p)]
    while (p.peek() === ',') {
      p.take()
      children.push(parseCell(p))
    }
    p.expect(close)
    return { kind: 'split', direction, x, y, width, height, children }
  }

  if (next === ',') {
    p.take()
    const paneNumber = p.number()
    return { kind: 'pane', paneId: `%${paneNumber}`, x, y, width, height }
  }

  throw new LayoutParseError(`expected ',', '{' or '[' after geometry at ${p.pos}`)
}

/** Every pane id in the tree, in layout order. */
export function panesInLayout(node: TmuxLayoutNode, out: string[] = []): string[] {
  if (node.kind === 'pane') out.push(node.paneId)
  else for (const c of node.children) panesInLayout(c, out)
  return out
}

/**
 * Diff two layouts to find added and removed panes.
 *
 * This is the only way to learn that panes appeared or disappeared: tmux has no %pane-add or
 * %pane-close notification. `%layout-change` is the sole signal, and it carries the whole tree.
 */
export function diffPanes(
  previous: TmuxLayoutNode | null,
  next: TmuxLayoutNode
): { added: string[]; removed: string[] } {
  const before = new Set(previous ? panesInLayout(previous) : [])
  const after = new Set(panesInLayout(next))
  return {
    added: [...after].filter((id) => !before.has(id)),
    removed: [...before].filter((id) => !after.has(id))
  }
}
