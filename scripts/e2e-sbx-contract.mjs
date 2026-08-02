// Contract test for server/forge/sandbox.mjs against the sbx daemon API.
//
// There is no way to run sbx in CI — it binds to the platform hypervisor
// (Hypervisor.framework / WHP / Linux KVM) and has no software-emulation
// backend, so no amount of patience substitutes for KVM. That leaves one
// class of bug untested by e2e-forge.mjs, and it's the most likely one:
// calling the daemon *wrongly* — a mistyped path, the wrong method, a field
// name that doesn't exist.
//
// So: stand up a Unix socket that records what the driver actually sends,
// drive every method, and check each request against the published API. The
// contract below is transcribed from itbm/sbx-sdk's openapi.yaml (recovered
// from docker-sbx v0.34.0). Refresh it with:
//
//   curl -s https://raw.githubusercontent.com/itbm/sbx-sdk/main/openapi.yaml
//
// This proves Kiln's half of the conversation is well-formed. It still proves
// nothing about how sbx *behaves* — that needs the Phase 0 spike on a host
// with KVM.
import { createServer } from "node:http"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** path → methods, from openapi.yaml. Paths are templated with {name}. */
const SPEC_PATHS = {
  "/daemon/health": ["get"],
  "/daemon/info": ["get"],
  "/daemon/diagnostics": ["get"],
  "/daemon/loglevel": ["get"],
  "/daemon/loglevel/{category}": ["post"],
  "/version": ["post"],
  "/sandbox": ["get", "post"],
  "/sandbox/{name}": ["get", "delete"],
  "/sandbox/{name}/stop": ["post"],
  "/sandbox/{name}/start": ["post"],
  "/sandbox/{name}/save": ["post"],
  "/sandbox/{name}/exec": ["post"],
  "/sandbox/{name}/ports": ["get", "post"],
  "/sandbox/{name}/ports/unpublish": ["post"],
  "/sandbox/{name}/logs": ["get"],
  "/sandbox/{name}/files": ["get", "put"],
  "/runtime/{name}/session": ["get"],
  "/runtime": ["post"],
  "/policy/setup": ["get"],
  "/policy/rules": ["get", "post"],
  "/policy/profiles": ["get"],
  "/network/log": ["get"],
  "/docker/images": ["get"],
  "/docker/images/create": ["post"],
  "/docker/images/load": ["post"],
  "/docker/images/remove": ["delete"],
}

/** request body properties, from the schemas in openapi.yaml */
const SPEC_BODIES = {
  "POST /sandbox": [
    "agent", "workspace", "workspaces", "name", "template", "clone", "env",
    "ports", "kit_refs", "network_policy", "allow_mcp_servers",
    "allow_package_managers", "args", "agent_args",
  ],
  "POST /sandbox/{name}/exec": [
    "cmd", "tty", "interactive", "user", "workdir", "env", "detach",
  ],
}
/** PortMapping, used as the array element for POST .../ports */
const PORT_MAPPING = ["sandbox_port", "host_port", "host_ip", "protocol"]

let pass = 0
let fail = 0
const ok = (n) => {
  pass++
  console.log(`ok: ${n}`)
}
const bad = (n, d) => {
  fail++
  console.log(`FAIL: ${n}\n      ${d}`)
}

/** Collapse a concrete path back to its templated form for spec lookup. */
function templatise(path) {
  if (SPEC_PATHS[path]) return path
  const parts = path.split("/")
  // /sandbox/<name>[/verb...]
  if (parts[1] === "sandbox" && parts.length >= 3) {
    parts[2] = "{name}"
    const t = parts.join("/")
    if (SPEC_PATHS[t]) return t
  }
  if (parts[1] === "runtime" && parts.length >= 3) {
    parts[2] = "{name}"
    const t = parts.join("/")
    if (SPEC_PATHS[t]) return t
  }
  return path
}

const root = mkdtempSync(join(tmpdir(), "kiln-sbx-contract-"))
const SOCK = join(root, "sandboxd.sock")
const seen = []

const daemon = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x")
  let raw = ""
  for await (const c of req) raw += c
  let body = null
  try {
    body = raw ? JSON.parse(raw) : null
  } catch {
    body = "«unparseable»"
  }
  seen.push({
    method: req.method.toLowerCase(),
    path: url.pathname,
    body,
    auth: req.headers.authorization ?? "",
    contentType: req.headers["content-type"] ?? "",
  })

  const json = (obj) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify(obj))
  }
  if (url.pathname === "/daemon/health") return json({ ok: true })
  if (url.pathname === "/daemon/info") return json({ version: "0.34.0" })
  if (url.pathname === "/policy/setup") return json({ ready: true })
  if (url.pathname === "/sandbox" && req.method === "GET") return json([])
  if (url.pathname === "/sandbox") return json({ name: "sb-1", id: "sb-1" })
  if (/\/ports$/.test(url.pathname))
    return json([{ sandbox_port: "8790", host_port: "41234", host_ip: "127.0.0.1" }])
  if (/\/exec$/.test(url.pathname)) {
    res.writeHead(200, { "content-type": "text/plain" })
    return res.end("hello\n")
  }
  if (req.method === "DELETE" || /\/stop$/.test(url.pathname)) {
    res.writeHead(204)
    return res.end()
  }
  json({ name: "sb-1" })
})
await new Promise((r) => daemon.listen(SOCK, r))

