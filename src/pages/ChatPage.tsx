import { Fragment, useEffect, useMemo, useRef, useState } from "react"
import { useNavigate, useParams, useSearchParams } from "react-router-dom"
import {
  ArrowDownIcon,
  ChartColumnIcon,
  ClipboardCopyIcon,
  CloudUploadIcon,
  DownloadIcon,
  GhostIcon,
  KeyIcon,
  MoreVerticalIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  ScissorsIcon,
  SearchIcon,
  Share2Icon,
  SparklesIcon,
  Trash2Icon,
} from "lucide-react"
import { toast } from "sonner"
import { AppShell } from "@/components/layout/AppShell"
import { ChatHeader } from "@/components/layout/ChatHeader"
import { Composer } from "@/components/chat/Composer"
import { FindBar } from "@/components/chat/FindBar"
import { MessageView } from "@/components/chat/MessageView"
import { ArtifactViewer } from "@/components/chat/ArtifactView"
import { QuestionsSheet } from "@/components/chat/QuestionsSheet"
import { replyToForgeJob } from "@/lib/forge"
import { UsageStatsDialog } from "@/components/chat/UsageStatsDialog"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useChat, useChatMessages } from "@/hooks/use-chat-data"
import type { ArtifactBlock } from "@/lib/artifacts"
import { commandHelpText } from "@/lib/commands"
import { clearContext, compactChat, estimateWireTokens } from "@/lib/compact"
import { db, deleteChat } from "@/lib/db"
import { clearDraft, NEW_CHAT_DRAFT } from "@/lib/drafts"
import {
  editUserMessage,
  persistMessage,
  regenerateChatTitle,
  regenerateReply,
  sendUserMessage,
} from "@/lib/engine"
import { branchChat } from "@/lib/branch"
import { dayLabel, sameDay } from "@/lib/time"
import {
  findQuestions,
  formatAnswers,
  type QAnswer,
  type QuestionsBlock,
} from "@/lib/questions"
import { revealMessage } from "@/lib/find"
import {
  canShare,
  copyChatMarkdown,
  downloadChatMarkdown,
  exportChatFile,
  shareChatMarkdown,
  uploadChatToServer,
} from "@/lib/sync"
import type {
  Attachment,
  Chat,
  ChatRuntime,
  Effort,
  Message,
  ModelRef,
} from "@/lib/types"
import { uid } from "@/lib/utils"
import { switchToVersion } from "@/lib/versions"
import { useAppTheme } from "@/hooks/use-theme"
import { PROVIDER_NAMES } from "@/lib/providers"
import { confirmDialog, promptDialog } from "@/stores/dialogs"
import { displayModelName, findModel } from "@/stores/models"
import { useSettings } from "@/stores/settings"
import { useStream } from "@/stores/stream"
import { useTemp } from "@/stores/temp"

function Greeting() {
  const name = useSettings((s) => s.personalization.name)
  const theme = useAppTheme()
  const h = new Date().getHours()
  const sal = h < 5 ? "Good night" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening"
  if (theme.features.brandGreeting)
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-8 pb-24 text-center">
        {/* Pip's home ring — he perches (and throws axes) here */}
        <div aria-hidden data-ui="greet-perch" data-pip-spot="ring" />
        <h2 data-ui="greet-hi">
          {sal}
          {name ? `, ${name}` : ""}
          <span data-ui="grad">.</span>
        </h2>
        <p className="mt-2 text-[13.5px] text-muted-foreground">
          How can I help you today?
        </p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <span data-ui="tag" data-hot="true">
            keys stay on this device
          </span>
          <span data-ui="tag">no accounts · no analytics</span>
        </div>
      </div>
    )
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 pb-24 text-center">
      <div className="text-3xl">✳</div>
      <h2 className="font-serif text-[26px] leading-snug">
        {sal}
        {name ? `, ${name}` : ""}
      </h2>
      <p className="text-[14px] text-muted-foreground">
        How can I help you today?
      </p>
    </div>
  )
}

