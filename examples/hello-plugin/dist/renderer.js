/**
 * The renderer half, as a plugin from outside the app ships it: plain ESM, already built.
 *
 * WHAT THIS FILE IS DEMONSTRATING is the three bare specifiers. `react`, `react/jsx-runtime` and
 * `@rigee/plugin-api` are left EXTERNAL by a plugin's build and resolved at runtime through the
 * import map in Rigee's index.html, to the shell's own copies. Bundling them instead is the
 * failure worth knowing about: two Reacts in one window makes hooks throw the moment this panel
 * renders inside the shell's tree, and a second copy of @rigee/plugin-api has no host installed,
 * so every call from it throws instead.
 *
 * Written by hand rather than compiled from JSX so the example has no build step — `jsx()` is what
 * a JSX compiler emits anyway.
 */
import { useCallback, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'
import { icons, openFile, useActiveWorkspace } from '@rigee/plugin-api'

function HelloPanel({ onCollapse }) {
  const workspace = useActiveWorkspace()
  const [pong, setPong] = useState(null)

  const ping = useCallback(async () => {
    // The plugin's own main half, over the shell's single plugin channel. A plugin may only call
    // commands prefixed with its own id; `scm:status` from here is a local throw naming both.
    const reply = await window.rigee.invoke('plugin:invoke', {
      command: 'hello:ping',
      payload: { from: 'hello.panel' }
    })
    setPong(reply)
  }, [])

  return jsxs('div', {
    style: { padding: 12, display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 },
    children: [
      jsxs('div', {
        className: 'section-header',
        children: [
          jsx('span', { className: 'section-header__title', children: 'Hello' }),
          jsx('button', {
            className: 'icon-button',
            title: 'Collapse panel',
            onClick: onCollapse,
            // The shell's own icon set, so this looks like the rest of the app rather than like
            // somebody else's panel wearing different chevrons.
            children: jsx(icons.CollapseLeft, { size: 14 })
          })
        ]
      }),
      jsx('div', {
        className: 'muted',
        id: 'hello-workspace',
        children: workspace ? `workspace: ${workspace.name}` : 'no workspace'
      }),
      jsx('button', { id: 'hello-ping', onClick: () => void ping(), children: 'Ping main half' }),
      pong &&
        jsx('div', {
          id: 'hello-pong',
          className: 'muted',
          children: `pong from node ${pong.node}`
        }),
      jsx('button', {
        id: 'hello-open',
        onClick: () => { openFile({ path: '/etc/hosts', title: 'hosts' }) },
        children: 'Open a file'
      })
    ]
  })
}

export default {
  name: 'hello',
  inject: ['contributions'],
  apply(ctx) {
    // The id must match one this plugin's manifest declares, and must carry its own prefix. Both
    // are checked here rather than left to fail as a panel that never opens.
    ctx.contributions.view('hello.panel', HelloPanel)
  }
}
