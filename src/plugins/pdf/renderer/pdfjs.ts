/**
 * pdf.js, loaded once, configured once, for the one plugin that needs it.
 *
 * PDF.JS MUST NEVER BE A TOP-LEVEL IMPORT. Measured: `await import('pdfjs-dist')` becomes its own
 * 437 kB chunk with no modulepreload, so a session that never opens a PDF pays nothing. The same
 * discipline `src/plugins/shared/monaco.ts` applies to Monaco, for the same reason.
 *
 * Everything below about workers and asset URLs was verified against pdfjs-dist 6.3.289 and a real
 * Electron 44 probe in all three worlds the app runs in: the http dev origin, a packaged file://
 * renderer, and that renderer inside an asar. The wrong choice here fails in exactly one of them.
 */

type Pdfjs = typeof import('pdfjs-dist')

let apiP: Promise<Pdfjs> | null = null

export function loadPdfjs(): Promise<Pdfjs> {
  apiP ??= (async () => {
    const pdfjs = await import('pdfjs-dist')

    /*
     * A worker URL, NOT a `workerPort`, and not Vite's `?worker` suffix (which forces you onto
     * workerPort). VERIFIED IN THE SOURCE, pdf.mjs:16390-16398: PDFWorker.create caches one
     * PDFWorker per port in a WeakMap, so two open PDF tabs would share a single worker and the
     * first tab's `loadingTask.destroy()` would break the second; and with a port `#webWorker` is
     * null, so destroy() never calls terminate() and every document opened leaks a 1.2 MB worker
     * plus its wasm heaps. With `workerSrc`, getDocument creates a dedicated worker per document
     * and destroy() terminates it.
     *
     * Module workers from file:// are allowed under this app's CSP, and a worker loaded from a URL
     * gets its own empty CSP — which is why WASM compiles inside it even though it is blocked on
     * the main thread. All 13 WebAssembly references live in pdf.worker.mjs; none in pdf.mjs.
     */
    pdfjs.GlobalWorkerOptions.workerSrc = asset('pdf.worker.min.mjs')
    return pdfjs
  })()
  return apiP
}

/**
 * The runtime assets the worker fetches for itself.
 *
 * EVERY URL NEEDS ITS TRAILING SLASH: `getFactoryUrlProp` throws
 * `Invalid factory url: "…" must include trailing slash.` otherwise, and it throws at
 * getDocument() time, which reads as "this PDF is broken".
 *
 * `cMapUrl` is what makes CJK work. Any CIDFont using a predefined Adobe CMap — UniGB-UCS2-H,
 * GBK-EUC-H, ETen-B5-H, the Adobe-GB1-* and Adobe-CNS1-* families — renders blank or garbled
 * without it, and the only symptom is a warn() inside the worker that nobody sees.
 *
 * `useWorkerFetch` is explicit on purpose. pdf.js auto-detects it with `/https?:/.test(protocol)`,
 * which is true on the dev origin and false under a packaged file:// renderer — two different code
 * paths for the same build — and false ADDITIONALLY hard-disables ICC colour management
 * (pdf.worker.mjs:2775-2778). Worker-side fetch over file://, including from inside an asar, is
 * verified working.
 */
export function assetOptions(): {
  cMapUrl: string
  cMapPacked: boolean
  standardFontDataUrl: string
  wasmUrl: string
  iccUrl: string
  useWorkerFetch: boolean
} {
  return {
    cMapUrl: asset('cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: asset('standard_fonts/'),
    wasmUrl: asset('wasm/'),
    iccUrl: asset('iccs/'),
    useWorkerFetch: true
  }
}

/**
 * One expression that resolves in both worlds, because the build emits the same layout into both:
 * http://localhost:5173/pdfjs/… under `electron-vite dev`, and
 * file:///…/app.asar/out/renderer/pdfjs/… once packaged. See the `pdfjsAssets` plugin in
 * electron.vite.config.ts.
 */
const asset = (rel: string): string => new URL(`pdfjs/${rel}`, document.baseURI).href