/** First-run state: no provider keys configured yet. */
function Welcome() {
  const navigate = useNavigate()
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 pb-16 text-center">
      <img src="/icons/icon.svg" alt="" className="size-16 rounded-2xl shadow-md" />
      <h2 className="mt-1 font-serif text-[26px] leading-snug">Welcome to Kiln</h2>
      <p className="max-w-72 text-[14px] leading-relaxed text-muted-foreground">
        A private AI chat that lives on your phone. Bring your own OpenRouter
        or Ollama cloud key — your chats and keys never leave this device.
      </p>
      <Button className="mt-2 rounded-full" onClick={() => navigate("/settings")}>
        <KeyIcon /> Add API keys
      </Button>
      <p className="text-[12px] text-muted-foreground/70">
        Takes about a minute. Keys are stored only in this browser.
      </p>
    </div>
  )
}

export default function ChatPage() {
  const { chatId } = useParams()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const chat = useChat(chatId)
  const messages = useChatMessages(chatId)

  const lastModel = useSettings((s) => s.lastModel)
  const lastEffort = useSettings((s) => s.lastEffort)
  const lastRuntime = useSettings((s) => s.lastRuntime)
  const hasKeys = useSettings((s) => !!s.openrouterKey || !!s.ollamaKey)
  const skills = useSettings((s) => s.skills)
  const defaultSkillIds = useMemo(
    () => skills.filter((sk) => sk.enabled).map((sk) => sk.id),
    [skills],
  )

  const [modelRef, setModelRef] = useState<ModelRef | null>(lastModel)
  const [effort, setEffort] = useState<Effort>(lastEffort)
  const [runtime, setRuntime] = useState<ChatRuntime>(lastRuntime)
  const [pendingTemp, setPendingTemp] = useState(false)
  const [pendingSkills, setPendingSkills] = useState<string[]>(defaultSkillIds)
  const [artifact, setArtifact] = useState<ArtifactBlock | null>(null)
  const [statsOpen, setStatsOpen] = useState(false)
  const [find, setFind] = useState<{ query: string } | null>(null)
  const [atBottom, setAtBottom] = useState(true)
  const [questionsFor, setQuestionsFor] = useState<{
    msg: Message
    block: QuestionsBlock
  } | null>(null)
  /** code chats: the message carrying a question the agent is blocked on */
  const [askFor, setAskFor] = useState<Message | null>(null)

  const generating = useStream((s) => (chatId ? !!s.generating[chatId] : false))
  // subscribe to live stream length so auto-scroll follows tokens
  const liveLen = useStream((s) => {
    const id = chatId ? s.generating[chatId] : undefined
    return id ? (s.live[id]?.content.length ?? 0) + (s.live[id]?.reasoning.length ?? 0) : 0
  })

  const scrollRef = useRef<HTMLDivElement>(null)
  const nearBottom = useRef(true)

  useEffect(() => {
    // reset composer state when switching chats
    setFind(null)
    setAtBottom(true)
    if (chat) {
      setModelRef(
        chat.model && chat.provider
          ? { provider: chat.provider, model: chat.model }
          : lastModel,
      )
      setEffort(chat.effort ?? lastEffort)
      setRuntime(chat.runtime ?? "local")
    } else if (!chatId) {
      setModelRef(lastModel)
      setEffort(lastEffort)
      setRuntime(lastRuntime)
      setPendingTemp(false)
      setPendingSkills(defaultSkillIds)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat?.id, chatId])

  useEffect(() => {
    const el = scrollRef.current
    if (el && nearBottom.current) el.scrollTop = el.scrollHeight
  }, [messages.length, liveLen, chatId])

  // when the on-screen keyboard opens the scroll area shrinks — keep the
  // latest message in view instead of letting the composer cover it
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const onResize = () => {
      requestAnimationFrame(() => {
        const el = scrollRef.current
        if (el && nearBottom.current) el.scrollTop = el.scrollHeight
      })
    }
    vv.addEventListener("resize", onResize)
    return () => vv.removeEventListener("resize", onResize)
  }, [])

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight
    nearBottom.current = gap < 120
    // wider band for the button so it doesn't blink in and out while reading
    const near = gap < 240
    setAtBottom((v) => (v === near ? v : near))
  }

  const jumpToLatest = () => {
    const el = scrollRef.current
    if (!el) return
    nearBottom.current = true
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" })
  }

  /* Arriving from a sidebar search result: land on the message that matched
     (?m=), with the find bar primed to step through the rest (?q=). */
  const jumpMsg = searchParams.get("m")
  const jumpQuery = searchParams.get("q")
  useEffect(() => {
    if (!jumpMsg || !messages.length) return
    const frame = requestAnimationFrame(() => {
      const el = scrollRef.current
      if (!el) return
      if (revealMessage(el, jumpMsg)) {
        nearBottom.current = false
        setAtBottom(false)
        if (jumpQuery) setFind({ query: jumpQuery })
      }
      // spent either way: a stale link must not re-fire on the next message
      setSearchParams({}, { replace: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [jumpMsg, jumpQuery, messages.length, setSearchParams])

  // desktop: ⌘/Ctrl+F finds inside the conversation, not the whole document
  useEffect(() => {
    if (!chatId) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault()
        setFind((f) => f ?? { query: "" })
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [chatId])

  // Auto-open the questions sheet when a reply that ends in a <questions>
  // block finishes streaming (not when merely browsing an old chat).
  const prevGenerating = useRef(false)
  useEffect(() => {
    const justFinished = prevGenerating.current && !generating
    prevGenerating.current = generating
    if (!justFinished || questionsFor) return
    const last = messages[messages.length - 1]
    if (
      !last ||
      last.role !== "assistant" ||
      last.status !== "done" ||
      last.questionsAnswered
    )
      return
    const block = findQuestions(last.content)
    if (block) setQuestionsFor({ msg: last, block })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generating, messages])

  /**
   * A code chat's question is different in kind from a `<questions>` block:
   * the agent is *blocked* on it, so the answer goes back to the running job
   * rather than becoming the next user message. Clearing `ask` locally is
   * what dismisses the chips; the turn then carries on streaming.
   */
  const submitAsk = async (msg: Message, answers: QAnswer[]) => {
    if (!msg.ask || !chat) return
    const answer = answers[0]?.answer ?? ""
    await replyToForgeJob(msg.ask.jobId, msg.ask.requestId, answer)
    setAskFor(null)
    useStream.getState().update(msg.id, { ask: undefined })
    await persistMessage({ ...msg, ask: undefined }, !!chat.temporary)
  }

  const submitAnswers = async (answers: QAnswer[]) => {
    if (!questionsFor || !chat) return
    await persistMessage(
      { ...questionsFor.msg, questionsAnswered: true },
      !!chat.temporary,
    )
    setQuestionsFor(null)
    await send(formatAnswers(answers), [])
  }

  const send = async (text: string, attachments: Attachment[]) => {
    if (!modelRef) return
    nearBottom.current = true
    if (chat) {
      // carry the pill's current choice even if the live-query hasn't
      // caught up with a just-made runtime change
      const current: Chat = chat.temporary ? chat : { ...chat, runtime }
      void sendUserMessage({ chat: current, history: messages, text, attachments, modelRef, effort })
    } else {
      const id = uid()
      const now = Date.now()
      const newChat: Chat = {
        id,
        kind: "chat",
        title: "New chat",
        createdAt: now,
        updatedAt: now,
        provider: modelRef.provider,
        model: modelRef.model,
        effort,
        // ghost chats promise to stay off every disk — theirs and the server's
        runtime: pendingTemp || runtime === "local" ? undefined : runtime,
        skillIds: pendingSkills,
        temporary: pendingTemp,
      }
      if (pendingTemp) useTemp.getState().putChat(newChat)
      else await db.chats.add(newChat)
      navigate(`/chat/${id}`)
      void sendUserMessage({ chat: newChat, history: [], text, attachments, modelRef, effort })
    }
  }

  /* Any reply can be regenerated, not just the last — but the messages that
     came after it answered the generation being replaced, so they go too. */
  const retry = async (msg: Message) => {
    if (!chat || !modelRef || generating) return
    const idx = messages.findIndex((m) => m.id === msg.id)
    const after = messages.slice(idx + 1)
    if (after.length) {
      const ok = await confirmDialog({
        title: "Regenerate this reply?",
        description: `The ${after.length} message${after.length === 1 ? "" : "s"} after this one will be replaced by a new reply.`,
        confirmLabel: "Regenerate",
      })
      if (!ok) return
    }
    nearBottom.current = true
    const current: Chat = chat.temporary ? chat : { ...chat, runtime }
    void regenerateReply(current, messages, msg, modelRef, effort)
  }

  /** The non-destructive version: carry on from this reply in a copy. */
  const branch = async (msg: Message) => {
    if (!chat) return
    try {
      const id = await branchChat(chat, messages, msg)
      navigate(`/chat/${id}`)
      toast.success("Branched into a new chat")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't branch this chat")
    }
  }

  const togglePin = async () => {
    if (!chat) return
    if (chat.temporary) {
      toast.error("Temporary chats vanish on reload — save it to history first")
      return
    }
    const pinned = chat.pinned ? undefined : Date.now()
    await db.chats.update(chat.id, { pinned })
    toast.success(pinned ? "Pinned to the top" : "Unpinned")
  }

  const handleSwitchVersion = async (msg: Message, target: number) => {
    if (generating) return
    await persistMessage(switchToVersion(msg, target), !!chat?.temporary)
  }

  const handleEditUser = async (msg: Message, newText: string) => {
    if (!chat || !modelRef || generating) return
    const idx = messages.findIndex((m) => m.id === msg.id)
    const after = messages.slice(idx + 1)
    if (after.length) {
      const ok = await confirmDialog({
        title: "Edit and resend?",
        description: `The ${after.length} message${after.length === 1 ? "" : "s"} after this one will be replaced by a new reply.`,
        confirmLabel: "Edit & resend",
      })
      if (!ok) return
    }
    nearBottom.current = true
    const current: Chat = chat.temporary ? chat : { ...chat, runtime }
    void editUserMessage(current, messages, msg, newText, modelRef, effort)
  }

  const runCompact = async (instructions?: string) => {
    if (!chat) return
    const id = toast.loading("Compacting conversation…")
    try {
      const { summarizedCount } = await compactChat(chat, messages, {
        instructions,
      })
      toast.success(
        `Compacted ${summarizedCount} message${summarizedCount === 1 ? "" : "s"} into a summary`,
        { id },
      )
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Compaction failed", { id })
    }
  }

  const handleCommand = (name: string, arg?: string) => {
    if (name === "help") {
      void confirmDialog({
        title: "Slash commands",
        description: commandHelpText(),
        confirmLabel: "OK",
      })
      return
    }
    if (!chat) {
      toast.error(`/${name} needs an active chat`)
      return
    }
    switch (name) {
      case "compact":
        void runCompact(arg)
        break
      case "find":
        setFind({ query: arg ?? "" })
        break
      case "clear":
        void clearContext(chat).then(() =>
          toast.success("Context cleared — messages stay visible, but aren't resent"),
        )
        break
      case "title":
        if (arg) {
          void (chat.temporary
            ? useTemp.getState().patchChat(chat.id, { title: arg, titleIsManual: true })
            : db.chats.update(chat.id, { title: arg, titleIsManual: true }))
        } else {
          void regenerateChatTitle(chat, messages)
            .then(() => toast.success("Title regenerated"))
            .catch((e) => toast.error(e.message))
        }
        break
      case "export": {
        const format = (arg ?? "json").toLowerCase()
        if (format === "md" || format === "markdown")
          downloadChatMarkdown(chat, messages)
        else if (format === "json") void exportChatFile(chat)
        else toast.error("Usage: /export [json|md]")
        break
      }
      case "stats":
        setStatsOpen(true)
        break
      case "pin":
        void togglePin()
        break
    }
  }

  const updateSkills = async (ids: string[]) => {
    setPendingSkills(ids)
    if (chat) {
      if (chat.temporary) useTemp.getState().patchChat(chat.id, { skillIds: ids })
      else await db.chats.update(chat.id, { skillIds: ids })
    }
  }

  /** Local/Cloud choice: applies from the next turn, remembered for new chats. */
  const changeRuntime = async (r: ChatRuntime) => {
    setRuntime(r)
    useSettings.getState().set({ lastRuntime: r })
    if (chat && !chat.temporary)
      await db.chats.update(chat.id, { runtime: r === "local" ? undefined : r })
  }

  const renameChat = async () => {
    if (!chat) return
    const title = await promptDialog({
      title: "Rename chat",
      initial: chat.title,
      confirmLabel: "Rename",
    })
    if (!title) return
    if (chat.temporary)
      useTemp.getState().patchChat(chat.id, { title, titleIsManual: true })
    else await db.chats.update(chat.id, { title, titleIsManual: true })
  }

  const removeChat = async () => {
    if (!chat) return
    const ok = await confirmDialog({
      title: `Delete “${chat.title}”?`,
      description: "This cannot be undone.",
      confirmLabel: "Delete",
      destructive: true,
    })
    if (!ok) return
    clearDraft(chat.id)
    if (chat.temporary) useTemp.getState().remove(chat.id)
    else await deleteChat(chat.id)
    navigate("/")
  }

  const lastMsg = messages[messages.length - 1]
  const showContinue =
    !generating && lastMsg?.role === "assistant" && lastMsg.status === "interrupted"

  // context usage estimate for the meter pill
  const ctxUsage = useMemo(() => {
    if (!chat || chat.kind !== "chat" || messages.length < 2) return null
    const ctx = findModel(modelRef)?.ctx ?? 131_072
    return Math.min(1, estimateWireTokens(chat, messages) / ctx)
  }, [chat, messages, modelRef])

  const theme = useAppTheme()
  const brandChrome = !!theme.features.brandChrome
  // Ember chrome: wordmark on the empty home screen, model line under the title
  const isHome = !chatId && messages.length === 0
  const headerTitle = brandChrome && isHome ? "Kiln" : (chat?.title ?? "New chat")
  // A code chat's subtitle says what it is working on rather than which
  // model — the repository and the base → work branch pair are the facts you
  // need to trust what it is about to push.
  const headerSubtitle =
    chat?.kind === "code" && chat.repo
      ? `${chat.repo.owner}/${chat.repo.name} · ${chat.repo.baseBranch} → ${chat.repo.workBranch}`
      : brandChrome && chat && modelRef
        ? `${displayModelName(modelRef)} · ${PROVIDER_NAMES[modelRef.provider]}`
        : undefined

  // index of the last message covered by the compaction summary
  const cutoff = chat?.summaryCutoff ?? 0
  let lastCoveredIdx = -1
  if (cutoff) {
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].createdAt <= cutoff) lastCoveredIdx = i
    }
  }

  return (
    <AppShell>
      {(openSidebar) => (
        <>
          <ChatHeader
            title={headerTitle}
            subtitle={headerSubtitle}
            wordmark={brandChrome && isHome}
            temporary={chat?.temporary ?? (!chatId && pendingTemp)}
            onOpenSidebar={openSidebar}
            actions={
              chat ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-sm" aria-label="Chat options">
                      <MoreVerticalIcon className="size-5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => void renameChat()}>
                      <PencilIcon /> Rename
                    </DropdownMenuItem>
                    {!chat.temporary && (
                      <DropdownMenuItem onClick={() => void togglePin()}>
                        {chat.pinned ? (
                          <>
                            <PinOffIcon /> Unpin
                          </>
                        ) : (
                          <>
                            <PinIcon /> Pin to top
                          </>
                        )}
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem onClick={() => setFind({ query: "" })}>
                      <SearchIcon /> Find in chat
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setStatsOpen(true)}>
                      <ChartColumnIcon /> Usage & cost
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() =>
                        copyChatMarkdown(chat, messages)
                          .then(() => toast.success("Chat copied as Markdown"))
                          .catch(() => toast.error("Couldn't copy the chat"))
                      }
                    >
                      <ClipboardCopyIcon /> Copy as Markdown
                    </DropdownMenuItem>
                    {canShare() && (
                      <DropdownMenuItem
                        onClick={() =>
                          shareChatMarkdown(chat, messages).catch((e) =>
                            toast.error(e instanceof Error ? e.message : "Sharing failed"),
                          )
                        }
                      >
                        <Share2Icon /> Share…
                      </DropdownMenuItem>
                    )}
                    {chat.temporary ? (
                      <DropdownMenuItem
                        onClick={() => {
                          void useTemp.getState().saveToHistory(chat.id)
                          toast.success("Saved to history")
                        }}
                      >
                        <DownloadIcon /> Save to history
                      </DropdownMenuItem>
                    ) : (
                      <>
                        <DropdownMenuItem onClick={() => void exportChatFile(chat)}>
                          <DownloadIcon /> Export JSON
                        </DropdownMenuItem>
                        {useSettings.getState().syncUrl && (
                          <DropdownMenuItem
                            onClick={() =>
                              uploadChatToServer(chat)
                                .then(() => toast.success("Chat uploaded"))
                                .catch((e) => toast.error(e.message))
                            }
                          >
                            <CloudUploadIcon /> Send to server
                          </DropdownMenuItem>
                        )}
                      </>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onClick={() => void removeChat()}>
                      <Trash2Icon /> Delete chat
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : undefined
            }
          />

          {(chat?.temporary ?? (!chatId && pendingTemp)) && (
            <div className="flex items-center justify-center gap-1.5 bg-primary/8 px-4 py-1.5 text-[12px] text-primary">
              <GhostIcon className="size-3.5" />
              Temporary chat — cleared when you close the app
            </div>
          )}

          {!chatId && messages.length === 0 ? (
            hasKeys ? (
              <Greeting />
            ) : (
              <Welcome />
            )
          ) : (
            <div
              ref={scrollRef}
              onScroll={onScroll}
              className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
            >
              <div className="mx-auto max-w-3xl space-y-5 py-4">
                {messages.map((m, i) => (
                  <Fragment key={m.id}>
                    {(i === 0 || !sameDay(messages[i - 1].createdAt, m.createdAt)) && (
                      <div
                        className="flex items-center gap-2 px-4 text-[11px] text-muted-foreground"
                        data-ui="day-divider"
                        data-find-skip
                      >
                        <div className="h-px flex-1 bg-border" data-ui="divider-line" />
                        <span>{dayLabel(m.createdAt)}</span>
                        <div className="h-px flex-1 bg-border" data-ui="divider-line" />
                      </div>
                    )}
                    <MessageView
                      msg={m}
                      busy={generating}
                      onRetry={(msg) => void retry(msg)}
                      onBranch={(msg) => void branch(msg)}
                      onOpenArtifact={setArtifact}
                      onEditUser={(msg, text) => void handleEditUser(msg, text)}
                      onSwitchVersion={(msg, target) =>
                        void handleSwitchVersion(msg, target)
                      }
                      onOpenQuestions={(msg, block) =>
                        setQuestionsFor({ msg, block })
                      }
                      onOpenAsk={(msg) => setAskFor(msg)}
                    />
                    {i === lastCoveredIdx && (
                      <div
                        className="flex items-center gap-2 px-4 text-[11px] text-muted-foreground"
                        data-ui="compact-divider"
                      >
                        <div className="h-px flex-1 bg-border" data-ui="divider-line" />
                        <SparklesIcon className="size-3 shrink-0" />
                        <span>
                          Compacted — messages above are summarised for the model
                        </span>
                        <div className="h-px flex-1 bg-border" data-ui="divider-line" />
                      </div>
                    )}
                  </Fragment>
                ))}
                {showContinue && (
                  <div className="px-4">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        void send("Continue exactly where you left off.", [])
                      }
                    >
                      Continue generating
                    </Button>
                  </div>
                )}
                <div className="h-2" />
              </div>
            </div>
          )}

          {(hasKeys || !!chatId) && (
          <div className="relative mx-auto w-full max-w-3xl">
            {!atBottom && messages.length > 0 && (
              <button
                onClick={jumpToLatest}
                aria-label="Jump to latest"
                data-ui="jump-latest"
                className="absolute -top-11 left-1/2 z-10 -translate-x-1/2 rounded-full border border-border bg-card/95 p-2 text-muted-foreground shadow-md backdrop-blur active:scale-95"
              >
                <ArrowDownIcon className="size-4" />
              </button>
            )}
            {find && (
              <FindBar
                scroller={scrollRef}
                revision={messages.length + liveLen}
                initialQuery={find.query}
                onClose={() => setFind(null)}
              />
            )}
            {ctxUsage !== null && ctxUsage >= 0.6 && !generating && (
              <div className="flex justify-end px-4 pb-1">
                <button
                  onClick={() => void runCompact()}
                  data-ui="ctx-pill"
                  className="flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/8 px-2.5 py-1 text-[11.5px] font-medium text-primary active:scale-95"
                >
                  <ScissorsIcon className="size-3" />
                  {Math.round(ctxUsage * 100)}% of context — compact
                </button>
              </div>
            )}
            <Composer
              generating={generating}
              modelRef={modelRef}
              effort={effort}
              onModelChange={setModelRef}
              onEffortChange={setEffort}
              runtime={runtime}
              onRuntimeChange={
                // A code chat has no local counterpart — there is no shell or
                // checkout on the device — so the Local/Cloud pill would offer
                // a choice that doesn't exist. Temporary chats never leave the
                // device at all.
                (chat?.temporary ?? (!chatId && pendingTemp)) ||
                chat?.kind === "code"
                  ? undefined
                  : (r) => void changeRuntime(r)
              }
              onSend={(t, a) => void send(t, a)}
              onStop={() => chatId && useStream.getState().stop(chatId)}
              onCommand={handleCommand}
              draftKey={chatId ?? NEW_CHAT_DRAFT}
              draftEphemeral={chat?.temporary ?? pendingTemp}
              isNewChat={!chat}
              temporary={pendingTemp}
              onToggleTemporary={() => setPendingTemp((v) => !v)}
              skillIds={chat?.skillIds ?? pendingSkills}
              onSkillIdsChange={(ids) => void updateSkills(ids)}
            />
          </div>
          )}

          <ArtifactViewer artifact={artifact} onClose={() => setArtifact(null)} />
          {chat && (
            <UsageStatsDialog
              open={statsOpen}
              onOpenChange={setStatsOpen}
              chat={chat}
              messages={messages}
            />
          )}
          {questionsFor && (
            <QuestionsSheet
              open
              onOpenChange={(o) => {
                if (!o) setQuestionsFor(null)
              }}
              questions={questionsFor.block.questions}
              onSubmit={(answers) => void submitAnswers(answers)}
            />
          )}
          {askFor?.ask && (
            <QuestionsSheet
              open
              onOpenChange={(o) => {
                // Dismissing without answering leaves the agent blocked, which
                // is correct: it must not read a shrug as consent. The chips
                // stay on the message so it can be answered later.
                if (!o) setAskFor(null)
              }}
              questions={askFor.ask.questions}
              onSubmit={(answers) => void submitAsk(askFor, answers)}
            />
          )}
        </>
      )}
    </AppShell>
  )
}
