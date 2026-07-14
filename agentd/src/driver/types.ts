/**
 * SandboxDriver abstraction (§5.5). agentd talks to this interface, never to
 * sandboxd directly, so the unofficial sbx API's blast radius is capped at
 * one adapter file (`sbx.ts`). A `DockerDriver` fallback for KVM-less hosts
 * is a documented M5 follow-up behind the same interface.
 */

import type { NetworkProfile } from "../types.js"

export interface SandboxSpec {
  /** deterministic name, `kiln-<id6>` — reconciliation depends on it */
  name: string
  /** template image, e.g. kiln-agent:0.1.0 */
  image: string
  /** HOST-side workspace directory (sandboxd resolves host paths, §10) */
  workspace: string
  env: Record<string, string>
  networkPolicy: NetworkProfile
  allowPackageManagers: boolean
  /**
   * Baseline + extra sandbox-scoped allow rules (`host:port` / `**.host`),
   * applied whatever the profile so git + the model stay reachable (§6).
   */
  allowHosts: string[]
}

export interface SandboxHandle {
  name: string
}

export interface ExecResult {
  exitCode: number
  /** combined stdout+stderr */
  output: string
}

export interface ExecOptions {
  timeoutMs?: number
  cwd?: string
}

/** Bidirectional stdio bridge to a process inside the sandbox (§5.4). */
export interface HijackedExec {
  /** send one line (NDJSON message) to the process's stdin */
  writeLine(line: string): void
  /** complete lines of combined stdout/stderr */
  onLine(cb: (line: string) => void): void
  /** stream ended (process exit or transport loss) */
  onClose(cb: (err?: Error) => void): void
  close(): void
}

export interface DriverHealth {
  ok: boolean
  driver: string
  apiVersion?: string
  apiVersionOk?: boolean
  kvm?: boolean
  templatePresent?: boolean
  detail?: string
}

export interface SandboxDriver {
  readonly name: string
  create(spec: SandboxSpec): Promise<SandboxHandle>
  exec(h: SandboxHandle, cmd: string[], opts?: ExecOptions): Promise<ExecResult>
  attach(h: SandboxHandle, cmd: string[]): Promise<HijackedExec>
  destroy(h: SandboxHandle): Promise<void>
  /** names of live sandboxes (boot reconciliation, §5.7) */
  list(): Promise<string[]>
  health(): Promise<DriverHealth>
  /** one-time policy initialisation; sandbox creation 412s without it (§3.2) */
  setup(): Promise<void>
}
