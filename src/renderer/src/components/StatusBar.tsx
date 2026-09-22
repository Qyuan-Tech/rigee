import { useEffect, useState } from 'react'
import { rpc } from '../ipc'
import { TerminalIcon } from '../icons'
import { useActiveWorkspace } from '../store'
import { PluginStatusItems } from './PluginHost'

/**
 * The status bar.
 *
 * The shell contributes the two things it owns — which workspace you are in, and which shell
 * terminals will run — and leaves the middle to plugins. The branch and dirty count used to be
 * here and are now a `scm.branch` status item, which is why this file no longer reads git state
 * it would have to keep in the store for one line of text.
 */
export function StatusBar(): React.ReactElement {
  const workspace = useActiveWorkspace()
  const [shell, setShell] = useState<string | null>(null)

  useEffect(() => {
    void rpc['app:getPlatformInfo']().then((info) => setShell(info.shell))
  }, [])

  return (
    <div className="statusbar">
      {workspace && <span className="statusbar__item">{workspace.name}</span>}

      <PluginStatusItems align="left" />

      <span className="statusbar__spacer" style={{ marginLeft: 'auto' }} />
      <PluginStatusItems align="right" />

      <span className="statusbar__item">
        <TerminalIcon size={12} />
        <span>{shell ? shell.split('/').pop() : '…'}</span>
      </span>
    </div>
  )
}
