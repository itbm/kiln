import type {
  ChatRequest,
  ModelInfo,
  StreamEvent,
  Usage,
  WireMessage,
  WireToolCall,
} from "@/lib/types"
import { getSettings } from "@/stores/settings"
import { cleanKey } from "@/lib/utils"

const BASE = "https://openrouter.ai/api/v1"

function headers(): Record<string, string> {
  const key = cleanKey(getSettings().openrouterKey)
  // never send an empty bearer: OpenRouter answers it with a baffling
  // "Missing Authentication header" 401 — fail with a useful message instead
  if (!key)
    throw new Error(
      "No OpenRouter API key configured — add one in Settings → Providers",
    )
  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    "HTTP-Referer": "https://github.com/itbm/mobile-ai-pwa",
    "X-Title": "Kiln",
  }
}

export async function fetchOpenRouterModels(): Promise<ModelInfo[]> {
  const res = await fetch(`${BASE}/models`)
  if (!res.ok) throw new Error(`OpenRouter models: HTTP ${res.status}`)
  const json = await res.json()
  const models: ModelInfo[] = (json.data ?? []).map((m: any): ModelInfo => {
    const sp: string[] = m.supported_parameters ?? []
    const inMods: string[] = m.architecture?.input_modalities ?? []
    const outMods: string[] = m.architecture?.output_modalities ?? []
    // per-model reasoning metadata: supported_efforts / mandatory / defaults
    const r = m.reasoning ?? null
    return {
      id: m.id,
      provider: "openrouter",
      name: m.name?.replace(/^.*?: /, "") ?? m.id,
      ctx: m.context_length ?? undefined,
      vision: inMods.includes("image"),
      imageOutput: outMods.includes("image"),
      reasoning: !!r || sp.includes("reasoning"),
      efforts: r?.supported_efforts?.length ? r.supported_efforts : undefined,
      reasoningToggle:
        !!r && !r.supported_efforts?.length && r.mandatory === false,
      defaultEffort: r?.default_effort ?? undefined,
      tools: sp.includes("tools"),
      pricing: m.pricing
        ? {
            prompt: parseFloat(m.pricing.prompt) * 1e6 || 0,
            completion: parseFloat(m.pricing.completion) * 1e6 || 0,
          }
        : undefined,
    }
  })
  return models.sort((a, b) => a.id.localeCompare(b.id))
}

export async function checkOpenRouterKey(key: string): Promise<string> {
  const k = cleanKey(key)
  if (!k)
    throw new Error(
      "the field only holds whitespace or invisible characters — copy the key from openrouter.ai again",
    )
  // GET /key is the documented key-info endpoint (/auth/key is legacy)
  const res = await fetch(`${BASE}/key`, {
    headers: { Authorization: `Bearer ${k}` },
  })
  if (!res.ok) {
    let msg = `Invalid key (HTTP ${res.status})`
    try {
      const j = await res.json()
      if (j.error?.message) msg = `${j.error.message} (HTTP ${res.status})`
    } catch {
      /* keep generic message */
    }
    // "User not found." = the header parsed but the key isn't one
    // OpenRouter currently knows: an incomplete copy, or a brand-new key
    // that hasn't activated at their edge yet
    if (/user not found/i.test(msg))
      msg +=
        " — OpenRouter doesn't recognise this key: check the whole key was copied; brand-new keys can take a moment to activate"
    // say what was actually sent, so an unparseable-token 401 ("Missing
    // Authentication header") is diagnosable from the toast alone
    throw new Error(`${msg} — tested key “${k.slice(0, 9)}…”, ${k.length} chars`)
  }
  const json = await res.json()
  return json.data?.label ?? "OK"
}

function toApiMessages(messages: WireMessage[]): any[] {
  return messages.map((m) => {
    if (m.role === "tool") {
      return { role: "tool", tool_call_id: m.toolCallId, content: m.content }
    }
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
      const parts: any[] = []
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

/** Streams chat completions from OpenRouter as unified StreamEvents. */
export async function* streamOpenRouter(
  req: ChatRequest,
): AsyncGenerator<StreamEvent> {
  const body: any = {
    model: req.model,
    messages: toApiMessages(req.messages),
    stream: true,
    // usage accounting: the final stream chunk reports real token counts
    // and the credits actually charged
    usage: { include: true },
  }
  if (req.effort === "on") body.reasoning = { enabled: true }
  else if (req.effort === "off") body.reasoning = { enabled: false }
  else if (req.effort !== "auto") body.reasoning = { effort: req.effort }
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
  if (req.imageOutput) body.modalities = ["image", "text"]

  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
    signal: req.signal,
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

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  const toolAcc = new Map<number, { id: string; name: string; args: string }>()
  let finish: string | undefined
  let usage: Usage | undefined

  const flushToolCalls = (): WireToolCall[] =>
    [...toolAcc.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, c]) => ({ id: c.id, name: c.name, args: c.args || "{}" }))

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split("\n")
    buf = lines.pop() ?? ""
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith(":")) continue
      if (!trimmed.startsWith("data:")) continue
      const payload = trimmed.slice(5).trim()
      if (payload === "[DONE]") continue
      let json: any
      try {
        json = JSON.parse(payload)
      } catch {
        continue
      }
      if (json.error) throw new Error(json.error.message ?? "Provider error")
      // usage rides on the last chunk, whose choices array may be empty —
      // grab it before the choice guard below
      if (json.usage) {
        const u = json.usage
        // BYOK requests split billing: `cost` is OpenRouter's fee, the
        // upstream provider's charge sits in cost_details
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
  }

  if (finish === "tool_calls" && toolAcc.size)
    yield { type: "tool_calls", calls: flushToolCalls() }
  yield { type: "done", finish, usage }
}
