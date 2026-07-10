import { Fragment, useEffect, useMemo, useRef, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import {
  CloudUploadIcon,
  DownloadIcon,
  GhostIcon,
  MoreVerticalIcon,
  PencilIcon,
  ScissorsIcon,
  SparklesIcon,
  Trash2Icon,
} from "lucide-react"
import { toast } from "sonner"
import { AppShell } from "@/components/layout/AppShell"
import { ChatHeader } from "@/components/layout/ChatHeader"
import { Composer } from "@/components/chat/Composer"
import { MessageView } from "@/components/chat/MessageView"
import { ArtifactViewer } from "@/components/chat/ArtifactView"
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
import {
  editUserMessage,
  persistMessage,
  regenerateChatTitle,
  regenerateLast,
  sendUserMessage,
} from "@/lib/engine"
import { exportChatFile, uploadChatToServer } from "@/lib/sync"
import type { Attachment, Chat, Effort, Message, ModelRef } from "@/lib/types"
import { uid } from "@/lib/utils"
import { switchToVersion } from "@/lib/versions"
import { confirmDialog, promptDialog } from "@/stores/dialogs"
import { findModel } from "@/stores/models"
import { useSettings } from "@/stores/settings"
import { useStream } from "@/stores/stream"
import { useTemp } from "@/stores/temp"

function Greeting() {
  const name = useSettings((s) => s.personalization.name)
  const h = new Date().getHours()
  const sal = h < 5 ? "Good night" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening"
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

export default function ChatPage() {
  const { chatId } = useParams()
  const navigate = useNavigate()
  const chat = useChat(chatId)
  const messages = useChatMessages(chatId)

  const lastModel = useSettings((s) => s.lastModel)
  const lastEffort = useSettings((s) => s.lastEffort)
  const skills = useSettings((s) => s.skills)
  const defaultSkillIds = useMemo(
    () => skills.filter((sk) => sk.enabled).map((sk) => sk.id),
    [skills],
  )

  const [modelRef, setModelRef] = useState<ModelRef | null>(lastModel)
  const [effort, setEffort] = useState<Effort>(lastEffort)
  const [pendingTemp, setPendingTemp] = useState(false)
  const [pendingSkills, setPendingSkills] = useState<string[]>(defaultSkillIds)
  const [artifact, setArtifact] = useState<ArtifactBlock | null>(null)

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
    if (chat) {
      setModelRef(
        chat.model && chat.provider
          ? { provider: chat.provider, model: chat.model }
          : lastModel,
      )
      setEffort(chat.effort ?? lastEffort)
    } else if (!chatId) {
      setModelRef(lastModel)
      setEffort(lastEffort)
      setPendingTemp(false)
      setPendingSkills(defaultSkillIds)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat?.id, chatId])

  useEffect(() => {
    const el = scrollRef.current
    if (el && nearBottom.current) el.scrollTop = el.scrollHeight
  }, [messages.length, liveLen, chatId])

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
  }

  const send = async (text: string, attachments: Attachment[]) => {
    if (!modelRef) return
    nearBottom.current = true
    if (chat) {
      void sendUserMessage({ chat, history: messages, text, attachments, modelRef, effort })
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
        skillIds: pendingSkills,
        temporary: pendingTemp,
      }
      if (pendingTemp) useTemp.getState().putChat(newChat)
      else await db.chats.add(newChat)
      navigate(`/chat/${id}`)
      void sendUserMessage({ chat: newChat, history: [], text, attachments, modelRef, effort })
    }
  }

  const retry = () => {
    if (!chat || !modelRef || generating) return
    nearBottom.current = true
    void regenerateLast(chat, messages, modelRef, effort)
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
    void editUserMessage(chat, messages, msg, newText, modelRef, effort)
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
      case "export":
        void exportChatFile(chat)
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
            title={chat?.title ?? "New chat"}
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
            <Greeting />
          ) : (
            <div
              ref={scrollRef}
              onScroll={onScroll}
              className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
            >
              <div className="mx-auto max-w-3xl space-y-5 py-4">
                {messages.map((m, i) => (
                  <Fragment key={m.id}>
                    <MessageView
                      msg={m}
                      isLast={i === messages.length - 1 && m.role === "assistant"}
                      busy={generating}
                      onRetry={retry}
                      onOpenArtifact={setArtifact}
                      onEditUser={(msg, text) => void handleEditUser(msg, text)}
                      onSwitchVersion={(msg, target) =>
                        void handleSwitchVersion(msg, target)
                      }
                    />
                    {i === lastCoveredIdx && (
                      <div className="flex items-center gap-2 px-4 text-[11px] text-muted-foreground">
                        <div className="h-px flex-1 bg-border" />
                        <SparklesIcon className="size-3 shrink-0" />
                        <span>
                          Compacted — messages above are summarised for the model
                        </span>
                        <div className="h-px flex-1 bg-border" />
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

          <div className="mx-auto w-full max-w-3xl">
            {ctxUsage !== null && ctxUsage >= 0.6 && !generating && (
              <div className="flex justify-end px-4 pb-1">
                <button
                  onClick={() => void runCompact()}
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
              onSend={(t, a) => void send(t, a)}
              onStop={() => chatId && useStream.getState().stop(chatId)}
              onCommand={handleCommand}
              isNewChat={!chat}
              temporary={pendingTemp}
              onToggleTemporary={() => setPendingTemp((v) => !v)}
              skillIds={chat?.skillIds ?? pendingSkills}
              onSkillIdsChange={(ids) => void updateSkills(ids)}
            />
          </div>

          <ArtifactViewer artifact={artifact} onClose={() => setArtifact(null)} />
        </>
      )}
    </AppShell>
  )
}
