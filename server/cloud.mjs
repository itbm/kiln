/**
 * Kiln cloud runner — executes assistant turns server-side so closing the
 * app doesn't lose the reply.
 *
 * The phone POSTs a complete turn (wire messages, model, effort, tools and
 * the keys to run them) to /api/cloud/jobs. This process runs the same
 * round loop as src/lib/engine.ts — provider streaming plus tool execution
 * — and journals every event with a sequence number. Clients replay the
 * journal from 0 over SSE (/events) whether the turn is mid-flight or long
 * finished, so "catch up later" and "watch it live" are the same code path.
 *
 * Privacy posture, matching the rest of Kiln:
 *   - Everything lives in process memory. Nothing is written to disk.
 *   - API keys are dropped the moment the turn finishes; the journal is
 *     dropped when the phone collects it (DELETE) or after 24 h.
 *   - No request logging. Errors go to stderr without message content.
 *
 * The journal entry shapes mirror `TurnEvent` in src/lib/types.ts — change
 * them together. Provider parsing mirrors src/lib/providers/*.ts; when those
 * change, mirror the change here.
 *
 * Zero dependencies; Node 20+. Env:
 *   PORT                  listen port (default 8090)
 *   KILN_OPENROUTER_BASE  override https://openrouter.ai/api/v1 (tests)
 *   KILN_OLLAMA_BASE      override https://ollama.com (tests)
 *   KILN_TAVILY_BASE      override https://api.tavily.com (tests)
 */
import { createServer } from "node:http"
import { randomBytes } from "node:crypto"

const PORT = Number(process.env.PORT ?? 8090)
const OPENROUTER_BASE =
  process.env.KILN_OPENROUTER_BASE ?? "https://openrouter.ai/api/v1"
const OLLAMA_BASE = process.env.KILN_OLLAMA_BASE ?? "https://ollama.com"
const TAVILY_BASE = process.env.KILN_TAVILY_BASE ?? "https://api.tavily.com"

const MAX_TOOL_ROUNDS = 8
const MAX_TOOL_RESULT = 9000
const MAX_BODY_BYTES = 64 * 1024 * 1024
/** journal cap (chars of JSON) — image replies are big, prose never is */
const MAX_JOURNAL_CHARS = 32_000_000
/** collected or not, a finished job is dropped after this */
const DONE_TTL_MS = 24 * 60 * 60 * 1000
/** hard wall-clock cap on a single turn */
const RUN_CAP_MS = 45 * 60 * 1000
/** abort a provider stream that goes silent for this long */
const IDLE_CAP_MS = 300 * 1000
/** batch text/reasoning deltas into journal entries at most this often */
const FLUSH_MS = 150
const MAX_RUNNING = 16
const MAX_JOBS = 256

/** @typedef {{seq: number} & Record<string, unknown>} Entry */

/** jobs by id — the only state this process holds */
const jobs = new Map()

function makeJob(cfg) {
  const job = {
    id: randomBytes(18).toString("base64url"),
    createdAt: Date.now(),
    finishedAt: 0,
    status: "running", // running | done | stopped | error
    /** @type {Entry[]} */
    entries: [],
    journalChars: 0,
    // pending delta batch (text/reasoning), flushed on FLUSH_MS or type change
    pending: { t: null, x: "" },
    flushTimer: null,
    /** SSE responses currently tailing this job */
    waiters: new Set(),
    abort: new AbortController(),
    capTimer: null,
    /** request config incl. keys — deleted the moment the turn finishes */
    cfg,
  }
  job.capTimer = setTimeout(() => {
    job.abort.abort(new Error("Generation hit the 45-minute cloud limit"))
  }, RUN_CAP_MS)
  jobs.set(job.id, job)
  return job
}

/* ---------- journal ---------- */

function pushEntry(job, entry) {
  entry.seq = job.entries.length
  job.entries.push(entry)
  job.journalChars += JSON.stringify(entry).length
  if (job.journalChars > MAX_JOURNAL_CHARS && job.status === "running") {
    job.abort.abort(new Error("Reply exceeded the cloud runner's 32 MB cap"))
  }
  const frame = `data: ${JSON.stringify(entry)}\n\n`
  for (const res of job.waiters) if (!res.destroyed) res.write(frame)
}

