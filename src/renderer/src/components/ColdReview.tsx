import { useState } from 'react'
import { COLD_AFTER, lastActiveAt, longAgo } from '../heat'
import type { Workspace, WorkspaceActivity, WorkspaceId } from '@shared/types'

/**
 * The cold workspaces, each ticked, and a button to remove the ones left ticked: the user's call,
 * one workspace at a time if they like. Nothing is removed without passing through here or a
 * workspace's own remove button.
 */
export function ColdReview({
  workspaces,
  activity,
  now,
  onRemove,
  onCancel
}: {
  workspaces: Workspace[]
  activity: Record<WorkspaceId, WorkspaceActivity>
  now: number
  onRemove: (ids: WorkspaceId[]) => Promise<void>
  onCancel: () => void
}): React.ReactElement {
  const [picked, setPicked] = useState<ReadonlySet<WorkspaceId>>(() => new Set(workspaces.map((w) => w.id)))
  // While removing — it may be waiting on a question about unsaved files — a second press would race it.
  const [busy, setBusy] = useState(false)
  const chosen = workspaces.filter((w) => picked.has(w.id)).map((w) => w.id)
  const toggle = (id: WorkspaceId): void =>
    setPicked((p) => {
      const next = new Set(p)
      if (!next.delete(id)) next.add(id)
      return next
    })

  return (
    <div className="menu menu--inline heat-review" onMouseDown={(e) => e.stopPropagation()}>
      <div className="heat-review__title">Remove cold workspaces</div>
      <div className="heat-review__note">
        Nothing has happened in these in your last {COLD_AFTER} days with Rigee. Removing one closes its
        tabs; its folders, and its workspace file if it has one, stay where they are.
      </div>
      <div className="heat-review__list">
        {workspaces.map((w) => {
          const at = lastActiveAt(activity[w.id])
          return (
            <label key={w.id} className="heat-review__item">
              <input type="checkbox" checked={picked.has(w.id)} onChange={() => toggle(w.id)} />
              <span className="heat-review__name">{w.name}</span>
              <span className="heat-review__when">{at ? longAgo(at, now) : 'never used'}</span>
            </label>
          )
        })}
      </div>
      <div className="heat-review__actions">
        <button className="btn" onClick={onCancel}>Cancel</button>
        <button
          className="btn btn--primary"
          disabled={busy || chosen.length === 0}
          onClick={() => {
            setBusy(true)
            void onRemove(chosen).finally(() => setBusy(false))
          }}
        >
          {chosen.length === 1 ? 'Remove 1 Workspace' : `Remove ${chosen.length} Workspaces`}
        </button>
      </div>
    </div>
  )
}
