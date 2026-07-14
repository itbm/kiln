import { useEffect, useRef, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useNavigate, useParams } from "react-router-dom"
import {
  ArrowUpIcon,
  CircleStopIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  ListRestartIcon,
  MoreVerticalIcon,
  PanelLeftIcon,
  PlayIcon,
  PlusIcon,
  RotateCcwIcon,
  SettingsIcon,
  SquareTerminalIcon,
  Trash2Icon,
  TriangleAlertIcon,
  WifiOffIcon,
} from "lucide-react"
import { toast } from "sonner"
import { AppShell } from "@/components/layout/AppShell"
import { ChatHeader } from "@/components/layout/ChatHeader"
import { MarkdownView } from "@/components/chat/MarkdownView"
import { ReasoningBlock } from "@/components/chat/ReasoningBlock"
import {
  AgentStepView,
  DiffCard,
  PrCard,
  ResultLine,
  StatusChip,
} from "@/components/agent/AgentBits"
import { NewTaskSheet } from "@/components/agent/NewTaskSheet"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Textarea } from "@/components/ui/textarea"
import { useChat, useChatMessages } from "@/hooks/use-chat-data"
import * as api from "@/lib/agent/client"
import { ensureAttached, resumeAgentTask, steerAgent } from "@/lib/agent/runtime"
import { db, deleteChat } from "@/lib/db"
import type { Chat, Message } from "@/lib/types"
import { AGENT_TERMINAL_STATES } from "@/lib/types"
import { timeAgo } from "@/lib/utils"
import { useIsDesktop } from "@/hooks/use-media"
import { confirmDialog } from "@/stores/dialogs"
import { useAgentConn } from "@/stores/agent"
import { useSettings } from "@/stores/settings"

function useAgentChats(): Chat[] | undefined {
  return useLiveQuery(async () => {
    const chats = await db.chats.where("kind").equals("agent").toArray()
    return chats.sort((a, b) => b.updatedAt - a.updatedAt)
  }, [])
}

/* ------------------------------------------------------------- list view ---- */

function SessionRow({ chat, onOpen }: { chat: Chat; onOpen: () => void }) {
  const meta = chat.agentMeta
  return (
    <button
      onClick={onOpen}
      className="flex w-full items-center gap-3 rounded-2xl border border-border bg-card p-3 text-left transition-colors hover:bg-accent/60"
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14px] font-medium">{chat.title}</div>
        <div className="mt-0.5 flex items-center gap-1.5 truncate text-[11.5px] text-muted-foreground">
          <span className="truncate">{meta?.repo}</span>
          <GitBranchIcon className="size-3 shrink-0" />
          <span className="truncate font-mono">{meta?.taskBranch}</span>
        </div>
      </div>
      {meta?.prUrl && <GitPullRequestIcon className="size-4 shrink-0 text-primary" />}
      <div className="flex shrink-0 flex-col items-end gap-1">
        {meta && <StatusChip status={meta.status} />}
        <span className="text-[10.5px] text-muted-foreground">{timeAgo(chat.updatedAt)}</span>
      </div>
    </button>
  )
}

function CodeList({ openSidebar }: { openSidebar: () => void }) {
  const navigate = useNavigate()
  const isDesktop = useIsDesktop()
  const chats = useAgentChats()
  const configured = useSettings((s) => !!s.agentRunnerToken)
  const [sheetOpen, setSheetOpen] = useState(false)

  // keep live sessions attached so list chips update in real time
  useEffect(() => {
    for (const c of chats ?? [])
      if (c.agentMeta && !AGENT_TERMINAL_STATES.has(c.agentMeta.status)) void ensureAttached(c)
  }, [chats])

  return (
    <>
      <header className="pt-safe">
        <div className="flex h-12 items-center gap-1 border-b border-border/70 bg-background/90 px-2 backdrop-blur">
          {!isDesktop && (
            <Button variant="ghost" size="icon-sm" aria-label="Open menu" onClick={openSidebar}>
              <PanelLeftIcon className="size-5" />
            </Button>
          )}
          <h1 className="flex-1 px-1 text-center text-[15px] font-semibold">Code</h1>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="New task"
            disabled={!configured}
            onClick={() => setSheetOpen(true)}
          >
            <PlusIcon className="size-5" />
          </Button>
        </div>
      </header>

      {!configured ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 pb-24 text-center">
          <SquareTerminalIcon className="size-8 text-primary/60" />
          <h2 className="font-serif text-[24px]">Code with an agent</h2>
          <p className="max-w-72 text-[13.5px] text-muted-foreground">
            Point Kiln at your own agent runner and it will take on coding tasks in disposable
            sandboxes — every change arrives as a pull request you review here.
          </p>
          <Button variant="outline" size="sm" className="mt-2" onClick={() => navigate("/settings#agent")}>
            <SettingsIcon /> Set up the runner
          </Button>
        </div>
      ) : (chats?.length ?? 0) === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 pb-24 text-center">
          <SquareTerminalIcon className="size-8 text-primary/60" />
          <h2 className="font-serif text-[24px]">Ship something</h2>
          <p className="max-w-72 text-[13.5px] text-muted-foreground">
            Describe a change to one of your repositories. The agent clones it in a microVM, does
            the work, and opens a pull request.
          </p>
          <Button size="sm" className="mt-2" onClick={() => setSheetOpen(true)}>
            <PlusIcon /> New task
          </Button>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <div className="mx-auto max-w-3xl space-y-2 px-3 py-3 pb-safe-plus">
            {chats!.map((c) => (
              <SessionRow key={c.id} chat={c} onOpen={() => navigate(`/code/${c.id}`)} />
            ))}
          </div>
        </div>
      )}

      <NewTaskSheet open={sheetOpen} onOpenChange={setSheetOpen} />
    </>
  )
}