function flushPending(job) {
  clearTimeout(job.flushTimer)
  job.flushTimer = null
  if (job.pending.t && job.pending.x) {
    const { t, x } = job.pending
    job.pending = { t: null, x: "" }
    pushEntry(job, { t, x })
  } else {
    job.pending = { t: null, x: "" }
  }
}

/** append a text/reasoning delta, batching consecutive same-type chunks */
function emitDelta(job, t, x) {
  if (!x) return
  if (job.pending.t && job.pending.t !== t) flushPending(job)
  job.pending.t = t
  job.pending.x += x
  if (!job.flushTimer)
    job.flushTimer = setTimeout(() => flushPending(job), FLUSH_MS)
}

/** append a non-delta entry (tool, usage, image, final) in order */
function emit(job, entry) {
  flushPending(job)
  pushEntry(job, entry)
}

function finishJob(job, final) {
  if (job.status !== "running") return
  emit(job, final)
  job.status = final.status
  job.finishedAt = Date.now()
  job.cfg = null // keys and conversation config go now; the journal stays
  clearTimeout(job.capTimer)
  clearTimeout(job.flushTimer)
  for (const res of job.waiters) res.end()
  job.waiters.clear()
}

/* ---------- provider streaming (mirrors src/lib/providers/*.ts) ---------- */

/** wire messages → OpenRouter/OpenAI chat format */
function openrouterMessages(messages) {
  return messages.map((m) => {
    if (m.role === "tool")
      return { role: "tool", tool_call_id: m.toolCallId, content: m.content }
    if (m.role === "assistant" && m.toolCalls?.length) {
      return {
        role: "assistant",
        content: m.content || null,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: c.args },
        })),
      }
    }
    const hasMedia = (m.images?.length ?? 0) + (m.files?.length ?? 0) > 0
    if (m.role === "user" && hasMedia) {
      const parts = []
      if (m.content) parts.push({ type: "text", text: m.content })
      for (const img of m.images ?? [])
        parts.push({ type: "image_url", image_url: { url: img } })
      for (const f of m.files ?? [])
        parts.push({
          type: "file",
          file: { filename: f.name, file_data: f.dataUrl },
        })
      return { role: "user", content: parts }
    }
    return { role: m.role, content: m.content }
  })
}

async function* streamOpenRouter(cfg, signal) {
  const body = {
    model: cfg.model,
    messages: openrouterMessages(cfg.messages),
    stream: true,
    usage: { include: true },
  }
  if (cfg.effort === "on") body.reasoning = { enabled: true }
  else if (cfg.effort === "off") body.reasoning = { enabled: false }
  else if (cfg.effort !== "auto") body.reasoning = { effort: cfg.effort }
  if (cfg.tools?.length) {
    body.tools = cfg.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }))
  }
  if (cfg.imageOutput) body.modalities = ["image", "text"]

  const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.keys.provider}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/itbm/mobile-ai-pwa",
      "X-Title": "Kiln",
    },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok || !res.body) {
    let msg = `HTTP ${res.status}`
    try {
      const j = await res.json()
      msg = j.error?.message ?? msg
    } catch {
      /* keep status */
    }
    throw new Error(msg)
  }

  const toolAcc = new Map()
  let finish
  let usage
  for await (const line of lines(res.body, signal)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith(":") || !trimmed.startsWith("data:"))
      continue
    const payload = trimmed.slice(5).trim()
    if (payload === "[DONE]") continue
    let json
    try {
      json = JSON.parse(payload)
    } catch {
      continue
    }
    if (json.error) throw new Error(json.error.message ?? "Provider error")
    if (json.usage) {
      const u = json.usage
      const upstream = u.cost_details?.upstream_inference_cost
      const cost =
        typeof u.cost === "number" || typeof upstream === "number"
          ? (u.cost ?? 0) + (upstream ?? 0)
          : undefined
      usage = {
        promptTokens: u.prompt_tokens ?? undefined,
        completionTokens: u.completion_tokens ?? undefined,
        reasoningTokens:
          u.completion_tokens_details?.reasoning_tokens || undefined,
        cachedTokens: u.prompt_tokens_details?.cached_tokens || undefined,
        cost,
      }
    }
    const choice = json.choices?.[0]
    if (!choice) continue
    const delta = choice.delta ?? {}
    if (typeof delta.reasoning === "string" && delta.reasoning)
      yield { type: "reasoning", text: delta.reasoning }
    if (typeof delta.content === "string" && delta.content)
      yield { type: "text", text: delta.content }
    for (const img of delta.images ?? []) {
      const url = img?.image_url?.url
      if (url) yield { type: "image", dataUrl: url }
    }
    for (const tc of delta.tool_calls ?? []) {
      const idx = tc.index ?? 0
      const acc = toolAcc.get(idx) ?? { id: "", name: "", args: "" }
      if (tc.id) acc.id = tc.id
      if (tc.function?.name) acc.name = tc.function.name
      if (tc.function?.arguments) acc.args += tc.function.arguments
      toolAcc.set(idx, acc)
    }
    if (choice.finish_reason) finish = choice.finish_reason
  }
  if (finish === "tool_calls" && toolAcc.size) {
    const calls = [...toolAcc.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, c]) => ({ id: c.id, name: c.name, args: c.args || "{}" }))
    yield { type: "tool_calls", calls }
  }
  yield { type: "done", finish, usage }
}

