import type { Message, Usage } from "./types"
import { fullVersionList } from "./versions"

/**
 * Merge provider-reported usage. A turn can span several provider calls
 * (tool rounds), and chat totals sum many messages — token counts and cost
 * add up; genMs adds too (total time spent generating).
 */
export function addUsage(a: Usage | undefined, b: Usage | undefined): Usage | undefined {
  if (!a) return b
  if (!b) return a
  const sum = (x?: number, y?: number): number | undefined =>
    x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0)
  return {
    promptTokens: sum(a.promptTokens, b.promptTokens),
    completionTokens: sum(a.completionTokens, b.completionTokens),
    reasoningTokens: sum(a.reasoningTokens, b.reasoningTokens),
    cachedTokens: sum(a.cachedTokens, b.cachedTokens),
    cost: sum(a.cost, b.cost),
    genMs: sum(a.genMs, b.genMs),
  }
}

/** 812 · 1.2k · 48k · 1.3M */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
}

/**
 * Real money at readable precision: $12.40 · $0.042 · $0.0017 · <$0.0001.
 * Free-model replies are honestly "$0".
 */
export function formatCost(usd: number): string {
  if (usd === 0) return "$0"
  if (usd < 0.0001) return "<$0.0001"
  if (usd >= 1) return `$${usd.toFixed(2)}`
  const s = usd < 0.01 ? usd.toPrecision(2) : usd.toFixed(3)
  return `$${s.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "")}`
}

/** Output speed, when the provider (or wall clock) timed the generation. */
export function tokensPerSec(u: Usage): number | undefined {
  if (!u.completionTokens || !u.genMs || u.genMs < 200) return undefined
  return u.completionTokens / (u.genMs / 1000)
}

/** The quiet caption under a reply: cost when billed per token, else tokens. */
export function usageCaption(u: Usage): string | undefined {
  if (u.cost !== undefined) return formatCost(u.cost)
  const total = (u.promptTokens ?? 0) + (u.completionTokens ?? 0)
  return total ? `${formatTokens(total)} tok` : undefined
}

/** The expanded, tapped-open breakdown. */
export function usageDetail(u: Usage): string {
  const parts: string[] = []
  if (u.promptTokens !== undefined) {
    let inPart = `${formatTokens(u.promptTokens)} in`
    if (u.cachedTokens) inPart += ` (${formatTokens(u.cachedTokens)} cached)`
    parts.push(inPart)
  }
  if (u.completionTokens !== undefined) {
    let outPart = `${formatTokens(u.completionTokens)} out`
    if (u.reasoningTokens)
      outPart += ` (${formatTokens(u.reasoningTokens)} reasoning)`
    parts.push(outPart)
  }
  const tps = tokensPerSec(u)
  if (tps) parts.push(`${tps >= 10 ? Math.round(tps) : tps.toFixed(1)} tok/s`)
  if (u.cost !== undefined) parts.push(formatCost(u.cost))
  return parts.join(" · ")
}

export interface ChatUsageTotals {
  /** finished assistant replies (visible generations) */
  replies: number
  /** every generation attempt, including archived versions */
  attempts: number
  /** attempts that carry no provider usage data (older chats, aborted runs) */
  unreported: number
  total: Usage
  perModel: { name: string; attempts: number; usage: Usage }[]
}

/**
 * What this chat actually consumed: sums every generation attempt —
 * regenerated versions included, because each one was billed.
 */
export function chatUsageTotals(messages: Message[]): ChatUsageTotals {
  let replies = 0
  let attempts = 0
  let unreported = 0
  let total: Usage | undefined
  const perModel = new Map<string, { name: string; attempts: number; usage: Usage }>()
  for (const m of messages) {
    if (m.role !== "assistant") continue
    replies++
    for (const gen of fullVersionList(m)) {
      attempts++
      if (!gen.usage) {
        unreported++
        continue
      }
      total = addUsage(total, gen.usage)
      const key = `${gen.provider ?? "?"}/${gen.model ?? "?"}`
      const entry = perModel.get(key) ?? {
        name: gen.modelName ?? gen.model ?? "Unknown model",
        attempts: 0,
        usage: {},
      }
      entry.attempts++
      entry.usage = addUsage(entry.usage, gen.usage)!
      perModel.set(key, entry)
    }
  }
  return {
    replies,
    attempts,
    unreported,
    total: total ?? {},
    perModel: [...perModel.values()].sort(
      (a, b) => (b.usage.cost ?? 0) - (a.usage.cost ?? 0),
    ),
  }
}
