import Fastify, { type FastifyReply, type FastifyRequest } from "fastify"
import { WebSocketServer, type WebSocket } from "ws"
import type { Config } from "./config.js"
import { log, errClass } from "./log.js"
import type { SessionManager, SessionRecord } from "./manager.js"
import type { SandboxDriver } from "./driver/types.js"
import type { AgentEvent } from "./types.js"
import { validateCreate, ValidationError } from "./validate.js"
import { parseJournalKey, tokenMatches } from "./util.js"

const BASE = "/agent/v1"
const WS_SUBPROTOCOL = "kiln-agent-v1"

/**
 * The Session API (§6). JSON over HTTPS with a static bearer token;
 * `GET …/events` upgrades to WebSocket (browser auth rides a
 * `bearer.<base64url(token)>` subprotocol, since browsers can't set
 * headers on WebSocket) with an SSE fallback for header-capable clients.
 * `/healthz` is the only unauthenticated route.
 */
export function buildServer(config: Config, manager: SessionManager, driver: SandboxDriver) {
  const app = Fastify({
    logger: false, // §5.1: never log request bodies; log.ts handles the rest
    bodyLimit: 512 * 1024, // task (32k) + resume history (256k) + headroom
    trustProxy: true,
  })

  // -- auth -------------------------------------------------------------
  const failed401 = new Map<string, { count: number; resetAt: number }>()
  const authFailed = (ip: string): boolean => {
    const now = Date.now()
    const rec = failed401.get(ip)
    if (!rec || rec.resetAt < now) {
      failed401.set(ip, { count: 1, resetAt: now + 60_000 })
      return false
    }
    rec.count++
    return rec.count > 10
  }

  const authed = (req: FastifyRequest): boolean => {
    const header = req.headers.authorization
    if (!header?.startsWith("Bearer ")) return false
    return tokenMatches(header.slice(7).trim(), config.token)
  }

  app.addHook("onRequest", async (req, reply) => {
    if (req.url === "/healthz" || req.url === "/agent/healthz") return
    if (authed(req)) {
      const keyHeader = req.headers["x-kiln-journal-key"]
      if (typeof keyHeader === "string") {
        const key = parseJournalKey(keyHeader)
        if (key) manager.learnJournalKey(key)
      }
      return
    }
    if (authFailed(req.ip)) return reply.code(429).send({ error: "too many failed attempts" })
    return reply.code(401).send({ error: "unauthorised" })
  })

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    const status = err.statusCode ?? 500
    // §11: sanitised error classes only — no bodies, no stack traces to clients
    if (status >= 500) log("error", "request failed", { err: errClass(err) })
    void reply.code(status).send({ error: err.message ?? "internal error" })
  })

  // -- health ------------------------------------------------------------
  const healthz = async () => {
    const d = await driver.health()
    return {
      ok: d.ok && d.apiVersionOk !== false,
      driver: d,
      sessions: { live: manager.liveCount(), max: config.maxSessions },
      template: config.templateImage,
    }
  }
  app.get("/healthz", healthz)
  app.get("/agent/healthz", healthz)

  // -- sessions ------------------------------------------------------------
  app.post(`${BASE}/sessions`, async (req, reply) => {
    const health = await driver.health()
    if (!health.ok)
      throw Object.assign(new Error(`runner unavailable: ${health.detail ?? "driver unhealthy"}`), {
        statusCode: 503,
      })
    if (health.apiVersionOk === false)
      throw Object.assign(
        new Error(
          `sandboxd api_version ${health.apiVersion} does not match the pinned ${config.expectedApiVersion} — refusing new sessions (§12); diagnostics stay readable`,
        ),
        { statusCode: 503 },
      )
    const v = validateCreate(req.body, {
      idleTtlMinutes: config.idleTtlMinutes,
      hardTtlMinutes: config.hardTtlMinutes,
    })
    const s = manager.createSession(v)
    return reply.code(201).send({
      id: s.id,
      state: s.state,
      taskBranch: s.branch,
      events: `${BASE}/sessions/${s.id}/events`,
    })
  })

  app.get(`${BASE}/sessions`, async (req) => {
    const keyHeader = req.headers["x-kiln-journal-key"]
    const key = typeof keyHeader === "string" ? parseJournalKey(keyHeader) : null
    return { sessions: manager.list(key) }
  })

  const getSession = (req: FastifyRequest): SessionRecord => {
    const { id } = req.params as { id: string }
    const s = manager.get(id)
    if (!s) throw Object.assign(new Error("session not found"), { statusCode: 404 })
    return s
  }

  app.get(`${BASE}/sessions/:id`, async (req) => manager.summary(getSession(req)))

  app.post(`${BASE}/sessions/:id/input`, async (req) => {
    const s = getSession(req)
    const body = req.body as { type?: string; text?: string }
    if (body?.type !== "user_message" || typeof body.text !== "string" || !body.text.trim())
      throw new ValidationError('body must be {type:"user_message", text}')
    if (body.text.length > 32_000) throw new ValidationError("text too long (max 32000)")
    manager.input(s, body.text)
    return { ok: true }
  })

  app.post(`${BASE}/sessions/:id/cancel`, async (req) => {
    manager.cancel(getSession(req))
    return { ok: true }
  })

  app.post(`${BASE}/sessions/:id/finalise`, async (req) => {
    const s = getSession(req)
    await manager.finaliseNow(s)
    return manager.summary(s)
  })

  app.delete(`${BASE}/sessions/:id`, async (req) => {
    await manager.remove(getSession(req))
    return { ok: true }
  })

  // -- event stream: SSE fallback on the same route (WS upgrades never
  //    reach the route handler — see the 'upgrade' hook below) -------------
  app.get(`${BASE}/sessions/:id/events`, async (req, reply) => {
    const s = getSession(req)
    const after = parseAfter((req.query as { after?: string }).after)
    reply.hijack() // long-lived raw stream; Fastify must not touch the reply
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    })
    const send = (ev: AgentEvent) => reply.raw.write(`data: ${JSON.stringify(ev)}\n\n`)
    const { replay, missedBefore, detach } = manager.subscribe(s, after, send)
    if (missedBefore) send(syntheticGapWarning(missedBefore))
    for (const ev of replay) send(ev)
    const heartbeat = setInterval(() => reply.raw.write(":hb\n\n"), 25_000)
    req.raw.on("close", () => {
      clearInterval(heartbeat)
      detach()
    })
  })

  // -- WebSocket upgrade ---------------------------------------------------
  // The response must select the app subprotocol when the client offered
  // one (browsers abort otherwise — the token rides the second entry).
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) =>
      protocols.has(WS_SUBPROTOCOL) ? WS_SUBPROTOCOL : false,
  })
  app.server.on("upgrade", (req, socket, head) => {
    try {
      const url = new URL(req.url ?? "/", "http://internal")
      const m = url.pathname.match(new RegExp(`^${BASE}/sessions/([A-Za-z0-9_-]+)/events$`))
      if (!m) return destroySocket(socket, "404 Not Found")
      if (!wsAuthed(req.headers, config.token)) return destroySocket(socket, "401 Unauthorized")
      const s = manager.get(m[1]!)
      if (!s) return destroySocket(socket, "404 Not Found")
      const after = parseAfter(url.searchParams.get("after") ?? undefined)
      wss.handleUpgrade(req, socket, head, (ws) => attachWs(ws, s, after, manager))
    } catch (e) {
      log("warn", "ws upgrade failed", { err: errClass(e) })
      socket.destroy()
    }
  })

  return app
}

