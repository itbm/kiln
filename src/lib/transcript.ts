import { splitContent } from "./artifacts"
import { effortCaption } from "./effort"
import type { Chat, Message, ToolStep } from "./types"
import { chatUsageTotals, usageDetail } from "./usage"
import { formatBytes } from "./utils"

/**
 * A chat as Markdown a person can read.
 *
 * Export/import speaks JSON because it has to round-trip; this is the other
 * direction — something to paste into a document, mail to someone, or keep.
 * It quotes what was on screen: artefact bodies in full, hidden mood tags and
 * reasoning traces left out, tool steps as the chips said them.
 */

/** Same wording as the tool chips in the conversation. */
function stepLine(step: ToolStep): string {
  if (step.name === "web_search")
    return `Searched “${String(step.args.query ?? "")}”`
  if (step.name === "web_fetch") {
    try {
      return `Read ${new URL(String(step.args.url)).hostname}`
    } catch {
      return "Read page"
    }
  }
  return step.name
}

/** Same wording as the collapsed "Thought for …" pill in the conversation. */
function thoughtLabel(ms: number | undefined): string {
  if (ms === undefined) return "Thought process"
  const spent =
    ms < 60_000
      ? `${Math.max(1, Math.round(ms / 1000))}s`
      : `${Math.round(ms / 60_000)}m`
  return `Thought for ${spent}`
}

/** A fence long enough to hold content that itself contains fences. */
function fenceFor(content: string): string {
  let longest = 2
  for (const run of content.match(/`+/g) ?? [])
    longest = Math.max(longest, run.length)
  return "`".repeat(longest + 1)
}

const ARTEFACT_KIND: Record<string, string> = {
  "text/markdown": "Markdown",
  "text/html": "HTML page",
  "image/svg+xml": "SVG",
  "application/code": "Code",
}

function fenceLanguage(type: string, language?: string): string {
  if (type === "application/code") return language ?? ""
  if (type === "text/html") return "html"
  if (type === "image/svg+xml") return "svg"
  return "markdown"
}

function attachmentLine(m: Message): string | null {
  if (!m.attachments?.length) return null
  const each = m.attachments.map(
    (a) => `${a.name} (${a.kind}, ${formatBytes(a.size)})`,
  )
  return `*Attached: ${each.join(", ")}*`
}

function dateLine(ts: number): string {
  return new Date(ts).toLocaleString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

export function chatToMarkdown(chat: Chat, messages: Message[]): string {
  const out: string[] = [`# ${chat.title}`, ""]
  out.push(`*${chat.kind === "image" ? "Images session" : "Chat"} · ${dateLine(chat.createdAt)} · exported from Kiln*`)
  out.push("", "---", "")

  for (const m of messages) {
    if (m.role === "user") {
      out.push("## You", "")
      if (m.content) out.push(m.content, "")
      const files = attachmentLine(m)
      if (files) out.push(files, "")
      continue
    }

    const model = m.modelName ?? m.model
    const effort = m.effort && m.effort !== "auto" ? ` · ${effortCaption(m.effort)}` : ""
    out.push(`## Assistant${model ? ` · ${model}${effort}` : ""}`, "")

    for (const step of m.steps ?? []) out.push(`*${stepLine(step)}*`, "")
    // the trace itself stays collapsed on screen; only the fact of it travels
    if (m.reasoning) out.push(`*${thoughtLabel(m.reasoningMs)}*`, "")

    for (const seg of splitContent(m.content)) {
      if (seg.kind === "text") {
        out.push(seg.text.trim(), "")
      } else if (seg.kind === "artifact") {
        const a = seg.artifact
        const kind = ARTEFACT_KIND[a.type] ?? "Artefact"
        out.push(`**Artefact — ${a.title}** (${kind})`, "")
        const fence = fenceFor(a.content)
        out.push(`${fence}${fenceLanguage(a.type, a.language)}`, a.content, fence, "")
      } else {
        const asked = seg.block.questions.map((q) => q.text).join(" · ")
        out.push(`*Asked: ${asked}*`, "")
      }
    }

    for (const _ of m.images ?? []) out.push("*[generated image]*", "")
    if (m.status === "error") out.push(`> **Error:** ${m.error ?? "unknown"}`, "")
    if (m.status === "interrupted") out.push("*[generation was interrupted]*", "")
    if (m.status === "stopped") out.push("*[stopped]*", "")

    const usage = m.usage && usageDetail(m.usage)
    if (usage) out.push(`*${usage}*`, "")
  }

  const totals = chatUsageTotals(messages)
  const summary = totals.total && usageDetail(totals.total)
  if (summary) {
    out.push("---", "")
    out.push(
      `*${totals.replies} repl${totals.replies === 1 ? "y" : "ies"}${
        totals.attempts !== totals.replies ? ` (${totals.attempts} attempts)` : ""
      } · ${summary}*`,
      "",
    )
  }

  // one blank line between blocks, however the sections above stacked up
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n"
}
