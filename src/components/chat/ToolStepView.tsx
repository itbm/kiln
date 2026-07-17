import { useState } from "react"
import {
  ChevronDownIcon,
  GlobeIcon,
  Loader2Icon,
  SearchIcon,
  TriangleAlertIcon,
  WrenchIcon,
} from "lucide-react"
import type { ToolStep } from "@/lib/types"
import { cn } from "@/lib/utils"

function stepLabel(step: ToolStep): string {
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

function StepIcon({ step }: { step: ToolStep }) {
  if (step.status === "running")
    return <Loader2Icon className="size-3.5 animate-spin" />
  if (step.status === "error")
    return <TriangleAlertIcon className="size-3.5 text-destructive" />
  if (step.name === "web_search") return <SearchIcon className="size-3.5" />
  if (step.name === "web_fetch") return <GlobeIcon className="size-3.5" />
  return <WrenchIcon className="size-3.5" />
}

export function ToolStepView({ step }: { step: ToolStep }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="my-1.5">
      <button
        onClick={() => setOpen(!open)}
        data-ui="tool-chip"
        className={cn(
          "flex max-w-full items-center gap-1.5 rounded-full border border-border bg-muted/60 px-2.5 py-1 text-[12.5px] text-muted-foreground",
          "hover:bg-accent transition-colors",
        )}
      >
        <StepIcon step={step} />
        <span className="truncate">{stepLabel(step)}</span>
        {step.result && (
          <ChevronDownIcon
            className={cn(
              "size-3 shrink-0 transition-transform",
              open && "rotate-180",
            )}
          />
        )}
      </button>
      {open && step.result && (
        <div className="mt-1.5 max-h-56 overflow-y-auto rounded-xl border border-border bg-muted/40 p-2.5 font-mono text-[11.5px] leading-relaxed text-muted-foreground whitespace-pre-wrap">
          {step.result.slice(0, 4000)}
        </div>
      )}
    </div>
  )
}
