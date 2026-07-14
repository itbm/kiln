/**
 * Privacy-first structured logging (§11): session ids, states, timings and
 * sanitised error classes only — never task text, repo content, diffs,
 * events or secrets. Request bodies are never logged anywhere.
 */

type Level = "debug" | "info" | "warn" | "error"

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }

const threshold =
  LEVELS[(process.env.LOG_LEVEL as Level) ?? "info"] ?? LEVELS.info

export function log(
  level: Level,
  msg: string,
  fields: Record<string, string | number | boolean | undefined> = {},
): void {
  if (LEVELS[level] < threshold) return
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields })
  if (level === "error" || level === "warn") process.stderr.write(line + "\n")
  else process.stdout.write(line + "\n")
}

/** Reduce an unknown error to a safe, short class+message string. */
export function errClass(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message.slice(0, 200)}`
  return String(e).slice(0, 200)
}
