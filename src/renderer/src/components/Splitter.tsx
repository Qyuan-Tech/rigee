import { useCallback, useRef } from 'react'

interface Props {
  orientation: 'vertical' | 'horizontal'
  /** Current size of the pane being resized; captured at drag start. */
  value: number
  onDrag: (delta: number, startValue: number) => void
}

/**
 * A 1px visual divider with a 7px hit area. Pointer capture keeps the drag alive when the cursor
 * outruns the element, which it always does.
 */
export function Splitter({ orientation, value, onDrag }: Props): React.ReactElement {
  const start = useRef({ pos: 0, value: 0 })
  const vertical = orientation === 'vertical'

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId)
      start.current = { pos: vertical ? e.clientX : e.clientY, value }
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
  }, [])

  return (
    <div
      role="separator"
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      style={{
        flex: '0 0 auto',
        [vertical ? 'width' : 'height']: 1,
        [vertical ? 'height' : 'width']: '100%',
        background: 'var(--border)',
        cursor: vertical ? 'col-resize' : 'row-resize',
        position: 'relative',
        zIndex: 5
      }}
    >
      {/* Widen the grab area without widening the line. */}
      <div
        style={{
          position: 'absolute',
          [vertical ? 'left' : 'top']: -3,
          [vertical ? 'width' : 'height']: 7,
          [vertical ? 'top' : 'left']: 0,
          [vertical ? 'height' : 'width']: '100%'
        }}
      />
    </div>
  )
}
