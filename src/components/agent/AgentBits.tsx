import { useState } from "react"
import {
  ChevronDownIcon,
  FileCodeIcon,
  FileDiffIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  GlobeIcon,
  ListChecksIcon,
  Loader2Icon,
  SearchIcon,
  TerminalIcon,
  TriangleAlertIcon,
  WrenchIcon,
} from "lucide-react"
import type { AgentRunExtras, AgentSessionStatus, ToolStep } from "@/lib/types"
import { cn } from "@/lib/utils"

/* ----------------------------------------------------------- status chip ---- */

const STATUS_STYLE: Record<AgentSessionStatus, { label: string; cls: string; live?: boolean }> = {
  created: { label: "Starting", cls: "text-primary border-primary/40 bg-primary/8", live: true },
  provisioning: { label: "Provisioning", cls: "text-primary border-primary/40 bg-primary/8", live: true },
  cloning: { label: "Cloning", cls: "text-primary border-primary/40 bg-primary/8", live: true },
  running: { label: "Working", cls: "text-primary border-primary/40 bg-primary/8", live: true },
  finalising: { label: "Finalising", cls: "text-primary border-primary/40 bg-primary/8", live: true },
  completed: { label: "Completed", cls: "text-emerald-600 dark:text-emerald-400 border-emerald-600/30 bg-emerald-500/8" },
  failed: { label: "Failed", cls: "text-destructive border-destructive/40 bg-destructive/8" },
  cancelled: { label: "Cancelled", cls: "text-muted-foreground border-border bg-muted/40" },
  interrupted: { label: "Interrupted", cls: "text-amber-600 dark:text-amber-400 border-amber-600/30 bg-amber-500/8" },
  expired: { label: "Expired", cls: "text-destructive border-destructive/40 bg-destructive/8" },
}

export function StatusChip({ status }: { status: AgentSessionStatus }) {
  const s = STATUS_STYLE[status] ?? STATUS_STYLE.created
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium",
        s.cls,
      )}
    >
      {s.live ? (
        <Loader2Icon className="size-3 animate-spin" />
      ) : (
        <span className="size-1.5 rounded-full bg-current" />
      )}
      {s.label}
    </span>
  )
}

/* ------------------------------------------------------------ tool steps ---- */

function stepLabel(step: ToolStep): string {
  const a = step.args as Record<string, unknown>
  switch (step.name) {
    case "bootstrap":
      return "Cloned repository & created branch"
    case "Bash":
      return `$ ${String(a.command ?? "").slice(0, 90)}` || "Ran command"
    case "Read":
      return `Read ${short(String(a.file_path ?? a.path ?? ""))}`
    case "Write":
      return `Wrote ${short(String(a.file_path ?? a.path ?? ""))}`
    case "Edit":
    case "MultiEdit":
      return `Edited ${short(String(a.file_path ?? a.path ?? ""))}`
    case "Grep":
      return `Searched “${String(a.pattern ?? "").slice(0, 50)}”`
    case "Glob":
      return `Globbed ${String(a.pattern ?? "").slice(0, 50)}`
    case "TodoWrite":
      return "Updated plan"
    case "WebFetch":
      return `Fetched ${short(String(a.url ?? ""))}`
    case "WebSearch":
      return `Searched “${String(a.query ?? "").slice(0, 50)}”`
    default:
      return step.name
  }
}

function short(path: string): string {
  if (path.length <= 44) return path
  return `…${path.slice(-42)}`
}

function StepIcon({ step }: { step: ToolStep }) {
  if (step.status === "running") return <Loader2Icon className="size-3.5 animate-spin" />
  if (step.status === "error") return <TriangleAlertIcon className="size-3.5 text-destructive" />
  switch (step.name) {
    case "bootstrap":
      return <GitBranchIcon className="size-3.5" />
    case "Bash":
      return <TerminalIcon className="size-3.5" />
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
      return <FileCodeIcon className="size-3.5" />
    case "Grep":
    case "Glob":
    case "WebSearch":
      return <SearchIcon className="size-3.5" />
    case "WebFetch":
      return <GlobeIcon className="size-3.5" />
    case "TodoWrite":
      return <ListChecksIcon className="size-3.5" />
    default:
      return <WrenchIcon className="size-3.5" />
  }
}