/** wire messages → Ollama /api/chat format */
function ollamaMessages(messages) {
  return messages.map((m) => {
    if (m.role === "tool")
      return { role: "tool", content: m.content, tool_name: m.toolName }
    const out = { role: m.role, content: m.content }
    if (m.images?.length)
      out.images = m.images.map((d) => d.slice(d.indexOf(",") + 1))
    if (m.role === "assistant" && m.toolCalls?.length) {
      out.tool_calls = m.toolCalls.map((c) => ({
        function: { name: c.name, arguments: safeParse(c.args) },
      }))
    }
    return out
  })
}

async function* streamOllama(cfg, signal) {
  // "/api/ollama" is the phone's same-origin relay — from here, go direct
  const base = (
    !cfg.ollamaBaseUrl || cfg.ollamaBaseUrl.startsWith("/")
      ? OLLAMA_BASE
      : cfg.ollamaBaseUrl
  ).replace(/\/$/, "")
  const headers = {
    ...(cfg.keys.provider
      ? { Authorization: `Bearer ${cfg.keys.provider}` }
      : {}),
    "Content-Type": "application/json",
  }
  const makeBody = (withThink) => {
    const body = {
      model: cfg.model,
      messages: ollamaMessages(cfg.messages),
      stream: true,
    }
    if (withThink && cfg.effort !== "auto") {
      body.think =
        cfg.effort === "on" ? true : cfg.effort === "off" ? false : cfg.effort
    }
    if (cfg.tools?.length) {
      body.tools = cfg.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }))
    }
    return JSON.stringify(body)
  }

  let res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers,
    body: makeBody(true),
    signal,
  })
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      const j = await res.json()
      msg = j.error ?? msg
    } catch {
      /* keep status */
    }
    if (res.status === 429) {
      const retryAfter = res.headers.get("retry-after")
      const wait =
        retryAfter && /^\d+$/.test(retryAfter)
          ? ` Try again in ~${Math.max(1, Math.ceil(parseInt(retryAfter) / 60))} min.`
          : ""
      throw new Error(
        `Ollama usage limit reached — your subscription's 5-hour or weekly cap is used up. It resets automatically; see ollama.com/settings/usage.${wait}`,
      )
    }
    // model may not support think levels — retry once without
    if (/think/i.test(msg) && cfg.effort !== "auto") {
      res = await fetch(`${base}/api/chat`, {
        method: "POST",
        headers,
        body: makeBody(false),
        signal,
      })
      if (!res.ok) throw new Error(msg)
    } else {
      throw new Error(msg)
    }
  }
  if (!res.body) throw new Error("No response body")

  let finish
  let usage
  for await (const line of lines(res.body, signal)) {
    if (!line.trim()) continue
    let json
    try {
      json = JSON.parse(line)
    } catch {
      continue
    }
    if (json.error) throw new Error(json.error)
    const msg = json.message ?? {}
    if (typeof msg.thinking === "string" && msg.thinking)
      yield { type: "reasoning", text: msg.thinking }
    if (typeof msg.content === "string" && msg.content)
      yield { type: "text", text: msg.content }
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      yield {
        type: "tool_calls",
        calls: msg.tool_calls.map((tc, i) => ({
          id: tc.id ?? `call_${Date.now()}_${i}`,
          name: tc.function?.name ?? "",
          args: JSON.stringify(tc.function?.arguments ?? {}),
        })),
      }
    }
    if (json.done) {
      finish = json.done_reason ?? "stop"
      if (json.prompt_eval_count || json.eval_count) {
        usage = {
          promptTokens: json.prompt_eval_count ?? undefined,
          completionTokens: json.eval_count ?? undefined,
          genMs: json.eval_duration
            ? Math.round(json.eval_duration / 1e6)
            : undefined,
        }
      }
    }
  }
  yield { type: "done", finish, usage }
}

