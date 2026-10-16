# @rigee/plugin-api

The contract a [Rigee](https://github.com/Qyuan-Tech/rigee) plugin is written against.

```bash
npm install --save-dev @rigee/plugin-api
```

It is a development dependency on purpose: a renderer half leaves it out of its bundle and gets
Rigee's own copy at runtime (see Building), so the version you build against is for types and for
`minAppVersion`, not something that ships.

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
  "version": "1.0.0",
  "rigee": {
    "id": "hello",
    "version": "1.0.0",
    "displayName": "Hello",
    "apiVersion": 1,
    "minAppVersion": "1.1.0",
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

## Four entry points

| import | contains | realm |
|---|---|---|
| `@rigee/plugin-api` | everything | renderer half |
| `@rigee/plugin-api/manifest` | the declarative contract only — no React, no DOM | either |
| `@rigee/plugin-api/data` | the shared data types only | either |
| `@rigee/plugin-api/context` | types only: what `ctx.contributions`, `ctx.rpc`, `ctx.commands` and `ctx.shell` are | either |

The main half must not import the root entry: it would pull React into a process that cannot
render. It gets the `ctx` typings with `import type {} from '@rigee/plugin-api/context'`; a plugin
with a renderer half has them already, through the root entry.

## Building

**The renderer half** leaves exactly `react`, `react-dom`, `react/jsx-runtime` and
`@rigee/plugin-api` external, as ESM. The shell resolves those through an import map to its own
copies — two Reacts in one window means broken hooks, and a second copy of this package means
talking to a host nobody installed. Bundle everything else, including anything you import from
`@rigee/plugin-api/manifest`: the import map names the package, not its subpaths.

**The main half** is one bundled ESM file for Node, with only `electron` and Node's built-ins left
external. One file because Rigee re-imports it after an update under a new URL, and a second file
it imported relatively would come back from Node's module cache as the old one.

**Styles** cannot be a `<link>`: the window's policy does not load stylesheets from a plugin.
Inline your CSS into the bundle and add it as a `<style>` element when the module loads.

**Workers** cannot be started from a plugin's own files — a window only starts workers from its
own origin. Start one through the shell instead, from a self-contained script (a worker has no
import map):

```ts
new Worker(workerUrl(new URL('./parse.worker.js', import.meta.url)), { type: 'module' })
```

**Code highlighting** comes from the text editor's own tokenizers: `tokenizeCode(text, 'ts')`
returns the tokens of each line, so a plugin need not ship a highlighter of its own.

## Publishing, so that Rigee can find it

Rigee's plugins view searches public GitHub. A repository is found and installable when:

| | the rule |
|---|---|
| found by | the topic `rigee-plugin` |
| named | `rigee-plugin-<id>` — the id in lower-case letters, digits and hyphens |
| released | its latest release (not a draft or pre-release) is tagged `v<version>` |
| packaged | that release carries `rigee-plugin-<id>-<version>.tgz`, exactly as `npm pack` writes it |
| agreeing | `name` is the repository's name; the tag, `version` and `rigee.version` are one version |

Rigee downloads the tarball, checks it against the SHA-256 GitHub reports for it, unpacks it
(regular files and directories under `package/`, nothing else), checks the manifest, and only then
asks the user — saying where the plugin came from, that it was found by searching, and that Rigee
has not reviewed it. Turn on immutable releases if you can: a release that cannot be changed after
it is published is one a user can trust to stay what they approved.

## What `apiVersion` and `minAppVersion` are for

`apiVersion` is the generation of this contract the plugin was built against. Rigee refuses a
plugin whose `apiVersion` it does not implement, at discovery, with that as the stated reason —
rather than letting it fail later as a missing export in a stack trace nobody can act on. Adding a
function does not bump it; removing or reshaping one does.

`minAppVersion` is the oldest Rigee the plugin runs in. A function added to this package exists
only in Rigee releases from then on, so a plugin that calls one should say so — `tokenizeCode` and
`workerUrl` arrived in Rigee 1.1.0. An older Rigee then refuses the plugin by name instead of
failing to link it.

## Permissions, and what they are not

`permissions` is an integrity boundary: the grant is recorded per plugin, and a new version that
asks for more has to ask again. It is **not** a sandbox. A renderer half runs in the shell's own
JavaScript context, so a hostile plugin can reach whatever the shell can reach regardless of what
it declared. Installing one is a decision to run its code with the application's privileges, and
Rigee's install dialog says so in those words.
