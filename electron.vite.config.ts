import { cpSync, createReadStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

// Every override in this file is load-bearing and was established by measurement, not taste.
// See docs/DEVELOPMENT.md before changing anything here.

/**
 * pdf.js's runtime assets, at the same URL in dev and in the packaged app.
 *
 * pdfjs-dist is a devDependency (correctly: promoting it would drag 35 MB, including 243 MB of
 * @napi-rs/canvas prebuilds it never uses in a browser, into the production closure), so
 * node_modules simply does not exist at runtime. electron-builder packs `out/**` and nothing else,
 * which means anything the viewer fetches has to be emitted into out/renderer at build time.
 *
 * The result is one expression that works in both worlds: `new URL('pdfjs/', document.baseURI)` is
 * http://localhost:5173/pdfjs/ under `electron-vite dev` and
 * file:///…/app.asar/out/renderer/pdfjs/ in the packaged app — verified reading a .bcmap out of a
 * real asar, which Electron serves through file:// transparently, so no asarUnpack is needed.
 *
 * Only what the worker actually asks for is copied. Of pdfjs-dist's 1.5 MB wasm directory it wants
 * exactly three files; `quickjs-eval.wasm` (469 kB) belongs to PDF-JavaScript/XFA scripting, which
 * pdf.worker.mjs never references, and the *_nowasm_fallback.js pair (597 kB) is only reached when
 * WebAssembly instantiation fails — which it does not here: a module worker loaded from a URL gets
 * its own empty CSP, so it compiles WASM happily even though the document cannot.
 */
function pdfjsAssets(): Plugin {
  const pkg = resolve(__dirname, 'node_modules/pdfjs-dist')
  const copies: [from: string, to: string][] = [
    ['cmaps', 'cmaps'],
    ['standard_fonts', 'standard_fonts'],
    ['iccs', 'iccs'],
    ['wasm/jbig2.wasm', 'wasm/jbig2.wasm'],
    ['wasm/openjpeg.wasm', 'wasm/openjpeg.wasm'],
    ['wasm/qcms_bg.wasm', 'wasm/qcms_bg.wasm'],
    ['build/pdf.worker.min.mjs', 'pdf.worker.min.mjs']
  ]
  const MIME: Record<string, string> = {
    '.mjs': 'text/javascript',
    '.js': 'text/javascript',
    '.wasm': 'application/wasm',
    '.icc': 'application/vnd.iccprofile'
  }
  let outDir = resolve(__dirname, 'out/renderer')

  return {
    name: 'rigee:pdfjs-assets',
    configResolved(config) {
      outDir = config.build.outDir
    },
    // Dev serves straight out of node_modules rather than copying, so a pnpm update is picked up
    // without a rebuild and the tree stays free of 3.5 MB of vendored binaries.
    configureServer(server) {
      server.middlewares.use('/pdfjs', (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? '/').split('?')[0]!).replace(/^\/+/, '')
        const match = copies.find(([, to]) => rel === to || rel.startsWith(`${to}/`))
        if (!match) return next()

        // Containment, checked on the RESOLVED path. The url is decoded before it is matched —
        // it has to be, cmap names are percent-encoded — so `cmaps/%2e%2e%2f%2e%2e%2f…` would
        // otherwise walk straight out of node_modules and hand any file on disk to anything that
        // can reach the dev server, which under this app includes a page open in a browser tab.
        const root = resolve(pkg, match[0])
        const file = resolve(root, rel.slice(match[1].length).replace(/^\/+/, ''))
        if (file !== root && !file.startsWith(root + sep)) return next()
        if (!existsSync(file) || !statSync(file).isFile()) return next()

        res.setHeader('Content-Type', MIME[extname(file)] ?? 'application/octet-stream')
        createReadStream(file).pipe(res)
      })
    },
    writeBundle() {
      for (const [from, to] of copies) {
        const src = join(pkg, from)
        // Fatal, not a warning. A missing asset breaks only specific documents and only in the
        // packaged build — a renamed wasm file means JPEG2000 pages render blank, missing cmaps
        // mean Chinese text does — so a warning in a 300-line build log is indistinguishable from
        // success. Failing here is the only place it can still be cheap to notice.
        if (!existsSync(src)) {
          this.error(`pdfjs runtime asset missing: node_modules/pdfjs-dist/${from}`)
        }
        const dest = join(outDir, 'pdfjs', to)
        mkdirSync(join(dest, '..'), { recursive: true })
        cpSync(src, dest, { recursive: true })
      }
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      sourcemap: true,
      minify: false,
      // Electron 44 runs Node 24.21.0. electron-vite 5's Electron->Node table stops at Electron 39
      // and would otherwise silently fall back to node22.20.
      target: 'node24',
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
        external: ['node-pty'],
        output: { format: 'es' }
      }
    },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        '@plugins': resolve(__dirname, 'plugins')
      }
    }
  },

  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      sourcemap: 'inline',
      minify: false,
      target: 'node24',
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        // MANDATORY. package.json has type:module, so electron-vite would emit an ESM preload,
        // and an ESM preload under sandbox:true fails hard with
        // "Cannot use import statement outside a module" -> window.rigee is undefined.
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    },
    resolve: { alias: { '@shared': resolve('src/shared') } }
  },

  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react(), pdfjsAssets()],
    // build/pdf.mjs is one self-contained 860 kB ESM file with zero static imports. Pre-bundling
    // it buys nothing and rewrites the /*@vite-ignore*/ dynamic import inside it.
    optimizeDeps: { exclude: ['pdfjs-dist'] },
    // `root` is src/renderer, but the plugins live in plugins/ at the repo root — outside it. Vite's default
    // allowlist walks up to the workspace root and would usually cover that; saying so explicitly
    // means `pnpm dev` cannot start refusing to serve a plugin with "outside of Vite serving
    // allow list", which reads like a missing file rather than a policy.
    server: { fs: { allow: [resolve(__dirname)] } },
    build: {
      // Off, unlike main and preload, and the one place in this file where less is more.
      // Mapping a 4 MB minified Monaco chunk back over ~1500 sources costs >2 GB of build heap:
      // it is what made CI die with "Ineffective mark-compacts near heap limit" on a 7 GB runner,
      // where Node sizes the default old space at ~2 GB. And the maps were never reaching anyone
      // — electron-builder.yml drops '**/*.map' from the package, so all 18 MB of them were built
      // and then thrown away. `electron-vite dev` serves unminified sources with full maps, which
      // is where renderer debugging actually happens.
      sourcemap: false,
      // electron-vite defaults this to false for all three targets. Measured 645 kB -> 224 kB.
      minify: 'esbuild',
      target: 'chrome152',
      chunkSizeWarningLimit: 4000,
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
        output: {
          // ONLY statically-imported packages belong here. Naming a dynamically-imported package
          // as a manual chunk pulls it into the entry's static graph, so Vite emits a
          // <link rel="modulepreload"> for it in index.html and the browser fetches and parses it
          // during startup — which silently undoes the lazy import. Measured cost of listing
          // monaco here: a 3.8 MB preload and ~4 s added before dom-ready.
          // Monaco and xterm are dynamically imported (see src/renderer/src/lazy.ts); Rollup
          // already gives each its own chunk.
          manualChunks: {
            react: ['react', 'react-dom']
          }
        }
      }
    },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        '@renderer': resolve(__dirname, 'src/renderer/src'),
        // Plugins live outside `root` (src/renderer), which Vite's dev server allows because its
        // fs allowlist walks up to the workspace root. Keep them out of `manualChunks`.
        '@plugins': resolve(__dirname, 'plugins')
      }
    }
  }
})
