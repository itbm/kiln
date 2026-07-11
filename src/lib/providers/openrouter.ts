import type {
  ChatRequest,
  ModelInfo,
  StreamEvent,
  WireMessage,
  WireToolCall,
} from "@/lib/types"
import { getSettings } from "@/stores/settings"

const BASE = "https://openrouter.ai/api/v1"

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${getSettings().openrouterKey}`,
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
    return {
      id: m.id,
      provider: "openrouter",
      name: m.name?.replace(/^.*?: /, "") ?? m.id,
      ctx: m.context_length ?? undefined,
      vision: inMods.includes("image"),
      imageOutput: outMods.includes("image"),
      reasoning: sp.includes("reasoning"),
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
  const res = await fetch(`${BASE}/auth/key`, {
    headers: { Authorization: `Bearer ${key}` },
  })
  if (!res.ok) throw new Error(`Invalid key (HTTP ${res.status})`)
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
  }
  if (req.effort !== "auto") body.reasoning = { effort: req.effort }
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
  yield { type: "done", finish }
}
