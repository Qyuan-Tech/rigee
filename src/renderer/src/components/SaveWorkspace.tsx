import { useEffect, useRef, useState } from 'react'
import { platform } from '../ipc'
import { useApp } from '../store'
import { reason, saveWorkspaceFile, stopRemindingToSave } from '../workspaces'
import { renameWorkspace, workspaceFileRename } from '../workspaceRename'
import type { Workspace } from '@shared/types'
import { namedWorkspaceFile, workspaceNameProblem } from '@shared/workspaceFiles'

/**
 * "Save Workspace As…" when Settings names a folder for workspace files: only the name is asked,
 * and the path it will be written to is shown as it is typed.
 *
 * Two places show it. The side bar, where the menu it replaces was, rather than a dialog in the
 * middle of the window: the middle may be a browser page, which is a native view drawn over the
 * document and would cover the dialog — nothing is ever drawn over the side bar. And a terminal
 * opened in a workspace not yet saved, which asks inside its own pane; a browser page cannot be
 * there, because the terminal is what is showing.
 */
export function SaveAsForm({
  className,
  popup = false,
  title,
  initialName,
  dir,
  onSave,
  onElsewhere,
  onCancel,
  cancelLabel = 'Cancel',
  children,
  footer
}: {
  /** Where it sits: in the side bar's flow, or as a card. `saveas` is always added. */
  className: string
  /**
   * Put away by a click anywhere else, as the side bar's is — so its own clicks must not reach the
   * window. The terminal's is the pane's content, and a click on it should put away whatever else
   * is open, the way a click anywhere does.
   */
  popup?: boolean
  title: string
  initialName: string
  dir: string
  onSave: (name: string) => Promise<void>
  onElsewhere: (name: string) => Promise<void>
  onCancel: () => void
  cancelLabel?: string
  /** Said between the title and the name. */
  children?: React.ReactNode
  footer?: React.ReactNode
}): React.ReactElement {
  const [name, setName] = useState(initialName)
  // While a save is under way — it may be waiting on "replace it?" — a second press would race it.
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])

  const problem = workspaceNameProblem(name)
  const target = namedWorkspaceFile(dir, name, platform() === 'win32' ? '\\' : '/')
  const run = (action: (name: string) => Promise<void>): void => {
    setBusy(true)
    void action(name).finally(() => setBusy(false))
  }

  return (
    <div className={`saveas ${className}`} onMouseDown={popup ? (e) => e.stopPropagation() : undefined}>
      <div className="saveas__title">{title}</div>
      {children}
      <input
        ref={input}
        value={name}
        spellCheck={false}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          // Enter mid-composition picks a candidate in the input method; it does not save.
          if (e.nativeEvent.isComposing) return
          if (e.key === 'Enter' && !problem && !busy) {
            e.preventDefault()
            run(onSave)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
          }
        }}
      />
      {problem ? (
        <div className="saveas__error">{problem}</div>
      ) : (
        <div className="saveas__path" title={target}>{target}</div>
      )}
      <div className="saveas__actions">
        <button
          className="saveas__elsewhere"
          title="Choose where to save it instead"
          disabled={busy}
          onClick={() => run(onElsewhere)}
        >
          Elsewhere…
        </button>
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={onCancel}>{cancelLabel}</button>
        <button className="btn btn--primary" disabled={!!problem || busy} onClick={() => run(onSave)}>
          Save
        </button>
      </div>
      {footer}
    </div>
  )
}

/**
 * "Rename Workspace…": the new name, and where the workspace's file will be once it is renamed with
 * it — main's answer as the name is typed, so a name already taken is refused before Rename is
 * pressed, and a folder that goes too is there to see. A workspace never saved has no file, and the
 * form says only its name changes. In the side bar where the save form is, for the same reason:
 * nothing is ever drawn over it.
 */
