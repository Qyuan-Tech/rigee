# @rigee/plugin-api

The contract a [Rigee](https://github.com/Qyuan-Tech/rigee) plugin is written against.

```bash
npm install --save-dev @rigee/plugin-api
```

A plugin is up to two halves, because Electron leaves no choice: a PDF renders in the sandboxed
renderer, and the bytes it renders can only be read in the main process. Each half default-exports
a [cordis](https://github.com/cordiverse/cordis) plugin, and the two share an id and talk over one
IPC channel.

```
my-plugin/
  package.json     the manifest, under a "rigee" key
  dist/main.js     ESM. Node. Optional.
  dist/renderer.js ESM. DOM. Optional.
```

```jsonc
{
  "name": "rigee-plugin-hello",
  "rigee": {
    "id": "hello",
    "version": "1.0.0",
    "displayName": "Hello",
    "apiVersion": 1,
    "permissions": ["files:read"],
    "main": "dist/main.js",
    "renderer": "dist/renderer.js",
    "contributes": {
      "views": [{ "id": "hello.panel", "title": "Hello", "slot": "left", "icon": "plugin" }]
    }
  }
}
```

```tsx
import { icons, openFile, type PluginViewProps } from '@rigee/plugin-api'
import type { Context, Plugin } from 'cordis'

function Panel({ onCollapse }: PluginViewProps) {
  return <button onClick={onCollapse}><icons.CollapseLeft size={14} /></button>
}

const plugin: Plugin = {
  name: 'hello',
  inject: ['contributions'],
  apply(ctx: Context) {
    ctx.contributions.view('hello.panel', Panel)
  }
}
export default plugin
```

## Two entry points

| import | contains | realm |
|---|---|---|
| `@rigee/plugin-api` | everything | renderer half |
| `@rigee/plugin-api/manifest` | the declarative contract only — no React, no DOM | either |
| `@rigee/plugin-api/data` | the shared data types only | either |

The main half must not import the root entry: it would pull React into a process that cannot
render.

## Building

Mark `react`, `react/jsx-runtime` and `@rigee/plugin-api` **external**, and emit ESM. The shell
resolves all three through an import map to its own copies — two Reacts in one window means broken
hooks, and a second copy of this package means talking to a host nobody installed.

```js
// rollup / vite / esbuild
external: ['react', 'react/jsx-runtime', 'react-dom', '@rigee/plugin-api']
format: 'esm'
```

## What `apiVersion` is for

The generation of this contract the plugin was built against. Rigee refuses a plugin whose
`apiVersion` it does not implement, at discovery, with that as the stated reason — rather than
letting it fail later as a missing export in a stack trace nobody can act on. Adding a function
does not bump it; removing or reshaping one does.

## Permissions, and what they are not

`permissions` is an integrity boundary: the grant is recorded per plugin, and a new version that
asks for more has to ask again. It is **not** a sandbox. A renderer half runs in the shell's own
JavaScript context, so a hostile plugin can reach whatever the shell can reach regardless of what
it declared. Installing one is a decision to run its code with the application's privileges, and
Rigee's install dialog says so in those words.
