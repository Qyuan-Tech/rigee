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

## Five entry points

| import | contains | realm |
|---|---|---|
| `@rigee/plugin-api` | everything | renderer half |
| `@rigee/plugin-api/manifest` | the declarative contract only — no React, no DOM | either |
| `@rigee/plugin-api/data` | the shared data types only | either |
| `@rigee/plugin-api/context` | types only: what `ctx.contributions`, `ctx.rpc`, `ctx.commands` and `ctx.shell` are | either |
| `@rigee/plugin-api/l10n` | `translator` and the types of a table of translations — no React, no DOM | either |

The main half must not import the root entry: it would pull React into a process that cannot
render. It gets the `ctx` typings with `import type {} from '@rigee/plugin-api/context'`; a plugin
with a renderer half has them already, through the root entry.

## Building

**The renderer half** leaves exactly `react`, `react-dom`, `react/jsx-runtime` and
`@rigee/plugin-api` external, as ESM. The shell resolves those through an import map to its own
copies — two Reacts in one window means broken hooks, and a second copy of this package means
talking to a host nobody installed. Bundle everything else, including anything you import from
`@rigee/plugin-api/manifest` or `@rigee/plugin-api/l10n`: the import map names the package, not its
subpaths.

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

## Speaking the user's language

Rigee's UI is in English or Simplified Chinese, as the user chooses in Settings, and can change
while your plugin runs. A plugin follows it in two places, both optional — whatever is not
translated is shown in English.

**Its manifest's words** — `displayName`, `description`, the titles and labels of its
contributions — are translated in the manifest itself, under `l10n`, each English string as the
manifest writes it to what it is in that language. The shell shows them before loading a line of
the plugin:

```jsonc
"rigee": {
  "displayName": "Hello",
  "contributes": { "views": [{ "id": "hello.panel", "title": "Hello", "slot": "left", "icon": "plugin" }] },
  "l10n": { "zh-CN": { "Hello": "你好" } }
}
```

**Its own UI** carries a table of its own, the same shape, keyed by the English the code says:

```tsx
import { localize } from '@rigee/plugin-api'

const { t, useT } = localize({ 'zh-CN': { 'Refresh': '刷新', '{n} files': '{n} 个文件' } })

function Panel() {
  const { t, tn } = useT() // re-renders when the user switches language
  return <button title={t('Refresh')}>{tn(count, '1 file', '{n} files')}</button>
}
```

`{name}` in a string is filled from the second argument, `t('Open {name}', { name })`; `tn` takes
English's two forms and a table translates it once, under the second. Outside a component — a menu
built in a click handler — call the `t` that `localize` returned, at the moment the words are
needed. **The main half** has no `localize`, being React-free: it asks `ctx.shell.locale()` each
time it says something and makes a `translator` from `@rigee/plugin-api/l10n`. `locale()` and
`useLocale()` give a renderer half the language itself.

All of it arrived in Rigee 1.2.0: a plugin that calls `localize`, `locale`, `useLocale` or
`ctx.shell.locale` should say `"minAppVersion": "1.2.0"`. An older Rigee ignores `l10n`.

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
`workerUrl` arrived in Rigee 1.1.0, and the language functions in 1.2.0. An older Rigee then refuses
the plugin by name instead of failing to link it.

## Permissions, and what they are not

`permissions` is an integrity boundary: the grant is recorded per plugin, and a new version that
asks for more has to ask again. It is **not** a sandbox. A renderer half runs in the shell's own
JavaScript context, so a hostile plugin can reach whatever the shell can reach regardless of what
it declared. Installing one is a decision to run its code with the application's privileges, and
Rigee's install dialog says so in those words.