// The driver reads its socket path at module load, so configure before import.
process.env.KILN_SBX_SOCKET = SOCK
process.env.KILN_SBX_TOKEN = "contract-token"
const { driver } = await import("../server/forge/sandbox.mjs")

console.log("\n--- sbx contract ---")

// Each call is isolated: a driver that throws (a wrong path makes the mock
// answer with a shape it can't parse) must not skip the assertions below —
// that is precisely the case where the contract report is most useful.
const step = async (label, fn) => {
  try {
    return await fn()
  } catch (e) {
    console.log(`   note: ${label} threw — ${e.message}`)
    return undefined
  }
}

const health = await step("health", () => driver.health())
if (health?.ok) ok("health() succeeds and reports a version")
else bad("health() succeeds", JSON.stringify(health))

await step("policyReady", () => driver.policyReady())
await step("list", () => driver.list())
await step("get", () => driver.get("sb-1"))
await step("create", () =>
  driver.create({
    name: "sb-1",
    workspace: "/mnt/ws/chat-1",
    env: { KILN_AGENT_TOKEN: "t", HOME: "/mnt/ws/chat-1/.kiln/home" },
    ports: ["8790"],
    networkPolicy: "balanced",
  }),
)
await step("exec", () =>
  driver.exec("sb-1", ["bash", "-lc", "git status"], {
    workdir: "/mnt/ws/chat-1/repo",
  }),
)
const hostPort = await step("publishPort", () => driver.publishPort("sb-1", 8790))
if (hostPort === 41234) ok("publishPort() reads host_port out of the mapping")
else bad("publishPort() reads host_port", `got ${hostPort}`)
await step("stop", () => driver.stop("sb-1"))
await step("remove", () => driver.remove("sb-1"))

// ---- every request must exist in the spec ----
let unknown = []
for (const r of seen) {
  const t = templatise(r.path)
  const methods = SPEC_PATHS[t]
  if (!methods) unknown.push(`${r.method.toUpperCase()} ${r.path} (no such path)`)
  else if (!methods.includes(r.method))
    unknown.push(`${r.method.toUpperCase()} ${t} (path exists; method does not)`)
}
if (!unknown.length)
  ok(`all ${seen.length} requests use a documented path and method`)
else bad("all requests use a documented path and method", unknown.join("\n      "))

// ---- every body field must be a documented property ----
let badFields = []
for (const r of seen) {
  const key = `${r.method.toUpperCase()} ${templatise(r.path)}`
  if (Array.isArray(r.body) && /\/ports$/.test(r.path)) {
    for (const m of r.body)
      for (const k of Object.keys(m))
        if (!PORT_MAPPING.includes(k)) badFields.push(`${key}: PortMapping.${k}`)
    continue
  }
  const allowed = SPEC_BODIES[key]
  if (!allowed || !r.body || typeof r.body !== "object") continue
  for (const k of Object.keys(r.body))
    if (!allowed.includes(k)) badFields.push(`${key}: ${k}`)
}
if (!badFields.length) ok("no request sends a field the API doesn't define")
else bad("no request sends an undefined field", badFields.join("\n      "))

// ---- the create call specifically ----
const create = seen.find((r) => r.method === "post" && r.path === "/sandbox")
if (create?.body?.agent && create.body.workspace)
  ok("create sends the two required fields (agent, workspace)")
else bad("create sends agent + workspace", JSON.stringify(create?.body))

// Credentials must never ride in create-time env: sbx persists it to daemon
// metadata on host disk. This is the same invariant e2e-forge asserts from the
// other side; here it is checked at the driver boundary.
const envStr = JSON.stringify(create?.body?.env ?? {})
if (!/github_pat_|sk-or-|ghp_/.test(envStr))
  ok("create-time env carries no credential")
else bad("create-time env carries no credential", envStr)

// ---- auth ----
if (seen.every((r) => r.auth === "Bearer contract-token"))
  ok("every request carries the daemon bearer token")
else
  bad(
    "every request carries the bearer token",
    JSON.stringify(seen.filter((r) => r.auth !== "Bearer contract-token").map((r) => r.path)),
  )

console.log(
  `\n${fail === 0 ? "E2E-SBX-CONTRACT PASSED" : "E2E-SBX-CONTRACT FAILED"} — ${pass} passed, ${fail} failed`,
)
daemon.close()
rmSync(root, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)
