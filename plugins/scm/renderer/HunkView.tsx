import { icons } from '@rigee/plugin-api'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Notice } from '@rigee/plugin-api'
import { useT } from './l10n'
import { scm } from './rpc'
import type { DiffTabState } from './diffTab'
import type { DiffHunkView, SelectionAction } from '../protocol'

/**
 * Selectable unified diff, for staging part of a file.
 *
 * Lines are addressed by the stable id main assigns while parsing the diff, never by line number:
 * the numbers shift as soon as anything is applied, the ids do not, and the patch builder keys
 * off them.
 */
export function HunkView({
  target,
  onApplied
}: {
  target: DiffTabState
  onApplied: () => void
}): React.ReactElement {
  const { t, tn } = useT()
  const [hunks, setHunks] = useState<DiffHunkView[] | null>(null)
  const [binary, setBinary] = useState(false)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const lastClicked = useRef<number | null>(null)

  // Staged rows can only be unstaged; everything else is a candidate for staging.
  const primary: SelectionAction = target.against.kind === 'index-vs-head' ? 'unstage' : 'stage'

  const load = useCallback(async () => {
    try {
      const res = await scm('scm:hunks', {
        repoRoot: target.repoId,
        path: target.filePath,
        action: primary
      })
      setHunks(res.hunks)
      setBinary(res.binary)
      setSelected(new Set())
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [target.repoId, target.filePath, primary])

  useEffect(() => { void load() }, [load])

  const allIds = (hunks ?? []).flatMap((h) => h.lines.filter((l) => l.kind !== ' ').map((l) => l.id))

  const toggle = useCallback(
    (id: number, shift: boolean) => {
      setSelected((prev) => {
        const next = new Set(prev)
        if (shift && lastClicked.current !== null) {
          // Range select across the flattened change-line order, which is what the eye follows.
          const a = allIds.indexOf(lastClicked.current)
          const b = allIds.indexOf(id)
          if (a >= 0 && b >= 0) {
            const [lo, hi] = a < b ? [a, b] : [b, a]
            const turnOn = !prev.has(id)
            for (let i = lo; i <= hi; i++) {
              if (turnOn) next.add(allIds[i]!)
              else next.delete(allIds[i]!)
            }
            return next
          }
        }
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
      lastClicked.current = id
    },
    [allIds]
  )

  const toggleHunk = useCallback((hunk: DiffHunkView) => {
    const ids = hunk.lines.filter((l) => l.kind !== ' ').map((l) => l.id)
    setSelected((prev) => {
      const next = new Set(prev)
      const allOn = ids.every((id) => prev.has(id))
      for (const id of ids) {
        if (allOn) next.delete(id)
        else next.add(id)
      }
      return next
    })
  }, [])

  const apply = useCallback(
    async (action: SelectionAction) => {
      if (selected.size === 0) return
      setBusy(true)
      try {
        await scm('scm:applySelection', {
          repoRoot: target.repoId,
          path: target.filePath,
          lineIds: [...selected],
          action
        })
        setError(null)
        onApplied()
        await load()
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(false)
      }
    },
    [selected, target.repoId, target.filePath, onApplied, load]
  )

  if (binary) return <Notice>{t('Binary file — individual lines cannot be staged.')}</Notice>
  if (error && hunks === null) return <Notice tone="error">{error}</Notice>
  if (hunks === null) return <Notice>{t('reading diff…')}</Notice>
  if (hunks.length === 0) return <Notice>{t('No changes in this file.')}</Notice>

  const count = selected.size

  return (
    <div className="hunks">
      <div className="hunks__bar">
        <span className="hunks__count">
          {count > 0 ? tn(count, '1 line selected', '{n} lines selected') : t('Select lines to stage')}
        </span>
        <button className="btn" disabled={busy || count === 0} onClick={() => setSelected(new Set())}>
          {t('Clear')}
        </button>
        <button
          className="btn"
          disabled={busy || allIds.length === 0}
          onClick={() => setSelected(new Set(allIds))}
        >
          {t('Select all')}
        </button>
        {primary === 'stage' ? (
          <>
            <button className="btn" disabled={busy || count === 0} onClick={() => void apply('discard')}>
              <icons.Discard size={12} /> {t('Discard')}
            </button>
            <button
              className="btn btn--primary"
              disabled={busy || count === 0}
              onClick={() => void apply('stage')}
            >
              <icons.Stage size={12} /> {t('Stage')}
            </button>
          </>
        ) : (
          <button
            className="btn btn--primary"
            disabled={busy || count === 0}
            onClick={() => void apply('unstage')}
          >
            <icons.Unstage size={12} /> {t('Unstage')}
          </button>
        )}
      </div>

      <div className="hunks__body">
        {hunks.map((hunk, hi) => {
          const ids = hunk.lines.filter((l) => l.kind !== ' ').map((l) => l.id)
          const allOn = ids.length > 0 && ids.every((id) => selected.has(id))
          return (
            <div key={hi}>
              <div className="hunk__header" onClick={() => toggleHunk(hunk)} title={t('Toggle this hunk')}>
                <span className="hunk__toggle">{allOn ? '−' : '+'}</span>
                <span>
                  @@ −{hunk.oldStart} +{hunk.newStart} @@
                </span>
                {hunk.section && <span className="hunk__section">{hunk.section.trim()}</span>}
              </div>
              {hunk.lines.map((line) => {
                const change = line.kind !== ' '
                const on = change && selected.has(line.id)
                return (
                  <div
                    key={line.id}
                    className={
                      `hunk__line hunk__line--${line.kind === '+' ? 'add' : line.kind === '-' ? 'del' : 'ctx'}` +
                      (on ? ' hunk__line--on' : '')
                    }
                    onClick={(e) => { if (change) toggle(line.id, e.shiftKey) }}
                    style={{ cursor: change ? 'pointer' : 'default' }}
                  >
                    <span className="hunk__no">{line.oldNo ?? ''}</span>
                    <span className="hunk__no">{line.newNo ?? ''}</span>
                    <span className="hunk__marker">{line.kind}</span>
                    <span className="hunk__text">
                      {line.text || ' '}
                      {line.noEol && <span className="hunk__noeol"> ↵ {t('no newline at end of file')}</span>}
                    </span>
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>

      {error && <div className="error-banner">{error}</div>}
    </div>
  )
}