/**
 * Split a body stream into lines, aborting if the provider goes silent —
 * a stalled upstream must not pin a job to its 45-minute cap. One watchdog
 * promise is raced against every read (fresh listeners per read would pile
 * up on the AbortSignal).
 */
async function* lines(body, signal) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  let idleTimer
  let failWatch
  const watchdog = new Promise((_, reject) => {
    failWatch = reject
  })
  watchdog.catch(() => {}) // only ever observed inside the race below
  const arm = () => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(
      () => failWatch(new Error("Provider stream stalled (no data for 5 minutes)")),
      IDLE_CAP_MS,
    )
  }
  const onAbort = () =>
    failWatch(
      signal.reason instanceof Error
        ? signal.reason
        : new DOMException("This operation was aborted", "AbortError"),
    )
  if (signal.aborted) onAbort()
  signal.addEventListener("abort", onAbort, { once: true })
  arm()
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), watchdog])
      if (done) break
      arm()
      buf += decoder.decode(value, { stream: true })
      const parts = buf.split("\n")
      buf = parts.pop() ?? ""
      for (const line of parts) yield line
    }
    if (buf) yield buf
  } finally {
    clearTimeout(idleTimer)
    signal.removeEventListener("abort", onAbort)
    reader.cancel().catch(() => {})
  }
}

function safeParse(s) {
  try {
    return JSON.parse(s || "{}")
  } catch {
    return {}
  }
}

/* ---------- tools (mirrors src/lib/tools.ts) ---------- */

async function executeTool(cfg, name, args, signal) {
  switch (name) {
    case "web_search":
      return webSearch(cfg, String(args.query ?? ""), signal)
    case "web_fetch":
      return webFetch(String(args.url ?? ""), signal)
    default:
      return `Unknown tool: ${name}`
  }
}

async function webSearch(cfg, query, signal) {
  if (!cfg.keys.tavily) return "Error: no Tavily API key configured in Settings."
  const res = await fetch(`${TAVILY_BASE}/search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.keys.tavily}`,
    },
    body: JSON.stringify({ query, max_results: 6, include_answer: "basic" }),
    signal: withTimeout(signal, 30_000),
  })
  if (!res.ok) return `Search failed: HTTP ${res.status}`
  const json = await res.json()
  let out = ""
  if (json.answer) out += `Summary: ${json.answer}\n\n`
  out += "Results:\n"
  for (const r of json.results ?? []) {
    out += `- ${r.title}\n  ${r.url}\n  ${String(r.content ?? "").slice(0, 400)}\n`
  }
  return out.slice(0, MAX_TOOL_RESULT)
}

