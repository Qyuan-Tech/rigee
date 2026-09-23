/**
 * The main half, as a plugin from outside the app ships it: plain ESM, already built.
 *
 * Loaded with `import(pathToFileURL(...))` by the shell, only after the user has approved this
 * exact copy. It has the main process's full Node access — see the trust notes in the README:
 * the permission list in package.json is a declaration, not a cage.
 */
export default {
  name: 'hello',
  // Without `inject`, reading ctx.commands throws "cannot get property … without inject", and the
  // fiber never reaches ACTIVE — which the host turns into a real error rather than a plugin that
  // quietly does nothing.
  inject: ['commands'],
  apply(ctx) {
    // BOUND, not captured bare. cordis substitutes the calling plugin's context by swapping
    // thisArg when a service method is called through the proxy; `const r = ctx.commands.register`
    // loses that and throws on `this.ctx`.
    const commands = ctx.commands
    const register = commands.register.bind(commands)

    register('hello:ping', (payload) => ({
      pong: true,
      echo: payload,
      node: process.versions.node
    }))
  }
}
