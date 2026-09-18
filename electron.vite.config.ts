import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Every override in this file is load-bearing and was established by measurement, not taste.
// See docs/stack.md before changing anything here.
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
    resolve: { alias: { '@shared': resolve('src/shared') } }
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
        // "Cannot use import statement outside a module" -> window.onestop is undefined.
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    },
    resolve: { alias: { '@shared': resolve('src/shared') } }
  },

  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    build: {
      sourcemap: true,
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
        '@shared': resolve('src/shared'),
        '@renderer': resolve('src/renderer/src')
      }
    }
  }
})