async function webFetch(url, signal) {
  if (!/^https?:\/\//i.test(url)) return "Error: URL must start with http(s)://"
  // r.jina.ai converts pages to clean markdown; here it's for the markdown,
  // not CORS (the server has no such constraint)
  try {
    const res = await fetch(`https://r.jina.ai/${url}`, {
      headers: { Accept: "text/plain" },
      signal: withTimeout(signal, 25_000),
    })
    if (res.ok) {
      const text = await res.text()
      if (text.trim()) return truncate(text)
    }
  } catch {
    /* fall through to direct fetch */
  }
  try {
    const res = await fetch(url, { signal: withTimeout(signal, 15_000) })
    if (!res.ok) return `Fetch failed: HTTP ${res.status}`
    return truncate(stripHtml(await res.text()))
  } catch (e) {
    return `Fetch failed: ${e instanceof Error ? e.message : "network error"}`
  }
}

function truncate(text) {
  return text.length > MAX_TOOL_RESULT
    ? text.slice(0, MAX_TOOL_RESULT) + "\n…[truncated]"
    : text
}

/** no DOM here — a regex strip is enough for tool-result text */
function stripHtml(html) {
  return html
    .replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function withTimeout(signal, ms) {
  return AbortSignal.any([signal, AbortSignal.timeout(ms)])
}

/* ---------- the turn loop (mirrors runLocalRounds in src/lib/engine.ts) ---------- */

async function runJob(job) {
  const cfg = job.cfg
  const signal = job.abort.signal
  let reasoningStart = 0
  let reasoningMs
  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      let toolCalls = []
      let roundUsage
      let roundGenStart = 0
      let content = ""
      const stream =
        cfg.provider === "openrouter"
          ? streamOpenRouter(cfg, signal)
          : streamOllama(cfg, signal)
      for await (const ev of stream) {
        if (ev.type === "reasoning") {
          if (!roundGenStart) roundGenStart = Date.now()
          if (!reasoningStart) reasoningStart = Date.now()
          emitDelta(job, "reasoning", ev.text)
        } else if (ev.type === "text") {
          if (!roundGenStart) roundGenStart = Date.now()
          if (reasoningStart && reasoningMs === undefined)
            reasoningMs = Date.now() - reasoningStart
          content += ev.text
          emitDelta(job, "text", ev.text)
        } else if (ev.type === "image") {
          if (!roundGenStart) roundGenStart = Date.now()
          emit(job, { t: "image", dataUrl: ev.dataUrl })
        } else if (ev.type === "tool_calls") {
          toolCalls = ev.calls
        } else if (ev.type === "done" && ev.usage) {
          roundUsage = ev.usage
        }
      }
      if (roundUsage) {
        if (roundUsage.genMs === undefined && roundGenStart)
          roundUsage.genMs = Date.now() - roundGenStart
        emit(job, { t: "usage", usage: roundUsage })
      }
      if (!toolCalls.length) break

      // record the tool-call turn, run the tools, feed results back
      cfg.messages.push({ role: "assistant", content, toolCalls })
      for (const call of toolCalls) {
        const args = safeParse(call.args)
        emit(job, { t: "tool", id: call.id, name: call.name, args })
        try {
          const result = await executeTool(cfg, call.name, args, signal)
          emit(job, { t: "tool_result", id: call.id, result, ok: true })
          cfg.messages.push({
            role: "tool",
            content: result,
            toolCallId: call.id,
            toolName: call.name,
          })
        } catch (e) {
          const m = e instanceof Error ? e.message : "Tool failed"
          emit(job, { t: "tool_result", id: call.id, result: m, ok: false })
          cfg.messages.push({
            role: "tool",
            content: `Error: ${m}`,
            toolCallId: call.id,
            toolName: call.name,
          })
        }
      }
    }
    if (reasoningStart && reasoningMs === undefined)
      reasoningMs = Date.now() - reasoningStart
    finishJob(job, { t: "final", status: "done", reasoningMs })
  } catch (e) {
    if (reasoningStart && reasoningMs === undefined)
      reasoningMs = Date.now() - reasoningStart
    if (signal.aborted && signal.reason === "stopped") {
      finishJob(job, { t: "final", status: "stopped", reasoningMs })
    } else {
      const error = signal.aborted
        ? String(
            (signal.reason instanceof Error && signal.reason.message) ||
              (e instanceof Error ? e.message : e),
          )
        : e instanceof Error
          ? e.message
          : String(e)
      finishJob(job, { t: "final", status: "error", error, reasoningMs })
      console.error(`[kiln-cloud] job failed: ${error.slice(0, 200)}`)
    }
  }
}

/* ---------- housekeeping ---------- */

setInterval(() => {
  const now = Date.now()
  for (const [id, job] of jobs) {
    if (job.finishedAt && now - job.finishedAt > DONE_TTL_MS) jobs.delete(id)
    else if (!job.finishedAt && now - job.createdAt > RUN_CAP_MS + 60_000)
      job.abort.abort(new Error("Generation hit the 45-minute cloud limit"))
  }
  if (jobs.size > MAX_JOBS) {
    const finished = [...jobs.values()]
      .filter((j) => j.finishedAt)
      .sort((a, b) => a.finishedAt - b.finishedAt)
    for (const j of finished.slice(0, jobs.size - MAX_JOBS)) jobs.delete(j.id)
  }
}, 60_000).unref()

/* ---------- HTTP ---------- */

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on("data", (c) => {
      size += c.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Body too large"))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on("end", () => resolve(Buffer.concat(chunks)))
    req.on("error", reject)
  })
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  })
  res.end(body)
}

