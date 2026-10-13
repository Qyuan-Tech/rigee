/**
 * The startup budget, asserted against a real build.
 *
 *   pnpm perf:check      (runs after `pnpm build`)
 *
 * A plugin system makes one specific regression very easy and completely invisible: a single
 * static import from the shell into a plugin — or a package named in `manualChunks` — pulls that
 * plugin's whole chunk into the entry's static graph, Vite emits a <link rel="modulepreload"> for
 * it, and the browser downloads and parses it during startup. That is exactly how listing
 * monaco-editor in manualChunks once took dom-ready from 0.83 s to 14.6 s. Nothing fails, nothing
 * warns; the app just gets slower.
 *
 * So the invariants are checked mechanically:
 *   - index.html loads ONE script and preloads ONE chunk (react), plus the stylesheet
 *   - the entry chunk stays under its budget
 *   - no heavy library's fingerprint appears in the entry chunk
 *   - each heavy library still exists as its own separately-loaded chunk (i.e. it is lazy, not gone)
 *   - the pdf.js runtime assets were emitted, or CJK PDFs render blank in the packaged app only
 *
 * The budget is deliberately close to the measured number. If a change genuinely needs more, move
 * the number and say why in the commit — that is the point of it being here rather than in
 * somebody's memory.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const OUT = join(process.cwd(), 'out/renderer')
const ASSETS = join(OUT, 'assets')

/**
 * Measured 276,067 B before the plugin system; the shell only gets smaller as features leave.
 *
 * Moved from 320 kB to 327 kB for workspace heat, measured at 324,889 B: the side bar is ordered
 * and coloured by it from the first frame, and its clock has to be counting from the first
 * keystroke, so that much cannot wait for a chunk. Its checklist of cold workspaces, which can, is
 * fetched on demand.
 *
 * And to 332 kB for terminals at work, measured at 329,137 B: the counts on a workspace's row, the
 * spinner and dot on a tab and the outline on a pane are drawn whenever a terminal starts or stops,
 * and the watch behind them has to see a terminal's output from its first frame.
 */
const ENTRY_BUDGET_BYTES = 332_000

let failures = 0
let checks = 0

function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `  ${detail}` : ''}`)
}

if (!existsSync(OUT)) {
  console.error('no out/renderer — run `pnpm build` first')
  process.exit(1)
}

const html = readFileSync(join(OUT, 'index.html'), 'utf8')

// The entry is whatever index.html actually loads. Never `ls assets/index-*.js`: Monaco's 3.96 MB
// lazy chunk matches that glob too, and mistaking it for the entry makes this check meaningless.
const entryMatch = /<script[^>]+src="\.\/([^"]+)"/.exec(html)
const entry = entryMatch?.[1]
check('index.html loads exactly one entry script', !!entry, entry ?? '')

const preloads = [...html.matchAll(/<link rel="modulepreload"[^>]+href="\.\/([^"]+)"/g)].map(
  (m) => m[1]!
)
check(
  'index.html preloads only the react chunk',
  preloads.length === 1 && preloads[0]!.includes('react'),
  preloads.join(', ') || 'none'
)

let entrySource = ''
if (entry) {
  const entryPath = join(OUT, entry)
  const size = statSync(entryPath).size
  entrySource = readFileSync(entryPath, 'utf8')
  check(
    `entry chunk is under ${(ENTRY_BUDGET_BYTES / 1000).toFixed(0)} kB`,
    size <= ENTRY_BUDGET_BYTES,
    `${size.toLocaleString()} B`
  )
}

/**
 * Fingerprints chosen to survive minification AND to distinguish a library's code from a mere
 * reference to its chunk.
 *
 * That second property is the subtle one. The entry necessarily names every lazy chunk it can
 * reach — `assets/xterm-B-qIQCd3.js` is right there in the import map — and the loader in
 * `lazy.ts` keeps property names like `WebglAddon`. So a fingerprint of /xterm/ fails against a
 * perfectly lazy build. Each of these is a string literal that only the library's own
 * implementation contains.
 */
const HEAVY: { name: string; fingerprint: RegExp }[] = [
  { name: 'monaco-editor', fingerprint: /vs\/editor\/editor\.main|monaco-aria-container/ },
  { name: 'pdf.js', fingerprint: /GlobalWorkerOptions|PDFDocumentLoadingTask/ },
  { name: 'xterm', fingerprint: /xterm-helper-textarea|xterm-rows/ },
  { name: 'cordis', fingerprint: /cannot get property .* without inject/ }
]

const chunks = readdirSync(ASSETS).filter((f) => f.endsWith('.js'))

for (const { name, fingerprint } of HEAVY) {
  check(`${name} is not in the entry chunk`, !fingerprint.test(entrySource))

  const owners = chunks.filter(
    (f) => f !== entry?.replace('assets/', '') && fingerprint.test(readFileSync(join(ASSETS, f), 'utf8'))
  )
  // Present but elsewhere. If a library vanished entirely the first assertion would pass for the
  // wrong reason — a plugin that silently failed to build looks exactly like a lazy one.
  check(`${name} has its own lazily-loaded chunk`, owners.length > 0, owners.join(', ') || 'MISSING')
}

/**
 * pdf.js needs these at runtime and node_modules is not in the packaged app.
 *
 * Named FILES, not the directories that contain them. A version bump that renames
 * `wasm/openjpeg.wasm` leaves `out/renderer/pdfjs/wasm` standing — created by the sibling copy
 * that did succeed — so a directory check reports green while JPEG2000 pages render blank in the
 * packaged build and nowhere else. The counts are here for the same reason: an empty `cmaps/`
 * would otherwise pass, and the symptom is Chinese text quietly disappearing.
 */
const PDF_ASSETS = [
  'pdfjs/pdf.worker.min.mjs',
  'pdfjs/wasm/jbig2.wasm',
  'pdfjs/wasm/openjpeg.wasm',
  'pdfjs/wasm/qcms_bg.wasm',
  'pdfjs/iccs/CGATS001Compat-v2-micro.icc',
  'pdfjs/cmaps/UniGB-UCS2-H.bcmap',
  'pdfjs/cmaps/UniCNS-UCS2-H.bcmap',
  'pdfjs/standard_fonts/LiberationSans-Regular.ttf'
]
for (const asset of PDF_ASSETS) {
  check(`pdf.js runtime asset emitted: ${asset}`, existsSync(join(OUT, asset)))
}

for (const [dir, least] of [['pdfjs/cmaps', 100], ['pdfjs/standard_fonts', 10]] as const) {
  const count = existsSync(join(OUT, dir)) ? readdirSync(join(OUT, dir)).length : 0
  check(`${dir} has at least ${least} files`, count >= least, `${count}`)
}

console.log(`\n${checks - failures}/${checks} startup checks passed`)
process.exit(failures === 0 ? 0 : 1)
