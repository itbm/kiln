import type { ToolDef } from "./types"
import { getSettings } from "@/stores/settings"
import { cleanKey } from "./utils"

const MAX_TOOL_RESULT = 9000

export function getEnabledTools(): ToolDef[] {
  const s = getSettings()
  const tools: ToolDef[] = []
  if (s.webSearchEnabled && s.tavilyKey) {
    tools.push({
      name: "web_search",
      description:
        "Search the web for current information. Returns a short answer plus top results with URLs. Use for anything recent, factual or niche.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query" },
        },
        required: ["query"],
      },
    })
  }
  if (s.webFetchEnabled) {
    tools.push({
      name: "web_fetch",
      description:
        "Fetch a web page by URL and return its content as readable text/markdown. Use when the user shares a link or a search result needs reading in full.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Absolute http(s) URL" },
        },
        required: ["url"],
      },
    })
  }
  return tools
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  switch (name) {
    case "web_search":
      return webSearch(String(args.query ?? ""), signal)
    case "web_fetch":
      return webFetch(String(args.url ?? ""), signal)
    default:
      return `Unknown tool: ${name}`
  }
}

async function webSearch(query: string, signal?: AbortSignal): Promise<string> {
  const key = getSettings().tavilyKey
  if (!key) return "Error: no Tavily API key configured in Settings."
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cleanKey(key)}`,
    },
    body: JSON.stringify({
      query,
      max_results: 6,
      include_answer: "basic",
    }),
    signal,
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

async function webFetch(url: string, signal?: AbortSignal): Promise<string> {
  if (!/^https?:\/\//i.test(url)) return "Error: URL must start with http(s)://"
  // r.jina.ai converts pages to clean markdown and allows browser CORS,
  // which most target sites do not.
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
    const text = await res.text()
    return truncate(stripHtml(text))
  } catch (e) {
    return `Fetch failed: ${e instanceof Error ? e.message : "network error"} (the site may block cross-origin requests)`
  }
}

function truncate(text: string): string {
  return text.length > MAX_TOOL_RESULT
    ? text.slice(0, MAX_TOOL_RESULT) + "\n…[truncated]"
    : text
}

function stripHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html")
  doc.querySelectorAll("script,style,noscript,svg").forEach((n) => n.remove())
  return (doc.body?.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim()
}

function withTimeout(
  signal: AbortSignal | undefined,
  ms: number,
): AbortSignal {
  const signals = [AbortSignal.timeout(ms)]
  if (signal) signals.push(signal)
  return AbortSignal.any(signals)
}