/* ---------------------------------------------------------- session view ---- */

function AgentAssistantMessage({ msg, live }: { msg: Message; live: boolean }) {
  return (
    <div className="px-4">
      {msg.reasoning && (
        <ReasoningBlock reasoning={msg.reasoning} reasoningMs={msg.reasoningMs} active={false} />
      )}
      {msg.steps?.map((s) => <AgentStepView key={s.id} step={s} />)}
      {msg.content && (
        <div className="mt-1.5">
          <MarkdownView content={msg.content} />
        </div>
      )}
      {live && !msg.content && !msg.steps?.length && (
        <div className="shimmer py-1 text-[13.5px]">Working…</div>
      )}
      {msg.agent?.diff && <DiffCard diff={msg.agent.diff} />}
      {msg.agent?.prUrl && <PrCard url={msg.agent.prUrl} />}
      {msg.agent?.result && <ResultLine result={msg.agent.result} />}
      {msg.status === "error" && msg.error && (
        <div className="mt-2 flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-[13px] text-destructive">
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
          <span className="whitespace-pre-wrap">{msg.error}</span>
        </div>
      )}
    </div>
  )
}

function SessionView({ chat, openSidebar }: { chat: Chat; openSidebar: () => void }) {
  const navigate = useNavigate()
  const messages = useChatMessages(chat.id)
  const meta = chat.agentMeta
  const conn = useAgentConn((s) => s.conn[chat.id])
  const [draft, setDraft] = useState("")
  const [busy, setBusy] = useState(false)
  const live = !!meta && !AGENT_TERMINAL_STATES.has(meta.status)

  const scrollRef = useRef<HTMLDivElement>(null)
  const lastMsg = messages[messages.length - 1]
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, lastMsg?.content, lastMsg?.steps?.length, lastMsg?.status])

  // re-attach on open and whenever the app returns to the foreground (§5.6)
  useEffect(() => {
    void ensureAttached(chat)
    const onVisible = () => {
      if (document.visibilityState === "visible") void ensureAttached(chat)
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => document.removeEventListener("visibilitychange", onVisible)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.id, meta?.status])

  const resume = async (mode: "continue" | "retry") => {
    setBusy(true)
    try {
      if (mode === "retry") {
        const ok = await confirmDialog({
          title: "Retry from scratch?",
          description: `A fresh branch is created from ${meta?.baseBranch}; the failed attempt stays on ${meta?.taskBranch}.`,
          confirmLabel: "Retry",
        })
        if (!ok) return
      }
      await resumeAgentTask(chat, messages, mode, draft.trim() || undefined)
      setDraft("")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not resume")
    } finally {
      setBusy(false)
    }
  }

  const steer = async () => {
    const text = draft.trim()
    if (!text) return
    setDraft("")
    try {
      await steerAgent(chat, text)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not send")
    }
  }

  const cancel = async () => {
    if (!meta) return
    try {
      await api.cancelSession(meta.runnerSessionId)
      toast.info("Stopping — unfinished work is checkpointed to the branch")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Cancel failed")
    }
  }

  const remove = async () => {
    const ok = await confirmDialog({
      title: "Delete this session?",
      description: "Removes the chat from this device and tears down the runner session. Pushed branches and PRs stay on GitHub.",
      confirmLabel: "Delete",
      destructive: true,
    })
    if (!ok) return
    if (meta) await api.deleteSession(meta.runnerSessionId).catch(() => undefined)
    await deleteChat(chat.id)
    navigate("/code")
  }

  return (
    <>
      <ChatHeader
        title={chat.title}
        subtitle={meta ? `${meta.repo} · ${meta.taskBranch}` : undefined}
        onOpenSidebar={openSidebar}
        newPath="/code"
        actions={
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Session options">
                <MoreVerticalIcon className="size-5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {live && meta && (
                <>
                  <DropdownMenuItem onClick={() => void cancel()}>
                    <CircleStopIcon /> Stop task
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => {
                      void api
                        .finaliseSession(meta.runnerSessionId)
                        .then(() => toast.success("Finalising — pushing and opening a PR"))
                        .catch((e) => toast.error(e instanceof Error ? e.message : "Failed"))
                    }}
                  >
                    <ListRestartIcon /> Push &amp; open PR now
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              )}
              <DropdownMenuItem variant="destructive" onClick={() => void remove()}>
                <Trash2Icon /> Delete session
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        }
      />

      <div className="flex items-center justify-center gap-2 border-b border-border/50 bg-muted/30 px-4 py-1.5">
        {meta && <StatusChip status={meta.status} />}
        {conn === "offline" && live && (
          <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <WifiOffIcon className="size-3" /> reconnecting…
          </span>
        )}
        {meta?.prUrl && (
          <a
            href={meta.prUrl}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 text-[11px] font-medium text-primary"
          >
            <GitPullRequestIcon className="size-3" /> View PR
          </a>
        )}
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto max-w-3xl space-y-5 py-4">
          {messages.map((m) =>
            m.role === "user" ? (
              <div key={m.id} className="flex justify-end px-4">
                <div className="max-w-[85%] whitespace-pre-wrap rounded-3xl rounded-br-lg bg-bubble-user px-4 py-2.5 text-[14.5px]">
                  {m.content}
                </div>
              </div>
            ) : (
              <AgentAssistantMessage key={m.id} msg={m} live={live && m.id === lastMsg?.id} />
            ),
          )}
          {meta?.status === "interrupted" && (
            <p className="px-4 text-[12.5px] text-muted-foreground">
              The runner restarted mid-task. Work may exist on{" "}
              <span className="font-mono">{meta.taskBranch}</span> — Continue starts a fresh
              session from that branch.
            </p>
          )}
        </div>
      </div>

      <div className="mx-auto w-full max-w-3xl px-3 pb-safe-plus">
        {live ? (
          <div className="flex items-end gap-2 rounded-3xl border border-input bg-card p-2 shadow-sm">
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Steer the agent…"
              rows={1}
              className="min-h-9 flex-1 resize-none border-0 bg-transparent p-2 text-[16px] shadow-none focus-visible:ring-0 md:text-[14px]"
            />
            {draft.trim() ? (
              <Button size="icon-sm" aria-label="Send" onClick={() => void steer()}>
                <ArrowUpIcon />
              </Button>
            ) : (
              <Button
                size="icon-sm"
                variant="outline"
                aria-label="Stop task"
                onClick={() => void cancel()}
              >
                <CircleStopIcon />
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Follow up on this task (optional)…"
              rows={1}
              className="min-h-10 resize-none rounded-2xl text-[16px] md:text-[14px]"
            />
            <div className="flex gap-2">
              <Button className="flex-1" disabled={busy} onClick={() => void resume("continue")}>
                <PlayIcon /> Continue{meta?.status === "completed" ? " / follow up" : ""}
              </Button>
              <Button
                variant="outline"
                className="flex-1"
                disabled={busy}
                onClick={() => void resume("retry")}
              >
                <RotateCcwIcon /> Retry fresh
              </Button>
            </div>
            <p className="px-1 text-center text-[11px] leading-snug text-muted-foreground">
              Continue seeds a new sandbox from <span className="font-mono">{meta?.taskBranch}</span>{" "}
              plus this transcript; git is authoritative.
            </p>
          </div>
        )}
      </div>
    </>
  )
}

/* ---------------------------------------------------------------- page ---- */

export default function CodePage() {
  const { chatId } = useParams()
  const chat = useChat(chatId)
  return (
    <AppShell>
      {(openSidebar) =>
        chatId && chat ? (
          <SessionView key={chat.id} chat={chat} openSidebar={openSidebar} />
        ) : (
          <CodeList openSidebar={openSidebar} />
        )
      }
    </AppShell>
  )
}
