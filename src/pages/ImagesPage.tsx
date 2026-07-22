import { useEffect, useRef, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { ImageIcon, MoreVerticalIcon, Trash2Icon } from "lucide-react"
import { AppShell } from "@/components/layout/AppShell"
import { ChatHeader } from "@/components/layout/ChatHeader"
import { Composer } from "@/components/chat/Composer"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useChat, useChatMessages } from "@/hooks/use-chat-data"
import { db, deleteChat } from "@/lib/db"
import { confirmDialog } from "@/stores/dialogs"
import { sendUserMessage } from "@/lib/engine"
import type { Attachment, Chat, ModelRef } from "@/lib/types"
import { cn, uid } from "@/lib/utils"
import { useSettings } from "@/stores/settings"
import { useStream } from "@/stores/stream"
import { ImageLightbox } from "@/components/chat/ImageLightbox"

function PaintingTile() {
  return (
    <div
      // Pip's easel: while this tile shimmers, painter Pip perches on its top
      // edge and paints (see src/pip/anchors.ts → painterSiteSpot)
      data-art-painting="true"
      className="flex aspect-square w-full items-center justify-center rounded-2xl border border-dashed border-border bg-muted/40"
    >
      <span className="shimmer text-[14px]">Painting…</span>
    </div>
  )
}

export default function ImagesPage() {
  const { chatId } = useParams()
  const navigate = useNavigate()
  const chat = useChat(chatId)
  const messages = useChatMessages(chatId)
  const lastImageModel = useSettings((s) => s.lastImageModel)
  const [modelRef, setModelRef] = useState<ModelRef | null>(lastImageModel)
  const [viewer, setViewer] = useState<string | null>(null)

  const streamingId = useStream((s) => (chatId ? s.generating[chatId] : undefined))
  const generating = !!streamingId
  const live = useStream((s) => (streamingId ? s.live[streamingId] : undefined))

  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, live?.images.length, generating])

  useEffect(() => {
    if (chat?.model && chat.provider)
      setModelRef({ provider: chat.provider, model: chat.model })
    else if (!chatId) setModelRef(lastImageModel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat?.id, chatId])

  const send = async (text: string, attachments: Attachment[]) => {
    if (!modelRef) return
    if (chat) {
      void sendUserMessage({ chat, history: messages, text, attachments, modelRef, effort: "auto" })
    } else {
      const id = uid()
      const now = Date.now()
      const newChat: Chat = {
        id,
        kind: "image",
        title: text.slice(0, 48) || "Image session",
        createdAt: now,
        updatedAt: now,
        provider: modelRef.provider,
        model: modelRef.model,
      }
      await db.chats.add(newChat)
      navigate(`/images/${id}`)
      void sendUserMessage({ chat: newChat, history: [], text, attachments, modelRef, effort: "auto" })
    }
  }

  return (
    <AppShell>
      {(openSidebar) => (
        <>
          <ChatHeader
            title={chat?.title ?? "Images"}
            subtitle={chat ? undefined : "Generate images with AI"}
            onOpenSidebar={openSidebar}
            newPath="/images"
            actions={
              chat ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-sm" aria-label="Options">
                      <MoreVerticalIcon className="size-5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => {
                        void confirmDialog({
                          title: "Delete this image session?",
                          description: "This cannot be undone.",
                          confirmLabel: "Delete",
                          destructive: true,
                        }).then((ok) => {
                          if (ok) void deleteChat(chat.id).then(() => navigate("/images"))
                        })
                      }}
                    >
                      <Trash2Icon /> Delete session
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : undefined
            }
          />

          {!chatId && messages.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 pb-24 text-center">
              <ImageIcon className="size-8 text-primary/60" />
              <h2 className="font-serif text-[24px]">Imagine anything</h2>
              <p className="max-w-64 text-[13.5px] text-muted-foreground">
                Describe an image and an image-capable model will create it.
                Attach a photo to remix it.
              </p>
            </div>
          ) : (
            <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
              <div className="mx-auto max-w-3xl space-y-6 px-4 py-4">
                {messages.map((m) => {
                  if (m.role === "user")
                    return (
                      <div key={m.id} className="flex justify-end">
                        <div className="max-w-[85%] rounded-3xl rounded-br-lg bg-bubble-user px-4 py-2.5 text-[14.5px]">
                          {m.content}
                        </div>
                      </div>
                    )
                  // while this reply generates, the live stream overlays the
                  // throttled snapshot Dexie already has (same as MessageView)
                  const isLive = m.id === streamingId
                  const images = (isLive ? live?.images : undefined) ?? m.images ?? []
                  const content = isLive ? live?.content : m.content
                  return (
                    <div key={m.id}>
                      {(images.length > 0 || isLive) && (
                        <div
                          className={cn(
                            "grid gap-2",
                            images.length + (isLive ? 1 : 0) > 1
                              ? "grid-cols-2"
                              : "grid-cols-1",
                          )}
                        >
                          {images.map((im) => (
                            <button key={im.id} onClick={() => setViewer(im.dataUrl)}>
                              <img
                                src={im.dataUrl}
                                alt="Generated"
                                className="w-full rounded-2xl border border-border"
                              />
                            </button>
                          ))}
                          {isLive && <PaintingTile />}
                        </div>
                      )}
                      {content && (
                        <p className="mt-2 text-[13.5px] text-muted-foreground">{content}</p>
                      )}
                      {!isLive && m.status === "error" && (
                        <p className="mt-1 text-[13px] text-destructive">{m.error}</p>
                      )}
                      {!isLive && (
                        <div className="mt-1 text-[11px] text-muted-foreground">
                          {m.modelName ?? m.model}
                        </div>
                      )}
                    </div>
                  )
                })}
                {generating && !messages.some((m) => m.id === streamingId) && (
                  <div className="grid grid-cols-1 gap-2">
                    <PaintingTile />
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="mx-auto w-full max-w-3xl">
            <Composer
              imageMode
              placeholder="Describe an image…"
              generating={generating}
              modelRef={modelRef}
              effort="auto"
              onModelChange={setModelRef}
              onEffortChange={() => {}}
              onSend={(t, a) => void send(t, a)}
              onStop={() => chatId && useStream.getState().stop(chatId)}
            />
          </div>

          <ImageLightbox src={viewer} onClose={() => setViewer(null)} />
        </>
      )}
    </AppShell>
  )
}
