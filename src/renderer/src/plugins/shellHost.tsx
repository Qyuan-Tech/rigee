/**
 * Where `@rigee/plugin-api` gets its behaviour.
 *
 * The package declares the shape a plugin writes against and holds no implementation, because a
 * plugin from another repository is compiled long before this shell exists. This module is the one
 * place the two are joined: it collects the shell's own functions into a `ShellHost` and installs
 * it, once, before any plugin can activate.
 *
 * MUST BE IMPORTED FOR EFFECT AT BOOT, and must not be lazy. A plugin's very first line may call
 * into the package, and an uninstalled host throws rather than returning something wrong — which
 * is the right failure, but only if it can never happen. `main.tsx` imports it before it renders.
 *
 * It costs nothing to do eagerly: everything below is already in the entry chunk (the store, the
 * icons, the IPC client), so this adds one object literal and no new modules. `perf:check` holds
 * that claim to the entry size.
 */

import * as React from 'react'
import * as ReactDOM from 'react-dom'
import * as jsxRuntime from 'react/jsx-runtime'
import * as jsxDevRuntime from 'react/jsx-dev-runtime'
import * as pluginApi from '@rigee/plugin-api'
import { installShellHost, type ShellHost } from '@rigee/plugin-api'
import { Notice } from '../components/Notice'
import { editorFontSize, monoFamily } from '../fonts'
import * as icons from '../icons'
import { isMac, rpc } from '../ipc'
import { useActiveWorkspace } from '../store'
import * as api from './api'

/**
 * The icon set, renamed.
 *
 * `ChevronIcon` here, `icons.Chevron` there: the suffix is redundant once they are properties of
 * an object called `icons`, and the package's `IconSet` is the contract so it wins. Spelled out
 * rather than derived by stripping "Icon" from every export, so adding one to the shell does not
 * silently become part of the public API.
 */
const iconSet: ShellHost['icons'] = {
  Terminal: icons.TerminalIcon,
  File: icons.FileIcon,
  Files: icons.FilesIcon,
  Diff: icons.DiffIcon,
  Globe: icons.GlobeIcon,
  Folder: icons.FolderIcon,
  AddFolder: icons.AddFolderIcon,
  Plugin: icons.PluginIcon,
  Plus: icons.PlusIcon,
  Close: icons.CloseIcon,
  Gear: icons.GearIcon,
  Split: icons.SplitIcon,
  Branch: icons.BranchIcon,
  Stage: icons.StageIcon,
  Unstage: icons.UnstageIcon,
  Discard: icons.DiscardIcon,
  Back: icons.BackIcon,
  Forward: icons.ForwardIcon,
  Reload: icons.ReloadIcon,
  Stop: icons.StopIcon,
  DevTools: icons.DevToolsIcon,
  ExpandAll: icons.ExpandAllIcon,
  CollapseAll: icons.CollapseAllIcon,
  CollapseLeft: icons.CollapseLeftIcon,
  CollapseRight: icons.CollapseRightIcon,
  Chevron: icons.ChevronIcon
}

const host: ShellHost = {
  isMac,
  monoFamily,
  editorFontSize,

  activeWorkspaceId: api.activeWorkspaceId,
  useActiveWorkspace,
  addWorkspaceFolders: api.addWorkspaceFolders,

  openPluginTab: api.openPluginTab,
  openFile: api.openFile,
  patchPluginTab: api.patchPluginTab,
  closePluginTab: api.closePluginTab,
  pluginTabs: api.pluginTabs,
  liveTabIds: api.liveTabIds,
  subscribeTabs: api.subscribeTabs,
  duplicatedFrom: api.duplicatedFrom,

  focusedTabId: api.focusedTabId,
  useFocusedTabId: api.useFocusedTabId,
  mountedTabIds: api.mountedTabIds,
  subscribeMountedTabs: api.subscribeMountedTabs,

  pluginState: api.pluginState,
  usePluginState: api.usePluginState,
  setPluginState: api.setPluginState,

  // The three file operations a plugin may perform, named rather than handed the whole `rpc`
  // object. That object also carries `terminal:spawn`, `state:saveWorkspaces` and every other
  // channel the shell has; a viewer that wanted to read a file used to get all of them.
  readFile: (path) => rpc['fs:readFile'](path),
  writeFile: (path, content) => rpc['fs:writeFile']({ path, content }),
  listDir: (path) => rpc['fs:list'](path),

  icons: iconSet,
  Notice
}

installShellHost(host)

/**
 * The same modules again, under the names a plugin loaded from disk imports them by.
 *
 * A disk plugin's bundle says `import { useState } from 'react'`. That resolves through the import
 * map in index.html to `assets/plugin-runtime/react.js`, a generated file whose whole body is
 * "read this global and re-export it" — see `pluginRuntime()` in electron.vite.config.ts for why
 * it reads a global instead of importing react itself (as an import it shared modules with the
 * shell's entry, Rollup re-cut the chunks, and startup grew three modulepreloads).
 *
 * So these four assignments are what make that indirection land on the SHELL's copies. Two Reacts
 * in one window means hooks throw the moment a plugin renders inside the shell's tree, and two
 * copies of the API package means the second one has no host installed.
 *
 * Eager, and before any plugin can run: the shims throw rather than resolve to undefined if this
 * has not happened, which is the right failure but only worth having if it cannot occur.
 */
declare global {
  // eslint-disable-next-line no-var
  var __rigeePluginRuntime: Record<string, unknown> | undefined
}

globalThis.__rigeePluginRuntime = {
  react: React,
  'react-dom': ReactDOM,
  'react/jsx-runtime': jsxRuntime,
  'react/jsx-dev-runtime': jsxDevRuntime,
  '@rigee/plugin-api': pluginApi
}
