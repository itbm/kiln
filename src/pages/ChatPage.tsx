import { useEffect, useMemo, useRef, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import {
  CloudUploadIcon,
  DownloadIcon,
  GhostIcon,
  MoreVerticalIcon,
  PencilIcon,
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
import { db, deleteChat } from "@/lib/db"
import { regenerateLast, sendUserMessage } from "@/lib/engine"
import { exportChatFile, uploadChatToServer } from "@/lib/sync"
import type { Attachment, Chat, Effort, ModelRef } from "@/lib/types"
import { uid } from "@/lib/utils"
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

  const updateSkills = async (ids: string[]) => {
    setPendingSkills(ids)
    if (chat) {
      if (chat.temporary) useTemp.getState().patchChat(chat.id, { skillIds: ids })
      else await db.chats.update(chat.id, { skillIds: ids })
    }
  }

  const renameChat = async () => {
    if (!chat) return
    const title = window.prompt("Rename chat", chat.title)
    if (!title?.trim()) return
    if (chat.temporary)
      useTemp.getState().patchChat(chat.id, { title: title.trim(), titleIsManual: true })
    else await db.chats.update(chat.id, { title: title.trim(), titleIsManual: true })
  }

  const removeChat = async () => {
    if (!chat) return
    if (!window.confirm(`Delete “${chat.title}”? This cannot be undone.`)) return
    if (chat.temporary) useTemp.getState().remove(chat.id)
    else await deleteChat(chat.id)
    navigate("/")
  }

  const lastMsg = messages[messages.length - 1]
  const showContinue =
    !generating && lastMsg?.role === "assistant" && lastMsg.status === "interrupted"

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
                  <MessageView
                    key={m.id}
                    msg={m}
                    isLast={i === messages.length - 1 && m.role === "assistant"}
                    onRetry={retry}
                    onOpenArtifact={setArtifact}
                  />
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
            <Composer
              generating={generating}
              modelRef={modelRef}
              effort={effort}
              onModelChange={setModelRef}
              onEffortChange={setEffort}
              onSend={(t, a) => void send(t, a)}
              onStop={() => chatId && useStream.getState().stop(chatId)}
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
