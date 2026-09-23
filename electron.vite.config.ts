import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { cpSync, createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
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

/**
 * What a plugin loaded from disk may import by bare name, and where those names point.
 *
 * A plugin from another repository is built long before this shell exists, so it cannot bundle
 * React — two Reacts in one window means hooks throw the moment a plugin's component renders
 * inside the shell's tree — and it cannot bundle `@rigee/plugin-api`, whose module state holds the
 * installed host, because a second copy would be talking to nobody. It leaves all of them
 * external, and an import map in index.html resolves them to the shell's own copies.
 *
 * The values are the emitted filenames, which must be STABLE: an import map is text written before
 * the build hashes anything.
 */
const PLUGIN_RUNTIME: Record<string, string> = {
  react: 'react',
  'react-dom': 'react-dom',
  'react/jsx-runtime': 'jsx-runtime',
  'react/jsx-dev-runtime': 'jsx-dev-runtime',
  '@rigee/plugin-api': 'api'
}

const RUNTIME_DIR = 'plugin-runtime'
/** The shell publishes its copies here at boot. See src/renderer/src/plugins/shellHost.tsx. */
const RUNTIME_GLOBAL = '__rigeePluginRuntime'

/**
 * A re-export module for one bare specifier.
 *
 * TWO THINGS HERE ARE THE RESULT OF GETTING IT WRONG FIRST, and both failures were silent.
 *
 * 1. These are NOT Rollup entries, and must not become them. As entries they shared modules with
 *    the shell's entry, which made Rollup re-cut the chunks — index.html went from preloading one
 *    chunk to four, so startup began fetching and parsing the plugin runtime for plugins that may
 *    not be installed. Reading a global instead means these files import nothing, share nothing,
 *    and cannot perturb the graph. (`pnpm perf:check` asserts the preload count, and caught it.)
 *
 * 2. The names are generated, not written. `export * from 'react'` looks like the obvious spelling
 *    and does not work: react is CommonJS, Rollup cannot enumerate a CJS module's exports for a
 *    star re-export, and the module it emits exports nothing. That surfaces as
 *    `undefined is not a function` at the plugin's first `useState`, inside somebody else's code.
 *    Reading the keys off the installed package, in this process, cannot drift from the copy the
 *    bundle will contain — a React upgrade that adds a hook needs no change here.
 */
async function runtimeShim(spec: string): Promise<string> {
  const names = await runtimeExports(spec)
  return [
    `// Generated by electron.vite.config.ts. The shell's own ${spec}, under its bare name,`,
    '// for plugins loaded from disk. Resolved through the import map in index.html.',
    `const m = globalThis.${RUNTIME_GLOBAL}?.[${JSON.stringify(spec)}]`,
    'if (!m) {',
    `  throw new Error(${JSON.stringify(
      `rigee: ${spec} was requested before the shell published its runtime`
    )})`,
    '}',
    'export default m',
    ...names.map((n) => `export const ${n} = m.${n}`),
    ''
  ].join('\n')
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/

/**
 * The export names of one runtime module.
 *
 * The react family is CommonJS in node_modules, so requiring it here gives exactly the keys the
 * bundle will expose. `@rigee/plugin-api` is our own TypeScript, so esbuild — already a Vite
 * dependency — bundles it in memory and reports its exports. Both are read from the same source
 * the build uses, which is the property that matters: a hand-kept list would be wrong the first
 * time somebody adds a function and right-looking for months.
 */
async function runtimeExports(spec: string): Promise<string[]> {
  if (spec === '@rigee/plugin-api') {
    const { build } = await import('esbuild')
    const result = await build({
      entryPoints: [resolve(__dirname, 'packages/plugin-api/src/index.ts')],
      bundle: true,
      write: false,
      format: 'esm',
      metafile: true,
      logLevel: 'silent',
      external: ['react', 'react/jsx-runtime']
    })
    const outputs = Object.values(result.metafile.outputs)
    return (outputs[0]?.exports ?? []).filter((n) => IDENTIFIER.test(n) && n !== 'default').sort()
  }

  const req = createRequire(join(__dirname, 'noop.js'))
  const mod = req(spec) as Record<string, unknown>
  return Object.keys(mod).filter((n) => IDENTIFIER.test(n) && n !== 'default').sort()
}

/**
 * The import map, the CSP that has to permit it, and the shim files themselves.
 *
 * One plugin because they are one fact. An import map can only be inline — Chromium has never
 * shipped external ones — and an inline script is blocked by `script-src 'self'`. Rather than open
 * the door with 'unsafe-inline', the exact bytes are hashed and that hash is added, so a different
 * import map injected by anything else still does not run. `rigee-plugin:` joins script-src for
 * the plugin's own chunk, which arrives over the custom protocol registered in
 * src/main/plugins/installed.ts.
 *
 * The URLs differ between dev and build, so the map is written here rather than committed into
 * index.html, where it could only be right in one of the two.
 */
function pluginRuntime(): Plugin {
  let outDir = resolve(__dirname, 'out/renderer')

  return {
    name: 'rigee:plugin-runtime',
    configResolved(config) {
      outDir = config.build.outDir
    },
    // Dev generates on request rather than writing files, so a React upgrade is picked up by a
    // reload and nothing untracked appears in the tree.
    configureServer(server) {
      server.middlewares.use(`/${RUNTIME_DIR}`, (req, res, next) => {
        const file = (req.url ?? '').replace(/^\/+/, '').replace(/\.js$/, '')
        const spec = Object.entries(PLUGIN_RUNTIME).find(([, f]) => f === file)?.[0]
        if (!spec) return next()
        void runtimeShim(spec).then((code) => {
          res.setHeader('Content-Type', 'text/javascript')
          res.end(code)
        }, next)
      })
    },
    async writeBundle() {
      for (const [spec, file] of Object.entries(PLUGIN_RUNTIME)) {
        const dest = join(outDir, 'assets', RUNTIME_DIR, `${file}.js`)
        mkdirSync(join(dest, '..'), { recursive: true })
        writeFileSync(dest, await runtimeShim(spec), 'utf8')
      }
    },
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        const imports = Object.fromEntries(
          Object.entries(PLUGIN_RUNTIME).map(([spec, file]) => [
            spec,
            ctx.server ? `/${RUNTIME_DIR}/${file}.js` : `./assets/${RUNTIME_DIR}/${file}.js`
          ])
        )
        const json = JSON.stringify({ imports }, null, 2)
        const digest = createHash('sha256').update(json, 'utf8').digest('base64')

        return html
          .replace("script-src 'self'", `script-src 'self' rigee-plugin: 'sha256-${digest}'`)
          .replace("connect-src 'self'", "connect-src 'self' rigee-plugin:")
          .replace('</head>', `  <script type="importmap">${json}</script>\n  </head>`)
      }
    }
  }
}

