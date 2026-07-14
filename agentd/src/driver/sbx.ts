import { Client } from "undici"
import { hijackExec } from "./hijack.js"
import type {
  DriverHealth,
  ExecOptions,
  ExecResult,
  HijackedExec,
  SandboxDriver,
  SandboxHandle,
  SandboxSpec,
} from "./types.js"
import { log, errClass } from "../log.js"

/**
 * Default driver: Docker Sandboxes (`sbx`) microVMs via the sandboxd HTTP
 * API on a local unix socket (§3.2, §5.5).
 *
 * The API is unofficial (reverse-engineered as OpenAPI 0.16.0 / sbx
 * v0.34.0). `itbm/sbx-sdk`'s generated TypeScript client captures the same
 * surface but is not published to npm, so this file embeds the ~six calls
 * agentd needs directly over undici. It is the designated swap point: when
 * sbx-sdk is vendored (or Docker ships an official API), only this adapter
 * changes. The boot-time `api_version` probe (§12) refuses new sessions on
 * drift rather than guessing.
 */

interface SbxRequestOptions {
  method: "GET" | "POST" | "DELETE"
  path: string
  body?: unknown
  timeoutMs?: number
}

export class SbxDriver implements SandboxDriver {
  readonly name = "sbx"
  private client: Client
  private policyReady = false

  constructor(
    private socketPath: string,
    private expectedApiVersion: string,
    private templateImage: string,
  ) {
    // hostname is a placeholder — routing happens via the unix socket
    this.client = new Client("http://sandboxd", {
      socketPath,
      keepAliveTimeout: 30_000,
      // bootstrap execs (clone of a big repo) can legitimately run for minutes
      bodyTimeout: 0,
      headersTimeout: 0,
    })
  }

  private async request<T>(opts: SbxRequestOptions): Promise<T> {
    const res = await this.client.request({
      method: opts.method,
      path: opts.path,
      headers: opts.body !== undefined ? { "content-type": "application/json" } : undefined,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      headersTimeout: opts.timeoutMs ?? 30_000,
      bodyTimeout: opts.timeoutMs ?? 30_000,
    })
    const text = await res.body.text()
    if (res.statusCode < 200 || res.statusCode >= 300) {
      const detail = text.slice(0, 300)
      const err = new Error(`sandboxd ${opts.method} ${opts.path} → ${res.statusCode}: ${detail}`)
      ;(err as Error & { statusCode?: number }).statusCode = res.statusCode
      throw err
    }
    if (!text) return undefined as T
    try {
      return JSON.parse(text) as T
    } catch {
      return text as unknown as T
    }
  }

  async setup(): Promise<void> {
    await this.request({ method: "GET", path: "/policy/setup" })
    this.policyReady = true
  }

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    const body = {
      name: spec.name,
      agent: process.env.SBX_AGENT ?? "custom",
      workspace: spec.workspace,
      template: spec.image,
      env: spec.env,
      network_policy: spec.networkPolicy,
      allow_package_managers: spec.allowPackageManagers,
    }
    const attempt = () =>
      this.request<{ name?: string }>({
        method: "POST",
        path: "/sandbox",
        body,
        timeoutMs: 120_000,
      })
    let created: { name?: string }
    try {
      created = await attempt()
    } catch (e) {
      const status = (e as Error & { statusCode?: number }).statusCode
      if (status === 412) {
        // policy not initialised — set up once and retry (§9)
        await this.setup()
        created = await attempt()
      } else if (status === 500) {
        throw new Error(
          `sandbox create failed (${errClass(e)}) — a 500 from sandboxd usually means KVM is unavailable on the host (/dev/kvm)`,
        )
      } else {
        throw e
      }
    }
    const handle = { name: created?.name || spec.name }
    await this.applyAllowRules(handle.name, spec.allowHosts)
    return handle
  }

  /**
   * Baseline + extra egress rules, sandbox-scoped (§6 network resolution).
   * Whatever the profile, git + the model endpoint must stay reachable.
   */
  private async applyAllowRules(sandbox: string, hosts: string[]): Promise<void> {
    if (!hosts.length) return
    await this.request({
      method: "POST",
      path: "/policy/rules",
      body: {
        scope: "sandbox",
        sandbox,
        decision: "allow",
        resources: hosts,
      },
    })
  }

  async exec(h: SandboxHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
    const res = await this.request<Record<string, unknown>>({
      method: "POST",
      path: `/sandbox/${encodeURIComponent(h.name)}/exec`,
      body: { cmd, cwd: opts?.cwd, interactive: false },
      timeoutMs: opts?.timeoutMs ?? 15 * 60_000,
    })
    // be lenient about the exact field names of the unofficial API
    const exitCode = Number(res?.exit_code ?? res?.exitCode ?? res?.code ?? 0)
    const output = String(res?.output ?? res?.combined_output ?? res?.stdout ?? "")
    return { exitCode: Number.isFinite(exitCode) ? exitCode : 0, output }
  }

  attach(h: SandboxHandle, cmd: string[]): Promise<HijackedExec> {
    return hijackExec(this.socketPath, h.name, cmd)
  }

  async destroy(h: SandboxHandle): Promise<void> {
    try {
      await this.request({
        method: "DELETE",
        path: `/sandbox/${encodeURIComponent(h.name)}`,
        timeoutMs: 60_000,
      })
    } catch (e) {
      const status = (e as Error & { statusCode?: number }).statusCode
      if (status === 404) return // already gone — that's the goal
      throw e
    }
  }

  async list(): Promise<string[]> {
    const res = await this.request<unknown>({ method: "GET", path: "/sandbox" })
    const items = Array.isArray(res)
      ? res
      : Array.isArray((res as { sandboxes?: unknown[] })?.sandboxes)
        ? (res as { sandboxes: unknown[] }).sandboxes
        : []
    return items
      .map((s) => (typeof s === "string" ? s : String((s as { name?: string })?.name ?? "")))
      .filter(Boolean)
  }

  async health(): Promise<DriverHealth> {
    try {
      const h = await this.request<Record<string, unknown>>({
        method: "GET",
        path: "/daemon/health",
        timeoutMs: 5_000,
      })
      const apiVersion = String(h?.api_version ?? h?.apiVersion ?? "unknown")
      const kvm = typeof h?.kvm === "boolean" ? (h.kvm as boolean) : undefined
      return {
        ok: true,
        driver: this.name,
        apiVersion,
        apiVersionOk: apiVersion === this.expectedApiVersion,
        kvm,
        templatePresent: await this.templatePresent(),
      }
    } catch (e) {
      return { ok: false, driver: this.name, detail: errClass(e) }
    }
  }

  /** Best-effort template-image presence check via GET /docker/images (§5.2). */
  private async templatePresent(): Promise<boolean | undefined> {
    try {
      const res = await this.request<unknown>({
        method: "GET",
        path: "/docker/images",
        timeoutMs: 10_000,
      })
      const images = Array.isArray(res) ? res : []
      return images.some((im) => {
        const tags = (im as { tags?: unknown; repo_tags?: unknown })
        const list = Array.isArray(tags?.tags)
          ? tags.tags
          : Array.isArray(tags?.repo_tags)
            ? tags.repo_tags
            : []
        return list.some((t) => String(t) === this.templateImage)
      })
    } catch (e) {
      log("debug", "template image check unavailable", { err: errClass(e) })
      return undefined
    }
  }

  get policyInitialised(): boolean {
    return this.policyReady
  }
}
