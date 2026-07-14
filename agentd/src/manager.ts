import { mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import type { Config } from "./config.js"
import { Journal, decryptBlob } from "./journal.js"
import { log, errClass } from "./log.js"
import { buildTaskPrompt } from "./prompts.js"
import { Redactor } from "./redact.js"
import { EventBuffer } from "./ring-buffer.js"
import { parseShimLine, type RunnerMessage } from "./shim-protocol.js"
import type {
  SandboxDriver,
  SandboxHandle,
  HijackedExec,
} from "./driver/types.js"
import type {
  AgentEvent,
  AgentEventType,
  SessionOptions,
  SessionState,
  SessionSummary,
  RepoRef,
  ProviderConfig,
  ResumeSpec,
} from "./types.js"
import { TERMINAL_STATES } from "./types.js"
import { retryBranch, ValidationError, type ValidatedRequest } from "./validate.js"
import { sessionId, shortId, taskSlug, withTimeout } from "./util.js"

const SANDBOX_NAME_RE = /^kiln-[a-z0-9]{6}$/
const BOOTSTRAP_TIMEOUT_MS = 15 * 60_000
const FINALISE_TIMEOUT_MS = 5 * 60_000
const CHECKPOINT_TIMEOUT_MS = 90_000
const READY_TIMEOUT_MS = 120_000
const CANCEL_GRACE_MS = 15_000
const SWEEP_INTERVAL_MS = 30_000
/** cap stored tool output per event so one noisy command can't evict history */
const TOOL_RESULT_CAP = 16 * 1024
const OUTPUT_TAIL_CAP = 8 * 1024

/** Baseline egress: git + the model endpoint stay reachable whatever the profile (§6). */
function baselineHosts(providerBaseUrl: string): string[] {
  const url = new URL(providerBaseUrl)
  const providerHost = url.port ? `${url.hostname}:${url.port}` : `${url.hostname}:443`
  return [
    "github.com:443",
    "api.github.com:443",
    "codeload.github.com:443",
    "objects.githubusercontent.com:443",
    providerHost,
  ]
}

export interface SessionRecord {
  id: string
  state: SessionState
  createdAt: number
  lastActivityAt: number
  endedAt?: number
  repo: RepoRef
  task: string
  branch: string
  sandboxName: string
  workspace: string
  /** RAM only — scrubbed at teardown (§8.2) */
  secrets: { providerToken: string; githubToken: string } | null
  provider: ProviderConfig
  options: SessionOptions
  resume?: ResumeSpec
  events: EventBuffer
  redactor: Redactor
  subscribers: Set<(ev: AgentEvent) => void>
  handle?: SandboxHandle
  shim?: HijackedExec
  shimDone: boolean
  cancelRequested: boolean
  tornDown: boolean
  prUrl?: string
}

export class SessionManager {
  private sessions = new Map<string, SessionRecord>()
  private journal: Journal
  /** journal key, RAM only, learned from the first request that carries it (§5.7) */
  private journalKey: Buffer | null = null
  private sweeper?: ReturnType<typeof setInterval>

  constructor(
    private config: Config,
    private driver: SandboxDriver,
  ) {
    this.journal = new Journal(
      config.journalPath,
      config.journalRetentionDays * 86_400_000,
    )
  }

  /* ---------------------------------------------------------- boot ---- */

  /**
   * Boot reconciliation (§5.7): no sandbox outlives its session. Old loops
   * can't resume anyway — their secrets were RAM-only and died with the
   * previous process — so destroy every kiln-* sandbox and tombstone every
   * non-terminal journal row, all without needing the journal key.
   */
  async reconcile(): Promise<void> {
    this.journal.load()
    try {
      await this.driver.setup()
    } catch (e) {
      log("warn", "policy setup at boot failed (will retry per create)", { err: errClass(e) })
    }
    let destroyed = 0
    try {
      for (const name of await this.driver.list()) {
        if (!SANDBOX_NAME_RE.test(name)) continue
        try {
          await this.driver.destroy({ name })
          destroyed++
        } catch (e) {
          log("error", "orphan sandbox destroy failed", { sandbox: name, err: errClass(e) })
        }
      }
    } catch (e) {
      log("warn", "sandbox list at boot failed", { err: errClass(e) })
    }
    let tombstoned = 0
    for (const row of this.journal.rows()) {
      if (!row.tombstone) {
        this.journal.tombstone(row.id, "interrupted")
        tombstoned++
      }
    }
    log("info", "boot reconciliation done", { destroyed, tombstoned })
    this.sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS)
    this.sweeper.unref()
  }

  /** Remember the client-held journal key for encrypting rows (§5.7). */
  learnJournalKey(key: Buffer): void {
    this.journalKey = key
  }

  /* ------------------------------------------------------- creation ---- */

  createSession(v: ValidatedRequest): SessionRecord {
    const live = [...this.sessions.values()].filter((s) => !TERMINAL_STATES.has(s.state))
    if (live.length >= this.config.maxSessions)
      throw Object.assign(
        new Error(`session limit reached (${this.config.maxSessions}) — wait for one to finish or cancel it`),
        { statusCode: 429 },
      )

    const id = sessionId()
    const id6 = shortId()
    const branch = v.resume
      ? v.resume.mode === "retry"
        ? retryBranch(v.resume.taskBranch)
        : v.resume.taskBranch
      : `kiln/${taskSlug(v.task)}-${id6}`
    // retry starts over from base on the fresh branch; continue checks out the old one
    const resume: ResumeSpec | undefined = v.resume
      ? { ...v.resume, taskBranch: branch }
      : undefined

    const s: SessionRecord = {
      id,
      state: "created",
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      repo: v.repo,
      task: v.task,
      branch,
      sandboxName: `kiln-${id6}`,
      workspace: join(this.config.workspaceRoot, `kiln-${id6}`),
      secrets: { providerToken: v.provider.token, githubToken: v.github.token },
      provider: { baseUrl: v.provider.baseUrl, model: v.provider.model, smallModel: v.provider.smallModel },
      options: v.options,
      resume,
      events: new EventBuffer(this.config.eventBufferEvents, this.config.eventBufferBytes),
      redactor: new Redactor([v.provider.token, v.github.token]),
      subscribers: new Set(),
      shimDone: false,
      cancelRequested: false,
      tornDown: false,
    }
    this.sessions.set(id, s)
    this.transition(s, "created")
    log("info", "session created", { id, repo: `${v.repo.owner}/${v.repo.name}`, resume: resume?.mode })

    void this.run(s).catch((e) => {
      log("error", "session pipeline crashed", { id: s.id, err: errClass(e) })
      this.fail(s, `internal error: ${errClass(e)}`)
    })
    return s
  }

  /* ------------------------------------------------------- pipeline ---- */

  private async run(s: SessionRecord): Promise<void> {
    // -- provision ------------------------------------------------------
    this.transition(s, "provisioning")
    mkdirSync(s.workspace, { recursive: true })
    const secrets = s.secrets
    if (!secrets) return // deleted before we started
    const env: Record<string, string> = {
      ANTHROPIC_BASE_URL: s.provider.baseUrl,
      ANTHROPIC_AUTH_TOKEN: secrets.providerToken,
      ANTHROPIC_API_KEY: "", // explicitly empty — auth rides AUTH_TOKEN (§3.3)
      ANTHROPIC_MODEL: s.provider.model,
      ...(s.provider.smallModel ? { ANTHROPIC_SMALL_FAST_MODEL: s.provider.smallModel } : {}),
      GH_TOKEN: secrets.githubToken,
      GIT_TERMINAL_PROMPT: "0",
      KILN_REPO: `${s.repo.owner}/${s.repo.name}`,
      KILN_BASE_BRANCH: s.repo.baseBranch,
      KILN_TASK_BRANCH: s.branch,
      KILN_MODEL: s.provider.model,
    }
    s.handle = await this.driver.create({
      name: s.sandboxName,
      image: this.config.templateImage,
      workspace: s.workspace,
      env,
      networkPolicy: s.options.network.policy,
      allowPackageManagers: s.options.network.allowPackageManagers,
      allowHosts: [...baselineHosts(s.provider.baseUrl), ...s.options.network.extraHosts],
    })
    // the session may have been cancelled/deleted while create was in
    // flight; its teardown already ran without a handle, so destroy the
    // fresh sandbox here or it would linger until the next boot reconcile
    if (this.isTerminal(s)) return void this.destroyLate(s)

    // -- clone + branch ---------------------------------------------------
    this.transition(s, "cloning")
    const boot = await this.driver.exec(s.handle, ["/opt/kiln/bootstrap.sh"], {
      timeoutMs: BOOTSTRAP_TIMEOUT_MS,
    })
    this.emit(s, "bootstrap", {
      output: tail(boot.output, OUTPUT_TAIL_CAP),
      exitCode: boot.exitCode,
    })
    if (boot.exitCode !== 0) {
      return this.fail(s, bootstrapHint(boot.output), { checkpoint: false })
    }
    if (this.isTerminal(s)) return void this.destroyLate(s)

    // -- agent loop -------------------------------------------------------
    this.transition(s, "running")
    const shim = await this.driver.attach(s.handle, ["node", "/opt/kiln/agent-shim.mjs"])
    s.shim = shim

    let readyResolve: (() => void) | undefined
    const ready = new Promise<void>((res) => (readyResolve = res))

    shim.onLine((line) => {
      const msg = parseShimLine(s.redactor.redact(line))
      if (!msg) return
      if (msg.t === "ready") {
        readyResolve?.()
        this.sendToShim(s, {
          t: "task",
          prompt: buildTaskPrompt({
            task: s.task,
            repo: s.repo,
            taskBranch: s.branch,
            resume: s.resume,
          }),
          config: {
            maxTurns: s.options.maxTurns,
            permissionMode: s.options.permissionMode,
            model: s.provider.model,
          },
        })
      } else if (msg.t === "sdk") {
        this.mapSdkMessage(s, msg.msg)
      } else if (msg.t === "done") {
        s.shimDone = true
        if (s.cancelRequested) {
          this.transition(s, "cancelled")
          void this.teardown(s, { checkpoint: true })
        } else {
          void this.finalise(s).catch((e) =>
            this.fail(s, `finalisation failed: ${errClass(e)}`),
          )
        }
      } else if (msg.t === "fatal") {
        this.fail(s, `agent error: ${msg.error}`)
      }
    })

    shim.onClose(() => {
      if (s.shimDone || this.isTerminal(s) || s.state === "finalising") return
      if (s.cancelRequested) {
        this.transition(s, "cancelled")
        void this.teardown(s, { checkpoint: true })
      } else {
        this.fail(s, "the agent process ended unexpectedly")
      }
    })

    try {
      await withTimeout(ready, READY_TIMEOUT_MS, "agent start")
    } catch (e) {
      return this.fail(s, errClass(e))
    }
  }

  /** Map a raw Agent SDK message to phone-facing events (defensive: shapes may drift). */
  private mapSdkMessage(s: SessionRecord, raw: unknown): void {
    const m = raw as Record<string, any>
    if (!m || typeof m !== "object") return
    if (m.type === "assistant" && Array.isArray(m.message?.content)) {
      for (const block of m.message.content) {
        if (block?.type === "text" && block.text)
          this.emit(s, "assistant_text", { text: String(block.text) })
        else if (block?.type === "thinking" && block.thinking)
          this.emit(s, "assistant_text", { text: String(block.thinking), thinking: true })
        else if (block?.type === "tool_use")
          this.emit(s, "tool_use", {
            id: String(block.id ?? ""),
            tool: String(block.name ?? "tool"),
            input: block.input ?? {},
          })
      }
    } else if (m.type === "user" && Array.isArray(m.message?.content)) {
      for (const block of m.message.content) {
        if (block?.type === "tool_result")
          this.emit(s, "tool_result", {
            id: String(block.tool_use_id ?? ""),
            output: tail(blockText(block.content), TOOL_RESULT_CAP),
            isError: block.is_error === true,
          })
      }
    } else if (m.type === "result") {
      this.emit(s, "result", {
        subtype: typeof m.subtype === "string" ? m.subtype : undefined,
        durationMs: numberOr(m.duration_ms),
        turns: numberOr(m.num_turns),
        costUsd: numberOr(m.total_cost_usd),
        isError: m.is_error === true,
        text: typeof m.result === "string" ? tail(m.result, TOOL_RESULT_CAP) : undefined,
      })
    }
    // system/init and partial stream events are intentionally not forwarded
  }

  /* ------------------------------------------------------ finalising ---- */

  /**
   * Push + PR + diff card. Runs automatically when the loop ends; also
   * exposed as POST /sessions/{id}/finalise for stuck sessions (§6, §7).
   */
  async finalise(s: SessionRecord): Promise<void> {
    if (this.isTerminal(s) || !s.handle) return
    this.transition(s, "finalising")
    const res = await this.driver.exec(s.handle, ["/opt/kiln/finalise.sh"], {
      timeoutMs: FINALISE_TIMEOUT_MS,
    })
    const marker = res.output
      .split("\n")
      .reverse()
      .find((l) => l.startsWith("KILN_FINALISE_JSON:"))
    if (res.exitCode !== 0 || !marker) {
      this.emit(s, "error", { message: `finalise failed: ${tail(res.output, 2000)}` })
      this.transition(s, "failed")
      return void this.teardown(s, { checkpoint: true })
    }
    let out: Record<string, unknown> = {}
    try {
      out = JSON.parse(marker.slice("KILN_FINALISE_JSON:".length))
    } catch {
      /* tolerated: treated as no info */
    }
    if (out.no_commits === true) {
      this.emit(s, "warning", { message: "The agent finished without committing any changes." })
    } else {
      const stat = typeof out.diffstat === "string" ? out.diffstat : ""
      const patch =
        typeof out.patch_b64 === "string"
          ? Buffer.from(out.patch_b64, "base64").toString("utf8")
          : undefined
      this.emit(s, "diff", {
        stat,
        patch: patch ? tail(patch, 256 * 1024) : undefined,
        truncated: out.truncated === true || (patch ? patch.length > 256 * 1024 : false),
      })
      if (typeof out.pr_url === "string" && out.pr_url) {
        s.prUrl = out.pr_url
        this.emit(s, "pr", { url: out.pr_url })
      } else {
        this.emit(s, "warning", { message: "Changes were pushed but no pull request was created." })
      }
    }
    this.transition(s, "completed")
    void this.teardown(s, { checkpoint: false })
  }

  /* ------------------------------------------------------- teardown ---- */

  /**
   * Checkpoint-on-teardown (§5.8, default on): any non-completed teardown we
   * can still act on first pushes a wip commit to the task branch, so
   * Continue can pick the work up in a fresh sandbox.
   */
  private async teardown(s: SessionRecord, opts: { checkpoint: boolean }): Promise<void> {
    if (s.tornDown) return
    s.tornDown = true
    s.endedAt = Date.now()
    try {
      s.shim?.close()
    } catch {
      /* already gone */
    }
    if (opts.checkpoint && s.handle && s.state !== "completed") {
      try {
        const cp = await this.driver.exec(s.handle, ["/opt/kiln/checkpoint.sh"], {
          timeoutMs: CHECKPOINT_TIMEOUT_MS,
        })
        if (cp.output.includes("KILN_CHECKPOINT_PUSHED"))
          this.emit(s, "warning", {
            message: `Unfinished work was checkpointed to ${s.branch} — Continue picks it up from there.`,
          })
      } catch (e) {
        log("warn", "checkpoint failed", { id: s.id, err: errClass(e) })
      }
    }
    if (s.handle) {
      try {
        await this.driver.destroy(s.handle)
      } catch (e) {
        log("error", "sandbox destroy failed (will retry on next boot reconcile)", {
          id: s.id,
          sandbox: s.sandboxName,
          err: errClass(e),
        })
      }
    }
    try {
      rmSync(s.workspace, { recursive: true, force: true })
    } catch {
      /* tmpfs — best effort */
    }
    // scrub: drop the only references so the strings become collectable (§8.2 / §14-5)
    s.secrets = null
    this.persist(s)
    log("info", "session torn down", { id: s.id, state: s.state })
  }

  /** Destroy a sandbox whose session ended while provisioning was in flight. */
  private async destroyLate(s: SessionRecord): Promise<void> {
    if (!s.handle) return
    try {
      await this.driver.destroy(s.handle)
    } catch (e) {
      log("error", "late sandbox destroy failed (boot reconcile will catch it)", {
        id: s.id,
        sandbox: s.sandboxName,
        err: errClass(e),
      })
    }
  }

  private fail(s: SessionRecord, message: string, opts: { checkpoint: boolean } = { checkpoint: true }): void {
    if (this.isTerminal(s)) return
    this.emit(s, "error", { message })
    this.transition(s, "failed")
    void this.teardown(s, opts)
  }

  /* ------------------------------------------------------ operations ---- */

  get(id: string): SessionRecord | undefined {
    return this.sessions.get(id)
  }

  input(s: SessionRecord, text: string): void {
    if (s.state !== "running" || !s.shim)
      throw Object.assign(new Error(`session is ${s.state}; steering needs a running session`), {
        statusCode: 409,
      })
    this.sendToShim(s, { t: "user_message", text })
    s.lastActivityAt = Date.now()
  }

  cancel(s: SessionRecord): void {
    if (this.isTerminal(s)) return
    s.cancelRequested = true
    if (s.state === "running" && s.shim) {
      this.sendToShim(s, { t: "cancel" })
      // graceful window for the SDK to interrupt, then force
      setTimeout(() => {
        if (!this.isTerminal(s)) {
          this.transition(s, "cancelled")
          void this.teardown(s, { checkpoint: true })
        }
      }, CANCEL_GRACE_MS).unref()
    } else {
      this.transition(s, "cancelled")
      void this.teardown(s, { checkpoint: s.state === "running" })
    }
  }

  async finaliseNow(s: SessionRecord): Promise<void> {
    if (this.isTerminal(s) || s.tornDown || !s.handle)
      throw Object.assign(
        new Error("session already ended — use Continue to start a new session from its branch"),
        { statusCode: 409 },
      )
    await this.finalise(s)
  }

  async remove(s: SessionRecord): Promise<void> {
    if (!this.isTerminal(s)) this.transition(s, "cancelled")
    await this.teardown(s, { checkpoint: false })
    this.sessions.delete(s.id)
    this.journal.delete(s.id)
  }

  /* ------------------------------------------------------ subscribing ---- */

  subscribe(
    s: SessionRecord,
    after: number,
    push: (ev: AgentEvent) => void,
  ): { replay: AgentEvent[]; missedBefore?: number; detach: () => void } {
    const replay = s.events.since(after)
    const missedBefore =
      after + 1 < s.events.oldestSeq && s.events.latestSeq > after ? s.events.oldestSeq : undefined
    s.subscribers.add(push)
    return {
      replay,
      missedBefore,
      detach: () => s.subscribers.delete(push),
    }
  }

  /* -------------------------------------------------------- listing ---- */

  summary(s: SessionRecord): SessionSummary {
    return {
      id: s.id,
      state: s.state,
      repo: `${s.repo.owner}/${s.repo.name}`,
      baseBranch: s.repo.baseBranch,
      taskBranch: s.branch,
      createdAt: s.createdAt,
      lastActivityAt: s.lastActivityAt,
      latestSeq: s.events.latestSeq,
      prUrl: s.prUrl,
      tornDown: s.tornDown,
    }
  }

  /**
   * Live sessions, plus journal rows from before a restart when the caller
   * supplied the journal key (merged blob + tombstone, §5.7).
   */
  list(journalKey: Buffer | null): SessionSummary[] {
    const out = [...this.sessions.values()].map((s) => this.summary(s))
    const liveIds = new Set(out.map((s) => s.id))
    for (const row of this.journal.rows()) {
      if (liveIds.has(row.id)) continue
      const blob = journalKey && row.blob ? decryptBlob(journalKey, row.blob) : null
      if (blob) {
        out.push({
          id: row.id,
          state: row.tombstone ?? blob.state,
          repo: blob.repo,
          baseBranch: blob.baseBranch,
          taskBranch: blob.taskBranch,
          createdAt: blob.createdAt,
          latestSeq: blob.lastSeq,
          prUrl: blob.prUrl,
          tornDown: true,
          fromJournal: true,
        })
      } else if (row.tombstone) {
        out.push({
          id: row.id,
          state: row.tombstone,
          repo: "",
          baseBranch: "",
          taskBranch: "",
          createdAt: 0,
          latestSeq: 0,
          tornDown: true,
          fromJournal: true,
        })
      }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt)
  }

  liveCount(): number {
    return [...this.sessions.values()].filter((s) => !TERMINAL_STATES.has(s.state)).length
  }

  /* ------------------------------------------------------- internals ---- */

  private sendToShim(s: SessionRecord, msg: RunnerMessage): void {
    try {
      s.shim?.writeLine(JSON.stringify(msg))
    } catch (e) {
      log("warn", "shim write failed", { id: s.id, err: errClass(e) })
    }
  }

  private isTerminal(s: SessionRecord): boolean {
    return TERMINAL_STATES.has(s.state)
  }

  private transition(s: SessionRecord, state: SessionState): void {
    if (this.isTerminal(s) && state !== s.state) return // terminal states are final
    s.state = state
    this.emit(s, "state", { state })
    this.persist(s)
  }

  /**
   * Journal write cadence: state transitions only (open question #2 —
   * per-event lastSeq persistence isn't worth the write amplification;
   * its only value is a slightly better "you may have missed output"
   * message after a restart).
   */
  private persist(s: SessionRecord): void {
    this.journal.put(
      s.id,
      {
        sandboxName: s.sandboxName,
        state: s.state,
        repo: `${s.repo.owner}/${s.repo.name}`,
        baseBranch: s.repo.baseBranch,
        taskBranch: s.branch,
        createdAt: s.createdAt,
        prUrl: s.prUrl,
        lastSeq: s.events.latestSeq,
      },
      this.journalKey,
    )
  }

  /** Redact → buffer → fan out. Every outbound byte passes through here (§8.3). */
  private emit(s: SessionRecord, type: AgentEventType, payload: Record<string, unknown>): AgentEvent {
    const ev = s.events.append(type, s.redactor.redactDeep(payload))
    if (type !== "state") s.lastActivityAt = Date.now()
    for (const push of s.subscribers) {
      try {
        push(ev)
      } catch {
        /* a broken subscriber must not break the session */
      }
    }
    return ev
  }

  /** TTL enforcement + retention pruning (§5.1). */
  private sweep(): void {
    const now = Date.now()
    for (const s of this.sessions.values()) {
      if (!this.isTerminal(s)) {
        const hardMs = s.options.hardTtlMinutes * 60_000
        const idleMs = s.options.idleTtlMinutes * 60_000
        if (now - s.createdAt > hardMs) {
          this.emit(s, "warning", { message: "Hard TTL reached — session expired." })
          this.transition(s, "expired")
          void this.teardown(s, { checkpoint: true })
        } else if (s.state === "running" && now - s.lastActivityAt > idleMs) {
          this.emit(s, "warning", { message: "Idle TTL reached — session expired." })
          this.transition(s, "expired")
          void this.teardown(s, { checkpoint: true })
        }
      } else if (
        s.endedAt &&
        now - s.endedAt > this.config.retainTerminalMinutes * 60_000
      ) {
        this.sessions.delete(s.id)
      }
    }
  }

  async shutdown(): Promise<void> {
    clearInterval(this.sweeper)
    // interrupted, not failed: the phone can Continue these from the branch
    for (const s of this.sessions.values()) {
      if (!this.isTerminal(s)) {
        this.transition(s, "interrupted")
        await this.teardown(s, { checkpoint: true })
      }
    }
  }
}

/* ------------------------------------------------------------ helpers ---- */

function tail(text: string, cap: number): string {
  if (text.length <= cap) return text
  return `…(truncated)…\n${text.slice(text.length - cap)}`
}

function numberOr(v: unknown): number | undefined {
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

function blockText(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content))
    return content
      .map((c) => (typeof c === "string" ? c : c?.type === "text" ? String(c.text ?? "") : ""))
      .filter(Boolean)
      .join("\n")
  return ""
}

/** Sanitised, actionable message for a failed clone/branch (§9). */
function bootstrapHint(output: string): string {
  const o = output.toLowerCase()
  if (o.includes("could not read username") || o.includes("authentication failed") || o.includes("bad credentials"))
    return "GitHub authentication failed — check that the PAT is valid and grants Contents: Read/Write on this repository."
  if (o.includes("repository not found") || o.includes("404"))
    return "Repository not found — check owner/name and that the PAT's repository access includes it."
  if (o.includes("couldn't find remote ref") || o.includes("remote branch"))
    return "Base branch not found on the remote — check repo.baseBranch."
  return `Repository bootstrap failed: ${tail(output, 1500)}`
}

export { ValidationError }
