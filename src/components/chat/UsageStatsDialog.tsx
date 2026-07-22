import { useMemo } from "react"
import type { Chat, Message } from "@/lib/types"
import {
  chatUsageTotals,
  formatCost,
  formatTokens,
  usageCaption,
} from "@/lib/usage"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 text-[13.5px]">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  )
}

/**
 * What this chat has consumed, straight from the providers' own accounting —
 * every generation attempt counted, regenerated versions included.
 */
export function UsageStatsDialog({
  open,
  onOpenChange,
  chat,
  messages,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  chat: Chat
  messages: Message[]
}) {
  const t = useMemo(() => chatUsageTotals(messages), [messages])
  const hasData = t.attempts > t.unreported

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[90vw] rounded-2xl sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Usage & cost</DialogTitle>
          <DialogDescription className="text-left">
            Provider-reported tokens for “{chat.title}” — not an estimate.
          </DialogDescription>
        </DialogHeader>

        {!hasData ? (
          <p className="text-[13.5px] text-muted-foreground">
            No usage data yet — it's recorded as replies finish, so older
            chats fill in as you keep talking.
          </p>
        ) : (
          <div className="space-y-1.5">
            <Row
              label="Replies"
              value={
                t.attempts > t.replies
                  ? `${t.replies} (${t.attempts} attempts)`
                  : String(t.replies)
              }
            />
            {t.total.promptTokens !== undefined && (
              <Row
                label="Input tokens"
                value={
                  formatTokens(t.total.promptTokens) +
                  (t.total.cachedTokens
                    ? ` (${formatTokens(t.total.cachedTokens)} cached)`
                    : "")
                }
              />
            )}
            {t.total.completionTokens !== undefined && (
              <Row
                label="Output tokens"
                value={
                  formatTokens(t.total.completionTokens) +
                  (t.total.reasoningTokens
                    ? ` (${formatTokens(t.total.reasoningTokens)} reasoning)`
                    : "")
                }
              />
            )}
            {t.total.cost !== undefined && (
              <Row label="Cost" value={formatCost(t.total.cost)} />
            )}

            {t.perModel.length > 1 && (
              <div className="mt-3 space-y-1 border-t border-border pt-2.5">
                {t.perModel.map((m, i) => (
                  <div
                    key={i}
                    className="flex items-baseline justify-between gap-4 text-[12.5px]"
                  >
                    <span className="min-w-0 truncate text-muted-foreground">
                      {m.name}
                      {m.attempts > 1 ? ` ×${m.attempts}` : ""}
                    </span>
                    <span className="shrink-0 tabular-nums">
                      {usageCaption(m.usage) ?? "—"}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <p className="text-[11.5px] leading-snug text-muted-foreground/80">
          {t.unreported > 0 && hasData
            ? `${t.unreported} repl${t.unreported === 1 ? "y" : "ies"} ${t.unreported === 1 ? "has" : "have"} no usage data (older app version or interrupted). `
            : ""}
          Side calls like chat titles and compaction aren't counted. Ollama
          cloud is subscription-based, so tokens are shown without a price.
        </p>
      </DialogContent>
    </Dialog>
  )
}
