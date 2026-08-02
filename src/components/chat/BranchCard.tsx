import { GitBranchIcon, ExternalLinkIcon } from "lucide-react"
import type { Message } from "@/lib/types"

/**
 * The result of a coding turn: what was pushed, and where to look at it.
 *
 * Styled as a tappable card like an artefact, because it plays the same role
 * — the thing the reply produced, distinct from the prose about it. The link
 * goes to GitHub's compare view rather than the branch, since what a reviewer
 * wants is the diff against the base.
 */
export function BranchCard({ branch }: { branch: NonNullable<Message["branch"]> }) {
  const files = `${branch.filesChanged} file${branch.filesChanged === 1 ? "" : "s"}`
  const commits = `${branch.commits} commit${branch.commits === 1 ? "" : "s"}`
  return (
    <a
      href={branch.url}
      target="_blank"
      rel="noreferrer noopener"
      data-ui="branch-card"
      className="mt-2 flex items-center gap-2.5 rounded-xl border border-border bg-card/60 px-3 py-2.5 transition-colors hover:bg-accent/60"
    >
      <GitBranchIcon className="size-4 shrink-0 text-primary" />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-mono text-[13px] font-medium">
          {branch.name}
        </span>
        <span className="block text-[11px] text-muted-foreground">
          Pushed · {files} · {commits} · open the comparison
        </span>
      </span>
      <ExternalLinkIcon className="size-3.5 shrink-0 text-muted-foreground" />
    </a>
  )
}
