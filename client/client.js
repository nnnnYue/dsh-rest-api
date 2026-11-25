/**
 * dsh-rest-api WebUI client module.
 *
 * Built artifact must stay a `window.__ModuleLoader__` CJS-factory bundle at
 * `lib/client.js` (declared through package.json `exports["./client"]`); the
 * Host serves it to the browser and the client Cordis tree applies the
 * exported plugin. The module subscribes to the plugin's `restApi/open-requests`
 * Remote stream and switches the workspace view for every frame.
 *
 * The stream contribution is hand-written instead of generator-produced: the
 * descriptor has no business parameters, so client-side mounting does not need
 * generated strict codecs (only parameters/uplink/context codecs are checked).
 */
window.__ModuleLoader__.load({
  id: 'dsh-rest-api',
  factory: () => {
    const inject = ['remote', 'uiWorkspace']

    const contribution = {
      package: 'dsh-rest-api',
      descriptors: [{
        id: 'src:dsh-rest-api#restApi/open-requests',
        service: 'restApiRemotes',
        namespace: 'restApi',
        method: 'openRequests',
        mode: 'stream',
        invocation: { kind: 'direct' },
        parameters: [],
        cancellation: { parameter: 'signal' },
        result: { mode: 'src-json' },
      }],
    }

    /**
     * Subscribe to the live open-request feed.
     * @param ctx - Client Cordis context.
     * @param signal - subscription lifetime; aborting ends the loop.
     */
    async function consume(ctx, signal) {
      await ctx.remote.$mount(contribution)

      // The Gateway client re-emits `connection/reset` on every successful
      // carrier connection, including the first; the loop paces its immediate
      // reopenings on that instead of polling.
      let resets = 0
      ctx.on('connection/reset', () => { resets += 1 })

      const waitReset = (since) => new Promise((resolve) => {
        const dispose = ctx.on('connection/reset', () => { dispose?.(); resolve() })
        signal.addEventListener('abort', () => { dispose?.(); resolve() }, { once: true })
        if (resets !== since || signal.aborted) { dispose?.(); resolve() }
      })

      const retryDelay = (ms) => new Promise((resolve) => {
        const timer = setTimeout(resolve, ms)
        signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
      })

      // Mounted namespace services are provisioned under their own fibers, so
      // the property path (`ctx.remote.restApi`) does not resolve from a sibling
      // client module; the service key does.
      const namespace = () => ctx.get('remote.restApi')

      for (;;) {
        const before = resets
        try {
          for await (const frame of namespace().openRequests(signal)) {
            if (signal.aborted) return
            if (frame === null || typeof frame !== 'object') continue
            if (frame.type !== 'open-session' || typeof frame.sessionId !== 'string') continue
            try {
              ctx.uiWorkspace.openSession(frame.sessionId)
            } catch (error) {
              console.warn('[dsh-rest-api] openSession failed', error)
            }
          }
          console.warn('[dsh-rest-api] open-session stream ended')
        } catch (error) {
          if (signal.aborted) return
          console.warn('[dsh-rest-api] open-session stream lost', error)
        }
        if (signal.aborted) return
        // Reopen immediately after a carrier reconnect; otherwise poll slowly,
        // so a transient open failure cannot wedge the subscription.
        await Promise.race([waitReset(before), retryDelay(5000)])
        if (signal.aborted) return
      }
    }

    function apply(ctx) {
      console.info('[dsh-rest-api] client module active')
      // apply must settle synchronously: the boot barrier awaits every module
      // plugin, so the long-lived subscription runs detached with its lifetime
      // tied to this effect's disposer.
      ctx.effect(() => {
        const controller = new AbortController()
        const { signal } = controller
        void consume(ctx, signal).catch((error) => {
          console.error('[dsh-rest-api] open-session subscriber failed', error)
        })
        return () => controller.abort('dsh-rest-api client module disposed')
      }, 'dsh-rest-api: open-session stream')
    }

    return { inject, apply }
  },
})