/**
 * `@rigee/plugin-api`, resolved by path rather than through node_modules.
 *
 * The package is real and publishable — a plugin in somebody else's repository will `npm i` it —
 * but the app has no reason to install it: everything here is bundled, so resolving the source
 * directly is one fewer moving part and keeps a pnpm workspace (with its symlinks, which
 * electron-builder handles badly) out of the packaging story entirely.
 *
 * ORDER MATTERS, and this is why the aliases became an array. Vite tries them in order and takes
 * the first match, so the exact `@rigee/plugin-api/manifest` entry has to precede the bare
 * `@rigee/plugin-api` one — a prefix match would otherwise rewrite the subpath to
 * `…/src/index.ts/manifest`, which resolves to nothing, and the error names a file nobody wrote.
 */
const PLUGIN_API_ALIASES = [
  {
    find: '@rigee/plugin-api/data',
    replacement: resolve(__dirname, 'packages/plugin-api/src/data.ts')
  },
  {
    find: '@rigee/plugin-api/manifest',
    replacement: resolve(__dirname, 'packages/plugin-api/src/manifest.ts')
  },
  { find: '@rigee/plugin-api', replacement: resolve(__dirname, 'packages/plugin-api/src/index.ts') }
]

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
      alias: PLUGIN_API_ALIASES.concat([
        { find: '@shared', replacement: resolve(__dirname, 'src/shared') },
        { find: '@plugins', replacement: resolve(__dirname, 'plugins') }
      ])
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
    resolve: {
      alias: PLUGIN_API_ALIASES.concat([
        { find: '@shared', replacement: resolve(__dirname, 'src/shared') }
      ])
    }
  },

  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react(), pdfjsAssets(), pluginRuntime()],
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
      alias: PLUGIN_API_ALIASES.concat([
        { find: '@shared', replacement: resolve(__dirname, 'src/shared') },
        { find: '@renderer', replacement: resolve(__dirname, 'src/renderer/src') },
        // Plugins live outside `root` (src/renderer), which Vite's dev server allows because its
        // fs allowlist walks up to the workspace root. Keep them out of `manualChunks`.
        { find: '@plugins', replacement: resolve(__dirname, 'plugins') }
      ])
    }
  }
})
