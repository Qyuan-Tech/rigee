/**
 * Unified-diff parsing and selective-patch construction, for staging, unstaging and discarding
 * individual hunks or lines.
 *
 * Everything here is "take git's own diff, rewrite it, hand it back to `git apply`". There is no
 * clever three-way merge: the whole trick is deciding, for each change the user did NOT select,
 * which side of it is present in the image the patch will be applied on top of, and turning that
 * side into context.
 */

/** A line inside a hunk body. `text` excludes the leading +/-/space marker. */
export interface DiffLine {
  kind: ' ' | '+' | '-'
  text: string
  /**
   * True when `\ No newline at end of file` followed this line. The marker belongs to the line
   * above it and must be re-emitted after that line whatever kind it ends up as — including when
   * a '-' has been demoted to context.
   */
  noEol: boolean
  /** Stable id used to address a line in a selection. Unique within the parsed diff. */
  id: number
}

export interface DiffHunk {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  /** Whatever git put after the closing `@@`, usually the enclosing function. */
  section: string
  lines: DiffLine[]
}

export interface ParsedDiff {
  /** Header lines worth keeping, in order. */
  header: string[]
  hunks: DiffHunk[]
  /** git printed "Binary files … differ": there are no hunks and the hunk UI must be disabled. */
  binary: boolean
}

/**
 * Header lines that must survive into the rewritten patch. `similarity index` and `rename
 * from/to` are dropped deliberately — we always diff with --no-renames, so a rename arrives as an
 * add/delete pair we can actually apply per line.
 */
const KEPT_HEADER = [
  'diff --git ',
  'old mode ',
  'new mode ',
  'new file mode ',
  'deleted file mode ',
  'index ',
  '--- ',
  '+++ '
]

const NO_EOL = '\\ No newline at end of file'

export function parseUnifiedDiff(text: string): ParsedDiff {
  // Split on '\n' only. A CR is content: splitting on /\r?\n/ silently strips it and the patch
  // then fails to apply to a CRLF file.
  const lines = text.split('\n')
  const out: ParsedDiff = { header: [], hunks: [], binary: false }

  let hunk: DiffHunk | null = null
  let nextId = 0

  for (const raw of lines) {
    if (raw.startsWith('Binary files ') || raw.startsWith('GIT binary patch')) {
      out.binary = true
      return out
    }

    if (raw.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(raw)
      if (!m) continue
      hunk = {
        oldStart: Number(m[1]),
        oldCount: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newCount: m[4] === undefined ? 1 : Number(m[4]),
        section: m[5] ?? '',
        lines: []
      }
      out.hunks.push(hunk)
      continue
    }

    if (hunk === null) {
      if (KEPT_HEADER.some((p) => raw.startsWith(p))) out.header.push(raw)
      continue
    }

    if (raw === NO_EOL) {
      const last = hunk.lines[hunk.lines.length - 1]
      if (last) last.noEol = true
      continue
    }

    const marker = raw[0]
    if (marker === ' ' || marker === '+' || marker === '-') {
      hunk.lines.push({ kind: marker, text: raw.slice(1), noEol: false, id: nextId++ })
      continue
    }
    // An empty string is git's representation of an empty context line at the very end of the
    // diff text; anything else here is not part of a hunk body.
    if (raw === '') continue
    hunk = null
    if (KEPT_HEADER.some((p) => raw.startsWith(p))) out.header.push(raw)
  }

  return out
}

/** Every change (non-context) line id in the diff, in order. */
export function changeLineIds(parsed: ParsedDiff): number[] {
  const ids: number[] = []
  for (const h of parsed.hunks) for (const l of h.lines) if (l.kind !== ' ') ids.push(l.id)
  return ids
}

/**
 * Build a patch containing only the selected changes.
 *
 * `reverse` describes how the patch will be applied, and it flips which side of an *unselected*
 * change has to become context:
 *
 *   forward (`git apply --cached`)   applying onto the index: the index still has the '-' side,
 *                                    so an unselected '-' becomes context and an unselected '+'
 *                                    is dropped.
 *   reverse (`--cached --reverse`,   applying onto the newer side: an unselected '+' becomes
 *            or `--reverse`)         context and an unselected '-' is dropped.
 *
 * Returns null when no hunk survives, i.e. there is nothing to do.
 */
export function buildSelectionPatch(
  parsed: ParsedDiff,
  selected: ReadonlySet<number>,
  reverse: boolean
): string | null {
  if (parsed.binary) return null

  const out: string[] = [...parsed.header]
  let anyHunk = false

  for (const hunk of parsed.hunks) {
    const body: string[] = []
    let oldCount = 0
    let newCount = 0
    let selectedHere = 0

    for (const line of hunk.lines) {
      const isSelected = line.kind !== ' ' && selected.has(line.id)
      let emitted: string | null

      if (line.kind === ' ') {
        emitted = ` ${line.text}`
        oldCount++
        newCount++
      } else if (isSelected) {
        selectedHere++
        emitted = `${line.kind}${line.text}`
        if (line.kind === '-') oldCount++
        else newCount++
      } else if ((reverse && line.kind === '-') || (!reverse && line.kind === '+')) {
        // This side is absent from the image we apply onto; drop it entirely.
        emitted = null
      } else {
        // Present in that image, so it has to be carried through as context.
        emitted = ` ${line.text}`
        oldCount++
        newCount++
      }

      if (emitted === null) continue
      body.push(emitted)
      // The marker follows whatever the line became, including a demoted '-'.
      if (line.noEol) body.push(NO_EOL)
    }

    if (selectedHere === 0) continue
    anyHunk = true
    // Starts are copied unchanged; only the counts are recomputed here. `git apply --recount`
    // fixes the starts, which go wrong once an earlier hunk is only partly selected.
    out.push(`@@ -${hunk.oldStart},${oldCount} +${hunk.newStart},${newCount} @@${hunk.section}`)
    out.push(...body)
  }

  if (!anyHunk) return null
  return `${out.join('\n')}\n`
}
