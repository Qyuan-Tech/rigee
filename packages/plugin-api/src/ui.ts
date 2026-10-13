/**
 * What the shell hands a plugin's components, and what it expects back.
 *
 * Types only — there is no React value import here, and there must not be. This module is read by
 * the main process too (a manifest is validated in both realms), and pulling React into main would
 * cost every launch several milliseconds to load a library it can never render with.
 *
 * These used to live in the shell's `plugins/bindings.ts`, which is also where they are still
 * implemented. The split is deliberate: the SHAPE is public and versioned with this package, the
 * Maps that hold the components are private to the shell and may be rewritten at will.
 */

import type { ComponentType, ReactNode } from 'react'

/** What every plugin-contributed editor receives. Kept to the two things a viewer cannot infer. */
export interface PluginEditorProps {
  /** Absolute path of the file to show. */
  filePath: string
  /** The tab this instance belongs to; the right key for any per-tab state a viewer keeps. */
  tabId: string
  readOnly: boolean
}

/** What a plugin-owned tab receives: its own persisted state, and the way to change it. */
export interface PluginTabProps {
  tabId: string
  state: Record<string, unknown>
  /** Merged into the tab's state and persisted with it. */
  patchState: (patch: Record<string, unknown>) => void
  /**
   * Rename the tab in the strip, and optionally give it a hover tooltip.
   *
   * The tooltip is a second argument rather than a second function because the two always change
   * together: a page navigates and both its title and its URL are new.
   */
  setTitle: (title: string, tooltip?: string) => void
}

/** What a side-bar panel receives. The shell owns the rail and the collapse affordance. */
export interface PluginViewProps {
  onCollapse: () => void
}

export type PluginEditorComponent = ComponentType<PluginEditorProps>
export type PluginTabComponent = ComponentType<PluginTabProps>
export type PluginViewComponent = ComponentType<PluginViewProps>
/**
 * No props at all. `Record<never, never>` rather than `Record<string, never>`: the latter carries
 * an index signature, and React's JSX check then rejects the `key` the shell has to put on every
 * item it maps over.
 */
export type PluginStatusItemComponent = ComponentType<Record<never, never>>
export type PluginOverlayComponent = ComponentType<Record<never, never>>

/** What a plugin returns when the shell asks it for a fresh tab of its own type. */
export type PluginTabFactory = () => {
  title: string
  state: Record<string, unknown>
  key?: string
}

/** Props every icon in `icons` accepts. */
export interface IconProps {
  size?: number
  className?: string
}

/**
 * The shell's icon set, so a plugin draws the same chevron the file tree does.
 *
 * An object of components rather than one `<Icon name="…">`, because the file tree renders one per
 * row and an extra component layer per row is a real cost in a 5,000-entry directory. The object
 * is filled in when the shell installs its host (see `host.ts`), so a property read at render time
 * is all it costs.
 */
export interface IconSet {
  Terminal: ComponentType<IconProps>
  File: ComponentType<IconProps>
  Files: ComponentType<IconProps>
  Diff: ComponentType<IconProps>
  Globe: ComponentType<IconProps>
  Folder: ComponentType<IconProps>
  AddFolder: ComponentType<IconProps>
  NewFile: ComponentType<IconProps>
  Plugin: ComponentType<IconProps>
  Plus: ComponentType<IconProps>
  Close: ComponentType<IconProps>
  Gear: ComponentType<IconProps>
  Split: ComponentType<IconProps>
  Branch: ComponentType<IconProps>
  Stage: ComponentType<IconProps>
  Unstage: ComponentType<IconProps>
  Discard: ComponentType<IconProps>
  Back: ComponentType<IconProps>
  Forward: ComponentType<IconProps>
  Reload: ComponentType<IconProps>
  Stop: ComponentType<IconProps>
  DevTools: ComponentType<IconProps>
  ExpandAll: ComponentType<IconProps>
  CollapseAll: ComponentType<IconProps>
  CollapseLeft: ComponentType<IconProps>
  CollapseRight: ComponentType<IconProps>
  Search: ComponentType<IconProps>
  Image: ComponentType<IconProps>
  Video: ComponentType<IconProps>
  /** The one icon with a state: `open` rotates it. */
  Chevron: ComponentType<IconProps & { open?: boolean }>
}

export interface NoticeProps {
  children: ReactNode
  tone?: 'muted' | 'error'
}
