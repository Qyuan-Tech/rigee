/**
 * `@rigee/plugin-api` — everything a plugin is allowed to know about Rigee.
 *
 * A plugin should import from here and from nowhere else in the app. That is the whole point of
 * the package: what is exported here is versioned and will be kept working, and what is not is the
 * shell's own business and will be moved without warning.
 *
 * TWO ENTRY POINTS, and the split is load-bearing rather than tidy:
 *
 *   `@rigee/plugin-api`            the full surface. Needs a DOM and React. Renderer halves.
 *   `@rigee/plugin-api/manifest`   the declarative contract alone: no React, no DOM, no runtime.
 *
 * The main process reads manifests too — to decide which plugin owns a command before importing a
 * line of it — and importing this barrel there would drag React into a process that can never
 * render. The same reason the manifests themselves hold no import thunks.
 */

export * from './data'
export * from './manifest'
export * from './ui'
export * from './host'
export * from './context'
