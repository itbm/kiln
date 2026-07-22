import { memo, useState } from "react"
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleStopIcon,
  CopyIcon,
  FileIcon,
  PencilIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from "lucide-react"
import type { Message } from "@/lib/types"
import { splitContent, type ArtifactBlock } from "@/lib/artifacts"
import { effortCaption } from "@/lib/effort"
import { usageCaption, usageDetail } from "@/lib/usage"
import { activeVersionIndex, versionCount } from "@/lib/versions"
import { cn } from "@/lib/utils"
import { useStream } from "@/stores/stream"
import { MarkdownView } from "./MarkdownView"
import { ReasoningBlock } from "./ReasoningBlock"
import { ToolStepView } from "./ToolStepView"
import { ArtifactCard } from "./ArtifactView"
import { QuestionsCard } from "./QuestionsSheet"
import type { QuestionsBlock } from "@/lib/questions"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"

function ModelCaption({ msg }: { msg: Message }) {
  const name = msg.modelName ?? msg.model
  if (!name) return null
  return (
    <span className="truncate">
      {name}
      {msg.effort && msg.effort !== "auto"
        ? ` · ${effortCaption(msg.effort)}`
        : ""}
    </span>
  )
}

/** Cost (or tokens) of the active generation; tap for the full breakdown. */
function UsageCaption({ msg }: { msg: Message }) {
  const [expanded, setExpanded] = useState(false)
  const u = msg.usage
  const text = u && (expanded ? usageDetail(u) : usageCaption(u))
  if (!text) return null
  return (
    <>
      {(msg.modelName ?? msg.model) && <span aria-hidden>·</span>}
      <button
        type="button"
        aria-label={expanded ? "Hide usage details" : "Show tokens and cost"}
        className={cn(
          "min-w-0 text-left tabular-nums transition-colors hover:text-foreground",
          expanded ? "whitespace-normal" : "shrink-0",
        )}
        onClick={() => setExpanded((v) => !v)}
      >
        {text}
      </button>
    </>
  )
}

function CopyIconButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label="Copy message"
      onClick={() => {
        void navigator.clipboard.writeText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </Button>
  )
}

