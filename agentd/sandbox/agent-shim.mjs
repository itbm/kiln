#!/usr/bin/env node
// agent-shim (§5.4): a small NDJSON-over-stdio wrapper around the Claude
// Agent SDK. Keeping the SDK inside the sandbox means repo content, shell
// execution and model traffic never leave the microVM; agentd only sees
// this line protocol (see agentd/src/shim-protocol.ts).
//
// Pin-and-verify note: option names and message shapes below match
// @anthropic-ai/claude-agent-sdk as pinned in ../sandbox/Dockerfile —
// validate against docs.claude.com when bumping the pin. This file is the
// single adaptation point if the SDK surface drifts.
import { createInterface } from "node:readline"
import { query } from "@anthropic-ai/claude-agent-sdk"

const emit = (msg) => process.stdout.write(JSON.stringify(msg) + "\n")

let q = null
let pushUser = null
let started = false

const userMessage = (text) => ({
  type: "user",
  message: { role: "user", content: [{ type: "text", text }] },
  parent_tool_use_id: null,
  session_id: "",
})

// Streaming input: first the task prompt, then any mid-task steers the
// runner forwards from the phone ({t:"user_message"}).
function promptStream(firstText) {
  const queue = [firstText]
  let notify = null
  pushUser = (text) => {
    queue.push(text)
    if (notify) notify()
  }
  return (async function* () {
    for (;;) {
      while (queue.length) yield userMessage(queue.shift())
      await new Promise((resolve) => (notify = resolve))
    }
  })()
}

async function runTask(task) {
  started = true
  const config = task.config ?? {}
  q = query({
    prompt: promptStream(task.prompt),
    options: {
      cwd: "/work/repo",
      // the SDK defaults to an empty system prompt; restore the coding preset
      systemPrompt: { type: "preset", preset: "claude_code" },
      model: config.model || process.env.KILN_MODEL,
      maxTurns: config.maxTurns ?? 60,
      // autonomous by default — the microVM is the guardrail, not prompts (G6)
      permissionMode: config.permissionMode ?? "bypassPermissions",
    },
  })
  try {
    for await (const msg of q) {
      emit({ t: "sdk", msg })
      // one result ends the task; without this the input stream keeps the
      // loop alive waiting for user messages that will never come
      if (msg && msg.type === "result") break
    }
    emit({ t: "done" })
    process.exit(0)
  } catch (err) {
    emit({ t: "fatal", error: String((err && err.message) || err) })
    process.exit(1)
  }
}

function cancel() {
  const bail = () => {
    emit({ t: "done", stats: { cancelled: true } })
    process.exit(0)
  }
  if (!q || typeof q.interrupt !== "function") return bail()
  Promise.resolve(q.interrupt()).catch(() => {}).finally(bail)
}

createInterface({ input: process.stdin }).on("line", (line) => {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg.t === "task" && !started) void runTask(msg)
  else if (msg.t === "user_message" && pushUser && typeof msg.text === "string")
    pushUser(msg.text)
  else if (msg.t === "cancel") cancel()
})

process.stdin.on("end", () => process.exit(0))

emit({ t: "ready" })
