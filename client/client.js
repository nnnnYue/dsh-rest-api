/**
 * dsh-rest-api WebUI client module.
 *
 * Built artifact must stay a `window.__ModuleLoader__` CJS-factory bundle at
 * `lib/client.js` (declared through package.json `exports["./client"]`); the
 * Host serves it to the browser and the client Cordis tree applies the
 * exported plugin. The module subscribes to the plugin's `restApi/open-requests`
 * Remote stream, accepts only frames addressed to this panel, switches the
 * workspace view, and acknowledges the commit back to the Host.
 *
 * The stream contribution is hand-written instead of generator-produced: the
 * descriptor has no business parameters, so client-side mounting does not need
 * generated strict codecs (only parameters/uplink/context codecs are checked).
 *
 * A panel identity comes from `?dshTarget=<key>` (or an iframe `name` carrying
 * the `dsh-rest-target:` prefix); without one the tab gets a per-session
 * `tab-<id>` and accepts legacy untargeted frames. The Host sends `'*'` for
 * single-panel and explicit broadcast requests, so a named panel still
 * receives those.
 */
const TARGET_PARAM = 'dshTarget'
const WINDOW_NAME_PREFIX = 'dsh-rest-target:'
const CLIENT_ID_KEY = 'dsh-rest-api/client-id'

function randomId() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return 'tab-' + crypto.randomUUID().replace(/-/g, '').slice(0, 12)
    }
  } catch (error) {
    void error
  }
  return 'tab-' + Math.random().toString(36).slice(2, 14)
}

function readClientId() {
  try {
    const existing = window.sessionStorage.getItem(CLIENT_ID_KEY)
    if (typeof existing === 'string' && existing.length > 0) return existing
    const created = randomId()
    window.sessionStorage.setItem(CLIENT_ID_KEY, created)
    return created
  } catch (error) {
    return randomId()
  }
}

function readTarget() {
  try {
    const value = new URLSearchParams(window.location.search).get(TARGET_PARAM)
    if (value !== null && value.length > 0) return value
  } catch (error) {
    void error
  }
  try {
    const name = window.name
    if (typeof name === 'string' && name.startsWith(WINDOW_NAME_PREFIX)) {
      const value = name.slice(WINDOW_NAME_PREFIX.length)
      if (value.length > 0) return value
    }
  } catch (error) {
    void error
  }
  return undefined
}

function errorMessage(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

window.__ModuleLoader__.load({
  id: 'dsh-rest-api',
  factory: () => {
    const inject = ['remote', 'uiWorkspace']
    const clientId = readClientId()
    const explicitTarget = readTarget()
    // A named panel accepts only its own key (or '*'); an unnamed panel also
    // accepts legacy untargeted frames and can be addressed by its tab id.
    const effectiveTarget = explicitTarget === undefined ? clientId : explicitTarget
    console.info('[dsh-rest-api] open-session viewer target=%s client=%s',
      explicitTarget === undefined ? '(auto)' : explicitTarget, clientId)

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

    function accepts(frame) {
      if (frame.target === '*') return true
      if (frame.target === effectiveTarget) return true
      return frame.target === undefined && explicitTarget === undefined
    }

    /**
     * Report the commit result to the Host. The Host's pending request keeps
     * the one-time key; acking after `openSession` returns means the client
     * accepted the navigation, not that history finished loading.
     * @param frame - accepted open-session frame.
     * @param ok - whether `openSession` returned without throwing.
     * @param error - failure detail when ok is false.
     */
    function acknowledge(frame, ok, error) {
      const endpoint = frame.ack
      if (endpoint === null || typeof endpoint !== 'object') return
      if (typeof endpoint.url !== 'string' || typeof endpoint.key !== 'string') return
      if (typeof fetch !== 'function') return
      const body = JSON.stringify({
        key: endpoint.key,
        clientId,
        target: effectiveTarget,
        sessionId: frame.sessionId,
        ok,
        ...(ok ? {} : { error: errorMessage(error) }),
      })
      let attempt = 0
      function retry() {
        attempt += 1
        if (attempt > 3) return
        setTimeout(send, 200 * attempt)
      }
      function send() {
        fetch(endpoint.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          keepalive: true,
        }).then((response) => {
          if (!response.ok) retry()
        }, retry)
      }
      send()
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
            if (!accepts(frame)) continue
            try {
              ctx.uiWorkspace.openSession(frame.sessionId)
              acknowledge(frame, true)
            } catch (error) {
              console.warn('[dsh-rest-api] openSession failed', error)
              acknowledge(frame, false, error)
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
