/**
 * SandboxDriver — the only place that knows how to talk to the sbx daemon.
 *
 * sbx (Docker Sandboxes) exposes a plain HTTP+JSON API over a Unix domain
 * socket, so `http.request({ socketPath })` reaches it with no dependency.
 * That keeps this service under the same zero-dependency rule AGENTS.md
 * enforces for server/cloud.mjs.
 *
 * Everything uncertain about sbx lives here on purpose: the Phase 0 spike
 * (see the plan) answers questions about exec streaming, what `agent:"claude"`
 * does to the main process, and whether the workspace is passed through or
 * copied. Whatever it finds should change this file and nothing else.
 *
 * Env:
 *   KILN_SBX_SOCKET      daemon socket (default /run/sbx/sandboxd.sock)
 *   KILN_SBX_TOKEN_FILE  file holding the Docker OAuth bearer token
 *   KILN_SBX_TOKEN       the token itself (tests; takes precedence)
 */
import { request } from "node:http"
import { readFile } from "node:fs/promises"

const SOCKET = process.env.KILN_SBX_SOCKET ?? "/run/sbx/sandboxd.sock"
const TOKEN_FILE = process.env.KILN_SBX_TOKEN_FILE ?? ""

/** The daemon is unreachable or refusing work; the UI turns the feature off. */
export class SbxUnavailable extends Error {
  constructor(reason) {
    super(reason)
    this.name = "SbxUnavailable"
  }
}

let cachedToken = null
async function getToken() {
  if (process.env.KILN_SBX_TOKEN) return process.env.KILN_SBX_TOKEN
  if (cachedToken !== null) return cachedToken
  if (!TOKEN_FILE) return ""
  try {
    cachedToken = (await readFile(TOKEN_FILE, "utf8")).trim()
  } catch {
    cachedToken = ""
  }
  return cachedToken
}

/**
 * One request to the daemon. Returns {status, headers, body} with the body
 * buffered — every endpoint this driver uses is request/response. Streaming
 * exec is deliberately not modelled: see execStream below.
 */
async function call(method, path, body, { timeoutMs = 60_000 } = {}) {
  const token = await getToken()
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body))
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: SOCKET,
        method,
        path,
        headers: {
          accept: "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(payload
            ? {
                "content-type": "application/json",
                "content-length": payload.length,
              }
            : {}),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = []
        res.on("data", (c) => chunks.push(c))
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8")
          let parsed = null
          try {
            parsed = raw ? JSON.parse(raw) : null
          } catch {
            parsed = null
          }
          resolve({ status: res.statusCode ?? 0, raw, body: parsed })
        })
      },
    )
    req.on("timeout", () => req.destroy(new Error("sbx daemon timed out")))
    req.on("error", (e) =>
      // ENOENT/ECONNREFUSED here means the daemon isn't running, which is a
      // deployment state rather than a bug — say so plainly.
      reject(
        e.code === "ENOENT" || e.code === "ECONNREFUSED"
          ? new SbxUnavailable(
              `sbx daemon not reachable at ${SOCKET} (${e.code}) — is Docker Sandboxes running?`,
            )
          : e,
      ),
    )
    if (payload) req.write(payload)
    req.end()
  })
}

function expect(res, okStatuses, what) {
  if (okStatuses.includes(res.status)) return res.body
  const detail = res.body?.message || res.body?.error || res.raw?.slice(0, 200)
  if (res.status === 412)
    throw new SbxUnavailable(
      "sbx policy is not initialised — run `sbx policy setup` on the host",
    )
  throw new Error(`sbx ${what}: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`)
}

export const driver = {
  /**
   * Health doubles as the availability probe. It reports *why* it's down so
   * the client can say "sbx daemon unreachable" rather than silently hiding
   * the feature and looking broken.
   */
  async health() {
    try {
      const res = await call("GET", "/daemon/health", undefined, {
        timeoutMs: 5000,
      })
      if (res.status !== 200)
        return { ok: false, reason: `daemon health returned HTTP ${res.status}` }
      const info = await call("GET", "/daemon/info", undefined, {
        timeoutMs: 5000,
      })
      return {
        ok: true,
        version: info.body?.version ?? info.body?.Version ?? "unknown",
      }
    } catch (e) {
      return { ok: false, reason: e.message }
    }
  },

  /** 412 from POST /sandbox means policy was never initialised. */
  async policyReady() {
    const res = await call("GET", "/policy/setup", undefined, { timeoutMs: 5000 })
    return res.status === 200
  },

  async list() {
    const res = await call("GET", "/sandbox")
    return expect(res, [200], "list sandboxes") ?? []
  },

  async get(name) {
    const res = await call("GET", `/sandbox/${encodeURIComponent(name)}`)
    if (res.status === 404) return null
    return expect(res, [200], "get sandbox")
  },

  /**
   * `workspace` is an absolute host path; sbx mounts it at that same path
   * inside the VM. `env` carries only the bootstrap token — never the GitHub
   * PAT or a provider key, because create-time env is likely persisted to
   * daemon metadata on host disk (spike item 4). Real secrets go to
   * kiln-agent over its authenticated port instead.
   */
  async create({ name, workspace, env = {}, ports = [], networkPolicy = "balanced", kitRefs }) {
    const res = await call("POST", "/sandbox", {
      agent: process.env.KILN_SBX_AGENT ?? "claude",
      workspace,
      name,
      env,
      ports,
      network_policy: networkPolicy,
      allow_package_managers: true,
      ...(kitRefs?.length ? { kit_refs: kitRefs } : {}),
    })
    return expect(res, [200, 201], "create sandbox")
  },

  /** Short deterministic commands only. Long agent turns go over the port. */
  async exec(name, cmd, { workdir, env, timeoutMs = 120_000 } = {}) {
    const res = await call(
      "POST",
      `/sandbox/${encodeURIComponent(name)}/exec`,
      { cmd, ...(workdir ? { workdir } : {}), ...(env ? { env } : {}) },
      { timeoutMs },
    )
    if (res.status === 404) throw new Error(`sandbox ${name} is gone`)
    expect(res, [200], "exec")
    return res.raw
  },

  /**
   * Publish a port from the VM to the host, bound to loopback. Returns the
   * host port. Never bind to a routable interface: this port drives an agent
   * with a shell.
   */
  async publishPort(name, sandboxPort) {
    const res = await call("POST", `/sandbox/${encodeURIComponent(name)}/ports`, [
      { sandbox_port: String(sandboxPort), host_ip: "127.0.0.1", protocol: "tcp" },
    ])
    const mappings = expect(res, [200, 201], "publish port")
    const m = (Array.isArray(mappings) ? mappings : [mappings]).find(
      (x) => String(x.sandbox_port) === String(sandboxPort),
    )
    if (!m?.host_port) throw new Error("sbx published no host port")
    return Number(m.host_port)
  },

  async stop(name) {
    const res = await call("POST", `/sandbox/${encodeURIComponent(name)}/stop`)
    if (res.status === 404) return
    expect(res, [200, 204], "stop sandbox")
  },

  async remove(name) {
    const res = await call("DELETE", `/sandbox/${encodeURIComponent(name)}`)
    if (res.status === 404) return
    expect(res, [200, 204], "remove sandbox")
  },
}