function UserMessage({
  msg,
  busy,
  onEdit,
}: {
  msg: Message
  busy: boolean
  onEdit?: (msg: Message, text: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(msg.content)

  return (
    <div className="group flex flex-col items-end gap-1.5 px-4">
      {msg.attachments?.map((a) =>
        a.kind === "image" && a.dataUrl ? (
          <img
            key={a.id}
            src={a.dataUrl}
            alt={a.name}
            className="max-h-56 max-w-[75%] rounded-2xl border border-border object-cover"
          />
        ) : (
          <div
            key={a.id}
            className="flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 text-[13px]"
          >
            <FileIcon className="size-4 text-muted-foreground" />
            <span className="max-w-48 truncate">{a.name}</span>
          </div>
        ),
      )}
      {editing ? (
        <div className="w-full max-w-[95%] rounded-2xl border border-input bg-card p-2">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="min-h-20 border-0 bg-transparent p-2 text-[16px] shadow-none focus-visible:ring-0 md:text-[15px]"
            autoFocus
          />
          <div className="flex justify-end gap-2 p-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setEditing(false)
                setDraft(msg.content)
              }}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={!draft.trim() || draft.trim() === msg.content}
              onClick={() => {
                setEditing(false)
                onEdit?.(msg, draft.trim())
              }}
            >
              Send
            </Button>
          </div>
        </div>
      ) : (
        <>
          {msg.content && (
            <div className="max-w-[85%] rounded-3xl rounded-br-lg bg-bubble-user px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap break-words">
              {msg.content}
            </div>
          )}
          <div className="flex items-center gap-0.5 text-[11px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-active:opacity-100 max-md:opacity-60">
            {msg.editedAt && <span className="mr-1">edited</span>}
            <CopyIconButton text={msg.content} />
            {onEdit && !busy && (
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Edit message"
                onClick={() => {
                  setDraft(msg.content)
                  setEditing(true)
                }}
              >
                <PencilIcon />
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  )
}

export const MessageView = memo(function MessageView({
  msg,
  isLast,
  busy = false,
  onRetry,
  onOpenArtifact,
  onEditUser,
  onSwitchVersion,
  onOpenQuestions,
}: {
  msg: Message
  isLast: boolean
  busy?: boolean
  onRetry?: () => void
  onOpenArtifact: (a: ArtifactBlock) => void
  onEditUser?: (msg: Message, text: string) => void
  onSwitchVersion?: (msg: Message, target: number) => void
  onOpenQuestions?: (msg: Message, block: QuestionsBlock) => void
}) {
  const live = useStream((s) => s.live[msg.id])

  if (msg.role === "user") {
    return <UserMessage msg={msg} busy={busy} onEdit={onEditUser} />
  }

  // assistant
  const content = live?.content ?? msg.content
  const reasoning = live?.reasoning ?? msg.reasoning ?? ""
  const steps = live?.steps ?? msg.steps ?? []
  const images = live?.images ?? msg.images ?? []
  const streaming = !!live
  const waiting =
    streaming && !content && !reasoning && !steps.length && !images.length
  const segments = splitContent(content)
  const nVersions = versionCount(msg)
  const vIndex = activeVersionIndex(msg)

  return (
    <div className="group px-4">
      {reasoning && (
        <ReasoningBlock
          reasoning={reasoning}
          reasoningMs={live?.reasoningMs ?? msg.reasoningMs}
          active={
            streaming && !content && !steps.some((s) => s.status !== "running")
          }
        />
      )}
      {steps.map((s) => (
        <ToolStepView key={s.id} step={s} />
      ))}
      {waiting && (
        <div className="flex items-center gap-2 py-1 text-[14px]">
          <span className="shimmer">Thinking…</span>
        </div>
      )}
      {segments.map((seg, i) =>
        seg.kind === "text" ? (
          <MarkdownView key={i} content={seg.text} />
        ) : seg.kind === "artifact" ? (
          <ArtifactCard
            key={`a-${i}`}
            artifact={seg.artifact}
            generating={streaming && !seg.artifact.complete}
            onOpen={() => onOpenArtifact(seg.artifact)}
          />
        ) : (
          <QuestionsCard
            key={`q-${i}`}
            block={seg.block}
            answered={!!msg.questionsAnswered}
            onOpen={() => onOpenQuestions?.(msg, seg.block)}
          />
        ),
      )}
      {images.length > 0 && (
        <div
          className={cn(
            "mt-2 grid gap-2",
            images.length > 1 ? "grid-cols-2" : "grid-cols-1",
          )}
        >
          {images.map((im) => (
            <a
              key={im.id}
              href={im.dataUrl}
              download={`kiln-${im.id.slice(0, 6)}.png`}
            >
              <img
                src={im.dataUrl}
                alt="Generated"
                className="w-full rounded-2xl border border-border"
              />
            </a>
          ))}
        </div>
      )}
      {streaming && content && (
        <span className="ml-0.5 inline-block size-2.5 rounded-full bg-primary streaming-dot" />
      )}

      {msg.status === "error" && !streaming && (
        <div className="mt-2 flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-[13px] text-destructive">
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
          <div className="min-w-0">
            <div className="font-medium">Something went wrong</div>
            <div className="break-words opacity-90">{msg.error}</div>
          </div>
        </div>
      )}
      {msg.status === "interrupted" && !streaming && (
        <div className="mt-2 flex items-center gap-2 text-[12.5px] text-muted-foreground">
          <TriangleAlertIcon className="size-3.5 text-primary" />
          Generation was interrupted (app was closed mid-stream)
        </div>
      )}
      {msg.status === "stopped" && !streaming && (
        <div className="mt-2 flex items-center gap-2 text-[12.5px] text-muted-foreground">
          <CircleStopIcon className="size-3.5" /> Stopped
        </div>
      )}

      {!streaming && (
        <div className="mt-1.5 flex items-center gap-1 text-[11.5px] text-muted-foreground">
          {nVersions > 1 && onSwitchVersion && (
            <span className="mr-1 flex items-center">
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Previous version"
                disabled={busy || vIndex === 0}
                onClick={() => onSwitchVersion(msg, vIndex - 1)}
              >
                <ChevronLeftIcon />
              </Button>
              <span className="tabular-nums">
                {vIndex + 1}/{nVersions}
              </span>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Next version"
                disabled={busy || vIndex === nVersions - 1}
                onClick={() => onSwitchVersion(msg, vIndex + 1)}
              >
                <ChevronRightIcon />
              </Button>
            </span>
          )}
          <ModelCaption msg={msg} />
          <UsageCaption msg={msg} />
          <div className="ml-auto flex items-center opacity-70 transition-opacity group-hover:opacity-100">
            {(content || reasoning) && <CopyIconButton text={content} />}
            {isLast && onRetry && !busy && (
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Regenerate"
                onClick={onRetry}
              >
                <RefreshCwIcon />
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  )
})
