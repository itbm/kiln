import type {
  ChatRequest,
  ModelInfo,
  StreamEvent,
  Usage,
  WireMessage,
} from "@/lib/types"
import { cleanKey, dataUrlToBase64, uid } from "@/lib/utils"
import { getSettings } from "@/stores/settings"

function base(): string {
  return (getSettings().ollamaBaseUrl || "https://ollama.com").replace(
    /\/$/,
    "",
  )
}

function headers(): Record<string, string> {
  // a keyless LAN Ollama is a legitimate setup — omit the header rather
  // than send an empty bearer
  const key = cleanKey(getSettings().ollamaKey)
  return {
    ...(key ? { Authorization: `Bearer ${key}` } : {}),
    "Content-Type": "application/json",
  }
}

export async function checkOllamaKey(
  key: string,
  baseUrl: string,
): Promise<string> {
  const k = cleanKey(key)
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/tags`, {
    headers: k ? { Authorization: `Bearer ${k}` } : {},
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = await res.json()
  return `${json.models?.length ?? 0} models available`
}

export async function fetchOllamaModels(): Promise<ModelInfo[]> {
  const res = await fetch(`${base()}/api/tags`, { headers: headers() })
  if (!res.ok) throw new Error(`Ollama models: HTTP ${res.status}`)
  const json = await res.json()
  const names: string[] = (json.models ?? []).map((m: any) => m.name ?? m.model)

  // /api/show gives accurate capability flags; fall back to heuristics.
  // Ollama's API doesn't report think *levels* — only gpt-oss models take
  // low/medium/high; other thinking models are on/off via `think: bool`.
  const applyThinking = (info: ModelInfo, thinking: boolean) => {
    info.reasoning = thinking
    if (!thinking) return
    if (/gpt-oss/i.test(info.id)) {
      info.efforts = ["high", "medium", "low"]
      info.defaultEffort = "medium"
    } else {
      info.reasoningToggle = true
    }
  }
  const models = await Promise.all(
    names.map(async (name): Promise<ModelInfo> => {
      const info: ModelInfo = {
        id: name,
        provider: "ollama",
        name,
        vision: /vision|llava|vl|gemma3|mistral-small/i.test(name),
        tools: true,
      }
      applyThinking(
        info,
        /gpt-oss|deepseek|qwen3|thinking|r1|magistral/i.test(name),
      )
      try {
        const res = await fetch(`${base()}/api/show`, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ model: name }),
        })
        if (res.ok) {
          const detail = await res.json()
          const caps: string[] = detail.capabilities ?? []
          if (caps.length) {
            info.vision = caps.includes("vision")
            info.tools = caps.includes("tools")
            info.efforts = undefined
            info.reasoningToggle = undefined
            applyThinking(info, caps.includes("thinking"))
          }
          const ctx = detail.model_info?.[
            Object.keys(detail.model_info ?? {}).find((k) =>
              k.endsWith("context_length"),
            ) ?? ""
          ]
          if (typeof ctx === "number") info.ctx = ctx
        }
      } catch {
        /* heuristics already applied */
      }
      return info
    }),
  )
  return models.sort((a, b) => a.id.localeCompare(b.id))
}

function toApiMessages(messages: WireMessage[]): any[] {
  return messages.map((m) => {
    if (m.role === "tool")
      return { role: "tool", content: m.content, tool_name: m.toolName }
    const out: any = { role: m.role, content: m.content }
    if (m.images?.length) out.images = m.images.map(dataUrlToBase64)
    if (m.role === "assistant" && m.toolCalls?.length) {
      out.tool_calls = m.toolCalls.map((c) => ({
        function: {
          name: c.name,
          arguments: JSON.parse(c.args || "{}"),
        },
      }))
    }
    return out
  })
}

/** Streams chat from Ollama's native /api/chat (NDJSON) as unified StreamEvents. */
export async function* streamOllama(
  req: ChatRequest,
): AsyncGenerator<StreamEvent> {
  const makeBody = (withThink: boolean): string => {
    const body: any = {
      model: req.model,
      messages: toApiMessages(req.messages),
      stream: true,
    }
    if (withThink && req.effort !== "auto") {
      body.think =
        req.effort === "on" ? true : req.effort === "off" ? false : req.effort
    }
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({
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

  let res = await fetch(`${base()}/api/chat`, {
    method: "POST",
    headers: headers(),
    body: makeBody(true),
    signal: req.signal,
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
      // Subscription caps (5-hour / weekly). No usage API exists yet
      // (ollama/ollama#15132) — the best we can do is explain clearly.
      const retryAfter = res.headers.get("retry-after")
      const wait =
        retryAfter && /^\d+$/.test(retryAfter)
          ? ` Try again in ~${Math.max(1, Math.ceil(parseInt(retryAfter) / 60))} min.`
          : ""
      throw new Error(
        `Ollama usage limit reached — your subscription's 5-hour or weekly cap is used up. It resets automatically; see ollama.com/settings/usage.${wait}`,
      )
    }
    // Model may not support think levels — retry once without.
    if (/think/i.test(msg) && req.effort !== "auto") {
      res = await fetch(`${base()}/api/chat`, {
        method: "POST",
        headers: headers(),
        body: makeBody(false),
        signal: req.signal,
      })
      if (!res.ok) throw new Error(msg)
    } else {
      throw new Error(msg)
    }
  }
  if (!res.body) throw new Error("No response body")

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  let finish: string | undefined
  let usage: Usage | undefined

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split("\n")
    buf = lines.pop() ?? ""
    for (const line of lines) {
      if (!line.trim()) continue
      let json: any
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
          calls: msg.tool_calls.map((tc: any) => ({
            id: tc.id ?? uid(),
            name: tc.function?.name ?? "",
            args: JSON.stringify(tc.function?.arguments ?? {}),
          })),
        }
      }
      if (json.done) {
        finish = json.done_reason ?? "stop"
        // the closing object carries eval counts (tokens) and durations (ns)
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
  }
  yield { type: "done", finish, usage }
}
