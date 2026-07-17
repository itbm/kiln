import { useState } from "react"
import { BrainIcon, ChevronDownIcon } from "lucide-react"
import { cn } from "@/lib/utils"

export function ReasoningBlock({
  reasoning,
  reasoningMs,
  active,
}: {
  reasoning: string
  reasoningMs?: number
  active: boolean
}) {
  const [open, setOpen] = useState(false)
  const label = active
    ? "Thinking…"
    : reasoningMs !== undefined
      ? `Thought for ${reasoningMs < 60_000 ? `${Math.max(1, Math.round(reasoningMs / 1000))}s` : `${Math.round(reasoningMs / 60_000)}m`}`
      : "Thought process"

  return (
    <div className="mb-2">
      <button
        onClick={() => setOpen(!open)}
        data-ui="think-pill"
        className="flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground transition-colors"
      >
        <BrainIcon className="size-3.5" />
        <span className={cn(active && "shimmer")}>{label}</span>
        <ChevronDownIcon
          className={cn("size-3.5 transition-transform", open && "rotate-180")}
        />
      </button>
      {open && (
        <div
          className="mt-2 border-l-2 border-border pl-3 text-[13px] leading-relaxed text-thinking whitespace-pre-wrap max-h-72 overflow-y-auto"
          data-ui="think-body"
        >
          {reasoning}
        </div>
      )}
    </div>
  )
}