/** Agent-flavoured ToolStepView: same collapsed-chip idiom, SDK tool labels. */
export function AgentStepView({ step }: { step: ToolStep }) {
  const [open, setOpen] = useState(false)
  const detail = stepDetail(step)
  return (
    <div className="my-1">
      <button
        onClick={() => setOpen(!open)}
        className={cn(
          "flex max-w-full items-center gap-1.5 rounded-full border border-border bg-muted/60 px-2.5 py-1 text-[12.5px] text-muted-foreground",
          "hover:bg-accent transition-colors",
        )}
      >
        <StepIcon step={step} />
        <span className="truncate font-mono text-[12px]">{stepLabel(step)}</span>
        {detail && (
          <ChevronDownIcon
            className={cn("size-3 shrink-0 transition-transform", open && "rotate-180")}
          />
        )}
      </button>
      {open && detail && (
        <div className="mt-1.5 max-h-56 overflow-y-auto rounded-xl border border-border bg-muted/40 p-2.5 font-mono text-[11.5px] leading-relaxed text-muted-foreground whitespace-pre-wrap">
          {detail.slice(0, 6000)}
        </div>
      )}
    </div>
  )
}

function stepDetail(step: ToolStep): string {
  const parts: string[] = []
  if (step.name === "Bash" && step.args.command) parts.push(`$ ${String(step.args.command)}`)
  if (step.result) parts.push(step.result)
  return parts.join("\n\n")
}

/* -------------------------------------------------------------- PR card ---- */

export function PrCard({ url }: { url: string }) {
  let label = url
  try {
    const u = new URL(url)
    label = u.pathname.replace(/^\//, "")
  } catch {
    /* keep raw */
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="my-2 flex items-center gap-3 rounded-2xl border border-primary/30 bg-primary/5 p-3 transition-colors hover:bg-primary/10"
    >
      <GitPullRequestIcon className="size-5 shrink-0 text-primary" />
      <div className="min-w-0">
        <div className="text-[13.5px] font-medium">Pull request ready</div>
        <div className="truncate font-mono text-[12px] text-muted-foreground">{label}</div>
      </div>
    </a>
  )
}

/* ------------------------------------------------------------- diff card ---- */

export function DiffCard({ diff }: { diff: NonNullable<AgentRunExtras["diff"]> }) {
  const [open, setOpen] = useState(false)
  const statTail = diff.stat.trim().split("\n").pop() ?? ""
  return (
    <div className="my-2 overflow-hidden rounded-2xl border border-border">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2.5 bg-muted/50 px-3 py-2.5 text-left hover:bg-accent transition-colors"
      >
        <FileDiffIcon className="size-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium">Changes</div>
          <div className="truncate text-[11.5px] text-muted-foreground">{statTail}</div>
        </div>
        <ChevronDownIcon
          className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}
        />
      </button>
      {open && (
        <div className="max-h-96 overflow-auto border-t border-border bg-background p-2.5">
          <pre className="font-mono text-[11px] leading-relaxed">
            {diff.stat.trim() && (
              <span className="text-muted-foreground">{diff.stat.trim() + "\n\n"}</span>
            )}
            {(diff.patch ?? "").split("\n").map((line, i) => (
              <span
                key={i}
                className={cn(
                  "block whitespace-pre-wrap break-all",
                  line.startsWith("+") && !line.startsWith("+++")
                    ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                    : line.startsWith("-") && !line.startsWith("---")
                      ? "bg-red-500/10 text-red-700 dark:text-red-400"
                      : line.startsWith("@@")
                        ? "text-primary"
                        : line.startsWith("diff ")
                          ? "font-semibold"
                          : "",
                )}
              >
                {line || " "}
              </span>
            ))}
          </pre>
          {diff.truncated && (
            <p className="pt-2 text-[11.5px] text-muted-foreground">
              Patch truncated — review the full diff on the pull request.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------ result line ---- */

export function ResultLine({ result }: { result: NonNullable<AgentRunExtras["result"]> }) {
  const bits: string[] = []
  if (result.turns !== undefined) bits.push(`${result.turns} turn${result.turns === 1 ? "" : "s"}`)
  if (result.durationMs !== undefined) bits.push(formatDuration(result.durationMs))
  if (result.costUsd !== undefined && result.costUsd > 0) bits.push(`$${result.costUsd.toFixed(3)}`)
  if (!bits.length) return null
  return <div className="mt-1 text-[11px] text-muted-foreground">{bits.join(" · ")}</div>
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return s ? `${m}m ${s}s` : `${m}m`
}