/* -------------------------------------------------------------- helpers ---- */

function parseAfter(v: string | undefined): number {
  const n = Number(v ?? 0)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

function syntheticGapWarning(oldestSeq: number): AgentEvent {
  // not buffered: informs this subscriber that the ring evicted its gap (§9)
  return {
    seq: 0,
    ts: Date.now(),
    type: "warning",
    payload: { message: "partial history: some earlier output was evicted", missedBefore: oldestSeq },
  }
}

function destroySocket(socket: import("node:stream").Duplex, status: string): void {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`)
  socket.destroy()
}

/**
 * Browser WebSockets can't set Authorization, so the token rides a
 * subprotocol: `kiln-agent-v1, bearer.<base64url(token)>`. Non-browser
 * clients (wscat, tests) may use the Authorization header instead.
 */
function wsAuthed(headers: import("node:http").IncomingHttpHeaders, expected: string): boolean {
  const auth = headers.authorization
  if (auth?.startsWith("Bearer ") && tokenMatches(auth.slice(7).trim(), expected)) return true
  const protocols = (headers["sec-websocket-protocol"] ?? "")
    .split(",")
    .map((p) => p.trim())
  for (const p of protocols) {
    if (!p.startsWith("bearer.")) continue
    try {
      const token = Buffer.from(p.slice(7), "base64url").toString("utf8")
      if (tokenMatches(token, expected)) return true
    } catch {
      /* malformed */
    }
  }
  return false
}

function attachWs(ws: WebSocket, s: SessionRecord, after: number, manager: SessionManager): void {
  // answer with the app subprotocol when offered (ws sets it from handleUpgrade)
  const send = (ev: AgentEvent) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(ev))
  }
  const { replay, missedBefore, detach } = manager.subscribe(s, after, send)
  if (missedBefore) send(syntheticGapWarning(missedBefore))
  for (const ev of replay) send(ev)
  const ping = setInterval(() => {
    if (ws.readyState === ws.OPEN) ws.ping()
  }, 30_000)
  ping.unref()
  ws.on("close", () => {
    clearInterval(ping)
    detach()
  })
  ws.on("error", () => {
    clearInterval(ping)
    detach()
  })
}
