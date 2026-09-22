/**
 * Inline SVG icons.
 *
 * Inline rather than an icon font or a package: there are a dozen of them, they need to inherit
 * `currentColor` so hover and active states come for free, and shipping a font for this would add
 * a network-less-but-still-parsed asset plus a flash of missing glyphs. Everything is drawn on a
 * 16x16 grid with a 1.5px stroke so the weights match at the sizes the chrome actually uses.
 */

import type { IconName } from '@shared/plugin'

interface Props {
  size?: number
  className?: string
}

function Svg({ size = 16, className, children }: Props & { children: React.ReactNode }): React.ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

export const TerminalIcon = (p: Props): React.ReactElement => (
  <Svg {...p}>
    <path d="M3 4.5 6.5 8 3 11.5" />
    <path d="M8.5 11.5H13" />
  </Svg>
)

export const FileIcon = (p: Props): React.ReactElement => (
  <Svg {...p}>
    <path d="M9 2H4.5A1.5 1.5 0 0 0 3 3.5v9A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V6z" />
    <path d="M9 2v3.5A.5.5 0 0 0 9.5 6H13" />
  </Svg>
)

export const DiffIcon = (p: Props): React.ReactElement => (
  <Svg {...p}>
    <path d="M4 2.5v5M1.5 5h5" />
    <path d="M9.5 11h5" />
    <path d="M3 10.5 5.5 13 3 15.5" opacity="0" />
  </Svg>
)

export const GlobeIcon = (p: Props): React.ReactElement => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="6" />
    <path d="M2 8h12" />
    <path d="M8 2c1.7 1.8 2.6 3.8 2.6 6S9.7 14.2 8 16" transform="translate(0,-1)" />
    <path d="M8 2C6.3 3.8 5.4 5.8 5.4 8S6.3 14.2 8 16" transform="translate(0,-1)" />
  </Svg>
)

export const FolderIcon = (p: Props): React.ReactElement => (
  <Svg {...p}>
    <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.3a1 1 0 0 1 .8.4l.8 1.1h5.1A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" />
  </Svg>
)

export const ChevronIcon = ({ open, ...p }: Props & { open?: boolean }): React.ReactElement => (
  <Svg {...p}>
    <path d={open ? 'M3.5 6 8 10.5 12.5 6' : 'M6 3.5 10.5 8 6 12.5'} />
  </Svg>
)

export const PlusIcon = (p: Props): React.ReactElement => (
  <Svg {...p}>
    <path d="M8 3.5v9M3.5 8h9" />
  </Svg>
)

export const CloseIcon = (p: Props): React.ReactElement => (
  <Svg {...p}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Svg>
)

export const BranchIcon = (p: Props): React.ReactElement => (
  <Svg {...p}>
    <circle cx="4.5" cy="3.5" r="1.75" />
    <circle cx="4.5" cy="12.5" r="1.75" />
    <circle cx="11.5" cy="6" r="1.75" />
    <path d="M4.5 5.25v5.5" />
    <path d="M11.5 7.75c0 2-1.6 2.9-3.4 3.1-1.3.2-2.4.5-3.1 1.1" />
  </Svg>
)

export const StageIcon = (p: Props): React.ReactElement => (
  <Svg {...p}>
    <path d="M8 3.5v9M3.5 8h9" />
  </Svg>
)

export const UnstageIcon = (p: Props): React.ReactElement => (
  <Svg {...p}>
    <path d="M3.5 8h9" />
  </Svg>
)

export const DiscardIcon = (p: Props): React.ReactElement => (
  <Svg {...p}>
    <path d="M13 8a5 5 0 1 1-1.6-3.7" />
    <path d="M13 2.5V5h-2.5" />
  </Svg>
)

export const BackIcon = (p: Props): React.ReactElement => (
  <Svg {...p}>
    <path d="M10 3.5 5.5 8l4.5 4.5" />
  </Svg>
)

export const ForwardIcon = (p: Props): React.ReactElement => (
  <Svg {...p}>
    <path d="M6 3.5 10.5 8 6 12.5" />
  </Svg>
)

export const ReloadIcon = (p: Props): React.ReactElement => (
  <Svg {...p}>
    <path d="M13.5 8a5.5 5.5 0 1 1-1.8-4.1" />
    <path d="M13.5 2v3.2h-3.2" />
  </Svg>
)

export const StopIcon = (p: Props): React.ReactElement => (
  <Svg {...p}>
    <rect x="4.5" y="4.5" width="7" height="7" rx="1.2" />
  </Svg>
)

export const DevToolsIcon = (p: Props): React.ReactElement => (
  <Svg {...p}>
    <path d="M5.5 5 2.5 8l3 3" />
    <path d="M10.5 5l3 3-3 3" />
  </Svg>
)

export const AddFolderIcon = (p: Props): React.ReactElement => (
  <Svg {...p}>
    <path d="M14 9.5V6a1.5 1.5 0 0 0-1.5-1.5H7.4l-.8-1.1a1 1 0 0 0-.8-.4H3.5A1.5 1.5 0 0 0 2 4.5v7A1.5 1.5 0 0 0 3.5 13H8" />
    <path d="M11.5 10v4M9.5 12h4" />
  </Svg>
)

export const GearIcon = (p: Props): React.ReactElement => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="2.2" />
    <path d="M8 1.6v1.7M8 12.7v1.7M14.4 8h-1.7M3.3 8H1.6M12.5 3.5l-1.2 1.2M4.7 11.3l-1.2 1.2M12.5 12.5l-1.2-1.2M4.7 4.7 3.5 3.5" />
  </Svg>
)

/** The mirror of CollapseAllIcon: two chevrons opening away from each other. */
export const ExpandAllIcon = (p: Props): React.ReactElement => (
  <Svg {...p}>
    <path d="M5 4 8 1.5" opacity="0" />
    <path d="M5 5.5 8 2.5l3 3" />
    <path d="M5 10.5 8 13.5l3-3" />
    <path d="M2.5 8h11" opacity="0.5" />
  </Svg>
)

/** Two chevrons folding towards each other, the way VS Code draws "collapse all". */
export const CollapseAllIcon = (p: Props): React.ReactElement => (
  <Svg {...p}>
    <path d="M5 6.5 8 3.5l3 3" />
    <path d="M5 9.5 8 12.5l3-3" />
    <path d="M2.5 8h1M12.5 8h1" opacity="0.5" />
  </Svg>
)

export const CollapseLeftIcon = (p: Props): React.ReactElement => (
  <Svg {...p}>
    <path d="M13 3v10" />
    <path d="M9.5 8H3" />
    <path d="M5.5 5.5 3 8l2.5 2.5" />
  </Svg>
)

export const CollapseRightIcon = (p: Props): React.ReactElement => (
  <Svg {...p}>
    <path d="M3 3v10" />
    <path d="M6.5 8H13" />
    <path d="M10.5 5.5 13 8l-2.5 2.5" />
  </Svg>
)

/**
 * The icons a plugin manifest may ask for, by name.
 *
 * A manifest is plain data read in both processes, so it cannot hold a component; it names one
 * from this table instead. Adding a name here and to `IconName` is what makes it available to
 * plugins — deliberately a small, curated set rather than "any SVG you like", because the chrome
 * only stays coherent while everything in it is drawn on the same grid at the same weight.
 */
export const ICONS: Record<IconName, (p: Props) => React.ReactElement> = {
  file: FileIcon,
  diff: DiffIcon,
  globe: GlobeIcon,
  terminal: TerminalIcon,
  branch: BranchIcon,
  folder: FolderIcon
}
