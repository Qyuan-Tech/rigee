import { useCallback, useRef, useState } from 'react'

interface Props {
  orientation: 'vertical' | 'horizontal'
  /**
   * Current size of the pane being resized; captured at drag start. Or how to measure it then, for
   * a pane whose size is its content's rather than a number anybody holds.
   */
  value: number | (() => number)
  onDrag: (delta: number, startValue: number) => void
}

/**
 * A 1px divider with a 9px hit area that lights up in the accent while dragging. Pointer capture
 * keeps the drag alive when the cursor outruns the element, which it always does.
 */
export function Splitter({ orientation, value, onDrag }: Props): React.ReactElement {
  const start = useRef({ pos: 0, value: 0 })
  const [dragging, setDragging] = useState(false)
  const vertical = orientation === 'vertical'

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId)
      start.current = { pos: vertical ? e.clientX : e.clientY, value: typeof value === 'function' ? value() : value }
      setDragging(true)
    },
    [value, vertical]
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
      const delta = (vertical ? e.clientX : e.clientY) - start.current.pos
      onDrag(delta, start.current.value)
    },
    [onDrag, vertical]
  )

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.releasePointerCapture(e.pointerId)
    setDragging(false)
  }, [])

  return (
    <div
      role="separator"
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      className={`splitter${dragging ? ' splitter--active' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      style={{
        [vertical ? 'width' : 'height']: 1,
        [vertical ? 'height' : 'width']: '100%',
        cursor: vertical ? 'col-resize' : 'row-resize'
      }}
    >
      {/* Widen the grab area without widening the line. */}
      <div
        className="splitter__grab"
        style={{
          [vertical ? 'left' : 'top']: -4,
          [vertical ? 'width' : 'height']: 9,
          [vertical ? 'top' : 'left']: 0,
          [vertical ? 'height' : 'width']: '100%'
        }}
      />
    </div>
  )
}