/** minimal shape check — the phone is the only intended client, but still */
function validateJobRequest(body) {
  if (typeof body !== "object" || body === null) return "not an object"
  if (body.provider !== "openrouter" && body.provider !== "ollama")
    return "unknown provider"
  if (typeof body.model !== "string" || !body.model) return "missing model"
  if (typeof body.effort !== "string") return "missing effort"
  if (!Array.isArray(body.messages) || body.messages.length === 0)
    return "missing messages"
  if (body.messages.length > 4000) return "too many messages"
  if (body.provider === "openrouter" && !body.keys?.provider)
    return "missing OpenRouter key"
  if (body.tools !== undefined && !Array.isArray(body.tools))
    return "tools must be an array"
  return null
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost")
    const path = url.pathname

    if (req.method === "GET" && path === "/api/cloud/health") {
      return sendJson(res, 200, { ok: true, jobs: jobs.size })
    }

    if (req.method === "POST" && path === "/api/cloud/jobs") {
      const running = [...jobs.values()].filter((j) => !j.finishedAt).length
      if (running >= MAX_RUNNING)
        return sendJson(res, 429, {
          error: `The cloud runner is already generating ${running} replies — try again in a moment`,
        })
      let body
      try {
        body = JSON.parse((await readBody(req)).toString("utf8"))
      } catch (e) {
        return sendJson(res, 400, {
          error:
            e instanceof Error && /large/i.test(e.message)
              ? "Request too large for the cloud runner (64 MB cap)"
              : "Invalid JSON",
        })
      }
      const invalid = validateJobRequest(body)
      if (invalid) return sendJson(res, 400, { error: `Bad request: ${invalid}` })
      const job = makeJob({
        provider: body.provider,
        model: body.model,
        effort: body.effort,
        messages: body.messages,
        tools: Array.isArray(body.tools) && body.tools.length ? body.tools : undefined,
        imageOutput: !!body.imageOutput,
        ollamaBaseUrl:
          typeof body.ollamaBaseUrl === "string" ? body.ollamaBaseUrl : "",
        keys: {
          provider:
            typeof body.keys?.provider === "string" ? body.keys.provider : "",
          tavily:
            typeof body.keys?.tavily === "string" ? body.keys.tavily : "",
        },
      })
      void runJob(job)
      return sendJson(res, 201, { id: job.id })
    }

    const m = /^\/api\/cloud\/jobs\/([A-Za-z0-9_-]{10,64})(\/events|\/stop)?$/.exec(
      path,
    )
    if (m) {
      const job = jobs.get(m[1])

      if (req.method === "GET" && m[2] === "/events") {
        if (!job) return sendJson(res, 404, { error: "No such job" })
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          "x-accel-buffering": "no",
          connection: "keep-alive",
        })
        res.write(": kiln-cloud\n\n")
        const from = Math.max(0, parseInt(url.searchParams.get("from") ?? "0") || 0)
        for (let i = from; i < job.entries.length; i++)
          res.write(`data: ${JSON.stringify(job.entries[i])}\n\n`)
        if (job.status !== "running") return res.end()
        job.waiters.add(res)
        res.on("error", () => {}) // a vanished client is not our problem
        const heartbeat = setInterval(() => {
          if (!res.destroyed) res.write(": hb\n\n")
        }, 15_000)
        req.on("close", () => {
          clearInterval(heartbeat)
          job.waiters.delete(res)
        })
        res.on("close", () => clearInterval(heartbeat))
        return
      }

      if (req.method === "POST" && m[2] === "/stop") {
        // stopping an already-finished job is a fine no-op — the client
        // may race the natural end of the stream
        if (job && job.status === "running") job.abort.abort("stopped")
        return sendJson(res, 200, { ok: true })
      }

      if (req.method === "DELETE" && !m[2]) {
        if (job) {
          if (job.status === "running") job.abort.abort("stopped")
          jobs.delete(job.id)
        }
        res.writeHead(204)
        return res.end()
      }
    }

    sendJson(res, 404, { error: "Not found" })
  } catch (e) {
    console.error(
      `[kiln-cloud] request error: ${e instanceof Error ? e.message : e}`,
    )
    if (!res.headersSent) sendJson(res, 500, { error: "Internal error" })
    else res.end()
  }
})

server.listen(PORT, () => {
  console.log(`[kiln-cloud] turn runner listening on :${PORT} (memory-only)`)
})