export function RenameForm({ workspace, onDone }: { workspace: Workspace; onDone: () => void }): React.ReactElement {
  const [name, setName] = useState(workspace.name)
  /** Main's refusal of the name as it stands, or of the rename when it was tried. */
  const [refused, setRefused] = useState<string | null>(null)
  const [target, setTarget] = useState(workspace.filePath ?? null)
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])

  const unchanged = name === workspace.name
  const problem = unchanged ? null : workspaceNameProblem(name)

  // Asked a moment after typing stops, and only the answer for the name still in the box counts.
  useEffect(() => {
    if (!workspace.filePath || unchanged || problem) {
      setTarget(workspace.filePath ?? null)
      return
    }
    let current = true
    const timer = setTimeout(() => {
      workspaceFileRename(workspace, name, false).then(
        (moves) => { if (current) setTarget(moves[0]?.to ?? workspace.filePath ?? null) },
        (e: unknown) => { if (current) setRefused(reason(e)) }
      )
    }, 120)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [workspace, name, unchanged, problem])

  const rename = (): void => {
    if (problem || busy) return
    setBusy(true)
    renameWorkspace(workspace.id, name).then(onDone, (e: unknown) => {
      setRefused(reason(e))
      setBusy(false)
    })
  }

  const said = problem ?? refused
  return (
    <div className="saveas menu menu--inline" onMouseDown={(e) => e.stopPropagation()}>
      <div className="saveas__title">Rename “{workspace.name}”</div>
      <input
        ref={input}
        value={name}
        spellCheck={false}
        onChange={(e) => {
          setName(e.target.value)
          setRefused(null)
        }}
        onKeyDown={(e) => {
          // Enter mid-composition picks a candidate in the input method; it does not rename.
          if (e.nativeEvent.isComposing) return
          if (e.key === 'Enter' && !said) {
            e.preventDefault()
            rename()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onDone()
          }
        }}
      />
      {said ? (
        <div className="saveas__error">{said}</div>
      ) : target ? (
        <div className="saveas__path" title={target}>{target}</div>
      ) : (
        <div className="saveas__note">Not saved yet, so there is no workspace file: only its name changes.</div>
      )}
      <div className="saveas__actions">
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={onDone}>Cancel</button>
        <button className="btn btn--primary" disabled={!!said || busy} onClick={rename}>
          Rename
        </button>
      </div>
    </div>
  )
}

/**
 * What a new terminal shows, instead of starting its shell, in a workspace that has never been
 * saved: an offer to save it first, so that the shell can start in the folder the workspace file
 * goes to rather than in whichever of its folders happens to be first.
 *
 * Three answers, and the shell starts after any of them. Save, and it starts in the workspace's
 * folder. Not Now, and it starts where it always did — asked again with the next terminal, which
 * is the point of a reminder. Don't remind me again, and nothing asks again until the General
 * page in Settings says to. The pane decides when the question has gone away; this only answers it.
 */
export function SaveReminder({
  workspace,
  onSkip
}: {
  workspace: Workspace
  /** Not Now: start the shell where an unsaved workspace's terminals start. */
  onSkip: () => void
}): React.ReactElement {
  const dir = useApp((s) => s.settings.workspaceFilesDir)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const primary = useRef<HTMLButtonElement>(null)

  // Without a name to type, the keyboard goes to Save, so Enter saves and Escape skips — as it does
  // from the name field.
  useEffect(() => {
    if (!dir) primary.current?.focus()
  }, [dir])

  const save = async (name: string, location: 'named' | 'pick'): Promise<void> => {
    try {
      // Nothing else to do once it is saved: the workspace has a file, so the pane stops asking and
      // its shell starts in that file's folder.
      if (await saveWorkspaceFile(workspace.id, name, location)) setError(null)
    } catch (e) {
      setError(reason(e))
    }
  }

  const first = workspace.folders[0]?.name ?? workspace.name
  const intro = (
    <div className="saveprompt__intro">
      Once this workspace is saved, its terminals start in the folder it is saved in. Until then they start
      in <b>{first}</b>.
    </div>
  )
  const footer = (
    <>
      {error && <div className="saveas__error">{error}</div>}
      <div className="saveprompt__footer">
        <button
          className="saveas__elsewhere"
          title="Turn it back on in Settings → General"
          onClick={stopRemindingToSave}
        >
          Don’t remind me again
        </button>
      </div>
    </>
  )

  if (dir) {
    return (
      <SaveAsForm
        className="saveprompt"
        title="Save this workspace?"
        initialName={workspace.name}
        dir={dir}
        cancelLabel="Not Now"
        onSave={(name) => save(name, 'named')}
        onElsewhere={(name) => save(name, 'pick')}
        onCancel={onSkip}
        footer={footer}
      >
        {intro}
      </SaveAsForm>
    )
  }

  return (
    <div
      className="saveas saveprompt"
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || e.nativeEvent.isComposing) return
        e.preventDefault()
        onSkip()
      }}
    >
      <div className="saveas__title">Save this workspace?</div>
      {intro}
      <div className="saveas__actions">
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={onSkip}>Not Now</button>
        <button
          ref={primary}
          className="btn btn--primary"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            void save(workspace.name, 'pick').finally(() => setBusy(false))
          }}
        >
          Save As…
        </button>
      </div>
      {footer}
    </div>
  )
}
