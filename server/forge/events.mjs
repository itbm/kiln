/**
 * Translate Claude Code's message stream into Kiln `TurnEvent`s.
 *
 * This is the whole reason code chats cost so little UI work: the harness's
 * output maps 1:1 onto the event union `consumeTurn` (src/lib/engine.ts)
 * already applies, so tool steps, reasoning, usage and artefacts render with
 * no new components.
 *
 * The shapes here mirror `TurnEvent` in src/lib/types.ts — change them
 * together, exactly as server/cloud.mjs does.
 *
 * Deliberately free of Kiln specifics beyond that union, so it can be tested
 * standalone against recorded harness output.
 */

/** Tool inputs can be huge (whole file bodies); the UI only shows a summary. */
const MAX_ARG_CHARS = 2000
const MAX_RESULT_CHARS = 9000

function clip(s, max) {
  if (typeof s !== "string") return s
  return s.length > max ? `${s.slice(0, max)}\n… (truncated)` : s
}

function clipArgs(input) {
  if (!input || typeof input !== "object") return {}
  const out = {}
  for (const [k, v] of Object.entries(input))
    out[k] = typeof v === "string" ? clip(v, MAX_ARG_CHARS) : v
  return out
}

/**
 * One harness message → zero or more TurnEvents.
 *
 * Returns an array because a single assistant message can carry several
 * content blocks (text plus a tool call, say), and each is its own event.
 */
export function mapSdkMessage(msg) {
  if (!msg || typeof msg !== "object") return []

  switch (msg.type) {
    // The init message is where the session id first appears. Persisting it is
    // what makes a turn resumable after the agent process or the whole VM dies.
    case "system":
      return msg.data?.session_id
        ? [{ t: "session", id: msg.data.session_id }]
        : []

    case "assistant": {
      const out = []
      for (const block of msg.content ?? []) {
        if (block.type === "text" && block.text) out.push({ t: "text", x: block.text })
        else if (block.type === "thinking" && block.thinking)
          out.push({ t: "reasoning", x: block.thinking })
        else if (block.type === "tool_use")
          out.push({
            t: "tool",
            id: block.id,
            name: block.name,
            args: clipArgs(block.input),
          })
      }
      return out
    }

    // A tool result. `is_error` becomes ok:false so ToolStepView shows it as
    // failed rather than as a successful step with odd-looking output.
    case "result": {
      if (!msg.tool_use_id) return []
      const text = (msg.content ?? [])
        .map((b) => (b.type === "error" ? b.error : b.text))
        .filter(Boolean)
        .join("\n")
      const failed =
        msg.is_error === true || (msg.content ?? []).some((b) => b.type === "error")
      return [
        {
          t: "tool_result",
          id: msg.tool_use_id,
          result: clip(text, MAX_RESULT_CHARS),
          ok: !failed,
        },
      ]
    }

    case "stream_event":
      // Partial-message previews. The journal already carries whole blocks, and
      // replaying both would double every reply.
      return []

    default:
      return []
  }
}

/**
 * The harness's end-of-turn summary → usage + final.
 *
 * Usage is provider-reported, matching Kiln's rule that cost is never
 * estimated (src/lib/usage.ts).
 */
export function mapResultSummary(summary) {
  const out = []
  const u = summary?.usage
  if (u) {
    const usage = {}
    if (typeof u.input_tokens === "number") usage.promptTokens = u.input_tokens
    if (typeof u.output_tokens === "number") usage.completionTokens = u.output_tokens
    if (typeof u.cache_read_input_tokens === "number")
      usage.cachedTokens = u.cache_read_input_tokens
    if (typeof summary.total_cost_usd === "number") usage.cost = summary.total_cost_usd
    if (typeof summary.duration_ms === "number") usage.genMs = summary.duration_ms
    if (Object.keys(usage).length) out.push({ t: "usage", usage })
  }
  return out
}

/**
 * A permission prompt or an AskUserQuestion → an `ask` event.
 *
 * Both land on Kiln's existing `<questions>` chips (src/lib/questions.ts), so
 * the phone gets a tappable prompt instead of the agent guessing. `requestId`
 * is what the answer is posted back against.
 */
export function askEvent(requestId, kind, questions) {
  return { t: "ask", requestId, kind, questions }
}

/**
 * A permission request rendered as a two-option question.
 *
 * The shape is `QuestionSpec` from src/lib/questions.ts — {text, options[]} —
 * so QuestionsSheet renders it with no special-casing. The answer comes back
 * as the option's own string, which is why the options are the literal words
 * the forge compares against.
 */
export function permissionAsk(requestId, toolName, args) {
  const detail =
    typeof args?.command === "string"
      ? args.command
      : typeof args?.file_path === "string"
        ? args.file_path
        : ""
  return askEvent(requestId, "permission", [
    {
      text: `Allow ${toolName}${detail ? `: ${clip(detail, 300)}` : ""}?`,
      options: ["Allow", "Deny"],
    },
  ])
}

/** True when an answer string means "go ahead". */
export function isAllow(answer) {
  return typeof answer === "string" && /^allow$/i.test(answer.trim())
}
