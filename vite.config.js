import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { WebSocketServer, WebSocket } from 'ws'

const XRPL_NODE = process.env.XRPL_WS || 'ws://127.0.0.1:6006'
const UNL_URL = 'https://vl.ripple.com'

/**
 * Same-origin UNL fetch — vl.ripple.com has no CORS headers.
 */
function unlProxy() {
  const handle = async (_req, res) => {
    try {
      const r = await fetch(UNL_URL, { headers: { accept: 'application/json' } })
      const body = await r.text()
      res.statusCode = r.ok ? 200 : r.status
      res.setHeader('content-type', 'application/json')
      res.setHeader('cache-control', 'public, max-age=300')
      res.end(body)
    } catch (err) {
      res.statusCode = 502
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ error: String(err?.message || err) }))
    }
  }
  const middleware = (req, res, next) => {
    const path = String(req.url || '').split('?')[0]
    if (path !== '/unl') return next()
    handle(req, res)
  }
  return {
    name: 'unl-proxy',
    configureServer(server) {
      server.middlewares.use(middleware)
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware)
    },
  }
}

/**
 * Same-origin WS bridge so the dashboard can reach a local xrpld
 * without Origin / mixed-content issues:  /xrpl-ws → ws://127.0.0.1:6006
 * Default dashboard traffic goes direct to wss://s1.ripple.com/.
 */
function xrplWsBridge(target) {
  return {
    name: 'xrpl-ws-bridge',
    configureServer(server) {
      const wss = new WebSocketServer({ noServer: true })
      const onUpgrade = (req, socket, head) => {
        const path = String(req.url || '').split('?')[0]
        if (path !== '/xrpl-ws') return
        socket.on('error', () => {
          try {
            socket.destroy()
          } catch {
            /* noop */
          }
        })
        wss.handleUpgrade(req, socket, head, (client) => {
          let upstream
          try {
            upstream = new WebSocket(target, { handshakeTimeout: 8000 })
          } catch (err) {
            console.warn('[xrpl-ws] create:', err?.message || err)
            try {
              client.close()
            } catch {
              /* noop */
            }
            return
          }
          const pending = []
          let closed = false
          const closeBoth = (why) => {
            if (closed) return
            closed = true
            if (why) console.warn('[xrpl-ws] close:', why)
            try {
              client.close()
            } catch {
              /* noop */
            }
            try {
              upstream.terminate?.()
            } catch {
              /* noop */
            }
          }
          upstream.on('open', () => {
            console.log(`[xrpl-ws] upstream open → ${target}`)
            while (pending.length) {
              const m = pending.shift()
              if (upstream.readyState === WebSocket.OPEN) upstream.send(m)
            }
          })
          client.on('message', (data, isBinary) => {
            const payload = isBinary ? data : data.toString()
            if (upstream.readyState === WebSocket.OPEN) upstream.send(payload)
            else if (upstream.readyState === WebSocket.CONNECTING) pending.push(payload)
          })
          upstream.on('message', (data, isBinary) => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(data, { binary: !!isBinary })
            }
          })
          client.on('close', () => closeBoth())
          client.on('error', (err) => closeBoth(err?.message || 'client'))
          upstream.on('close', () => closeBoth())
          upstream.on('error', (err) => closeBoth(`upstream: ${err?.message || err}`))
        })
      }
      const attach = () => {
        const httpServer = server.httpServer
        if (!httpServer) return
        httpServer.removeListener('upgrade', onUpgrade)
        if (typeof httpServer.prependListener === 'function') {
          httpServer.prependListener('upgrade', onUpgrade)
        } else {
          httpServer.on('upgrade', onUpgrade)
        }
        console.log(`[xrpl-ws] /xrpl-ws → ${target}`)
      }
      if (server.httpServer?.listening) attach()
      else server.httpServer?.once('listening', attach)
      setTimeout(attach, 0)
    },
  }
}

export default defineConfig({
  plugins: [vue(), unlProxy(), xrplWsBridge(XRPL_NODE)],
  server: {
    port: 5180,
    strictPort: true,
    host: true,
  },
  define: {
    'import.meta.env.XRPL_NODE': JSON.stringify(XRPL_NODE),
  },
})
