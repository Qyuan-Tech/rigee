import type { Context, Plugin } from 'cordis'
import { GitService } from './git/service'
import { registerScmCommands, scmEmitter, type DiffHunkView } from '../protocol'
import type { ParsedDiff } from './git/patch'

/**
 * Source control, main half: the git binary, the blob readers and the filesystem watchers.
 *
 * TWO THINGS HERE ARE LOAD-BEARING.
 *
 * `inject` is not optional. Reading `ctx.commands` or `ctx.shell` without declaring it throws
 * "cannot get property … without inject", and a half whose injection cannot be satisfied does not
 * fail loudly — its fiber sits in PENDING forever and `apply` never runs. The host asserts the
 * fiber reached ACTIVE so that becomes a real error instead of a much later "unknown plugin
 * command".
 *
 * The GitService is constructed inside an effect, not at module scope. It used to be a
 * module-scope `const gitService = new GitService()` in src/main/index.ts, which meant the import
 * of @parcel/watcher — measured at 29.7 ms — sat on the boot path of every launch, including the
 * ones that never open the panel. Behind activation it costs nothing until the renderer asks for
 * a status, and the effect's disposer still tears every watcher and `cat-file --batch` down when
 * the app quits.
 */
const plugin: Plugin = {
  name: 'scm',
  inject: ['commands', 'shell'],
  apply(ctx: Context) {
    // Captured once, at activation, and BOUND. The bind is not decoration: cordis swaps in the
    // shadow context only when the method is called with the service proxy as its receiver
    // (`createShadowMethod` compares `thisArg === outer`), so a bare `const emit = ctx.shell.emit`
    // is called with `this` undefined and throws on `this.ctx` — and both wrappers below call
    // what they are handed as a plain function. Measured on cordis 4.0.0-rc.10, per call:
    // `ctx.svc.method()` 15.7 us, `svc.method()` 4.7 us, bound 0.20 us. `emit` fires on every
    // filesystem change in every watched repo, so it is the one that matters.
    const commands = ctx.commands
    const register = commands.register.bind(commands)
    const shell = ctx.shell
    const emit = scmEmitter(shell.emit.bind(shell))
    // The language, for the few errors the service words itself. Handed over as a function, not a
    // value: it is asked each time, because the user can switch while the plugin runs.
    const locale = shell.locale.bind(shell)

    // Assigned synchronously by the effect below; cordis runs a sync effect's body on the spot.
    let git!: GitService
    ctx.effect(() => {
      git = new GitService(locale)
      // RETURNED, not voided: cordis awaits a disposer that hands back a promise (verified
      // against 4.0.0-rc.10), and that is the link that lets `app.quit` wait for the filesystem
      // watchers to actually let go. Dropping the promise here would put the abort-on-quit back.
      return () => git.dispose()
    }, 'git service')

    registerScmCommands(register, {
      'scm:status': ({ repoRoot }) => git.status(repoRoot),
      'scm:statusAll': ({ repoRoots }) => git.statusAll(repoRoots),
      'scm:diff': ({ repoRoot, path, against }) => git.diff(repoRoot, path, against),
      'scm:stage': ({ repoRoot, paths }) => git.stage(repoRoot, paths),
      'scm:unstage': ({ repoRoot, paths }) => git.unstage(repoRoot, paths),
      'scm:discard': ({ repoRoot, paths }) => git.discard(repoRoot, paths),
      'scm:commit': ({ repoRoot, message, amend }) => git.commit(repoRoot, message, amend),
      'scm:hunks': async ({ repoRoot, path, action }) => {
        const parsed = await git.hunks(repoRoot, path, action)
        return { hunks: withLineNumbers(parsed), binary: parsed.binary }
      },
      'scm:applySelection': ({ repoRoot, path, lineIds, action }) =>
        git.applySelection(repoRoot, path, lineIds, action),
      'scm:watch': ({ repoRoots }) =>
        git.watch(repoRoots, (status) => { emit('status', { status }) })
    })
  }
}

export default plugin

/**
 * Attach gutter line numbers to a parsed diff. The counters advance per side: a '-' line exists
 * only in the old file, a '+' only in the new, context in both.
 */
function withLineNumbers(parsed: ParsedDiff): DiffHunkView[] {
  return parsed.hunks.map((h) => {
    let oldNo = h.oldStart
    let newNo = h.newStart
    return {
      section: h.section,
      oldStart: h.oldStart,
      newStart: h.newStart,
      lines: h.lines.map((l) => ({
        kind: l.kind,
        text: l.text,
        noEol: l.noEol,
        id: l.id,
        oldNo: l.kind === '+' ? null : oldNo++,
        newNo: l.kind === '-' ? null : newNo++
      }))
    }
  })
}
