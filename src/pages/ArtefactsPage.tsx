import { useMemo, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useNavigate } from "react-router-dom"
import { AmphoraIcon, MessageSquareIcon, SearchIcon } from "lucide-react"
import { AppShell } from "@/components/layout/AppShell"
import { ChatHeader } from "@/components/layout/ChatHeader"
import {
  ArtifactViewer,
  artifactIcon,
  typeLabel,
} from "@/components/chat/ArtifactView"
import { ImageLightbox } from "@/components/chat/ImageLightbox"
import { Button } from "@/components/ui/button"
import { extractArtifacts, type ArtifactBlock } from "@/lib/artifacts"
import { db } from "@/lib/db"
import type { GenImage } from "@/lib/types"
import { cn, timeAgo } from "@/lib/utils"

interface EntryBase {
  chatId: string
  /** route back to the source chat (image sessions live under /images) */
  chatPath: string
  chatTitle: string
  createdAt: number
}

type Entry =
  | (EntryBase & { kind: "artifact"; artifact: ArtifactBlock })
  | (EntryBase & { kind: "image"; image: GenImage })

const FILTERS = [
  { key: "all", label: "All" },
  { key: "image", label: "Images" },
  { key: "text/markdown", label: "Documents" },
  { key: "text/html", label: "Pages" },
  { key: "application/code", label: "Code" },
  { key: "image/svg+xml", label: "SVG" },
] as const

export default function ArtefactsPage() {
  const navigate = useNavigate()
  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState<string>("all")
  const [open, setOpen] = useState<ArtifactBlock | null>(null)
  const [viewer, setViewer] = useState<string | null>(null)

  const entries = useLiveQuery(async (): Promise<Entry[]> => {
    const [messages, chats] = await Promise.all([
      db.messages
        .filter(
          (m) =>
            m.role === "assistant" &&
            (m.content.includes("<artifact") || (m.images?.length ?? 0) > 0),
        )
        .toArray(),
      db.chats.toArray(),
    ])
    const chatById = new Map(chats.map((c) => [c.id, c]))
    const out: Entry[] = []
    for (const m of messages) {
      const chat = chatById.get(m.chatId)
      const base: EntryBase = {
        chatId: m.chatId,
        chatPath: `/${chat?.kind === "image" ? "images" : "chat"}/${m.chatId}`,
        chatTitle: chat?.title ?? "Deleted chat",
        createdAt: m.createdAt,
      }
      for (const artifact of extractArtifacts(m.content)) {
        if (!artifact.complete) continue
        out.push({ ...base, kind: "artifact", artifact })
      }
      for (const image of m.images ?? []) {
        out.push({ ...base, kind: "image", image })
      }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt)
  }, [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (entries ?? []).filter((e) => {
      const type = e.kind === "artifact" ? e.artifact.type : "image"
      if (filter !== "all" && type !== filter) return false
      if (!q) return true
      if (e.chatTitle.toLowerCase().includes(q)) return true
      return (
        e.kind === "artifact" &&
        (e.artifact.title.toLowerCase().includes(q) ||
          e.artifact.content.toLowerCase().includes(q))
      )
    })
  }, [entries, query, filter])

  return (
    <AppShell>
      {(openSidebar) => (
        <>
          <ChatHeader title="Artefacts" onOpenSidebar={openSidebar} />

          <div className="mx-auto w-full max-w-3xl space-y-2 px-4 pt-3">
            <div className="flex items-center gap-2 rounded-xl border border-border/70 bg-card px-3 py-2">
              <SearchIcon className="size-4 text-muted-foreground" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search artefacts"
                className="w-full bg-transparent text-[16px] outline-none placeholder:text-muted-foreground/70 md:text-[13.5px]"
              />
            </div>
            <div className="flex gap-1.5 overflow-x-auto scrollbar-none">
              {FILTERS.map((f) => (
                <button
                  key={f.key}
                  onClick={() => setFilter(f.key)}
                  className={cn(
                    "shrink-0 rounded-full border px-3 py-1 text-[12.5px] font-medium transition-colors",
                    filter === f.key
                      ? "border-primary/40 bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:bg-accent",
                  )}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <div className="mx-auto max-w-3xl space-y-1.5 px-4 py-3 pb-safe-plus">
              {entries !== undefined && filtered.length === 0 ? (
                <div className="flex flex-col items-center gap-3 px-8 py-16 text-center">
                  <AmphoraIcon className="size-9 text-primary/50" />
                  <p className="text-[14px] text-muted-foreground">
                    {query || filter !== "all"
                      ? "No artefacts match."
                      : "Nothing fired yet. Ask for a document, web page or code file in any chat — or generate an image — and it will appear here."}
                  </p>
                </div>
              ) : (
                filtered.map((e, i) => {
                  const key =
                    e.kind === "artifact"
                      ? `${e.chatId}-${e.artifact.id}-${i}`
                      : e.image.id
                  const Icon =
                    e.kind === "artifact" ? artifactIcon(e.artifact.type) : null
                  return (
                    <div
                      key={key}
                      className="flex items-center gap-3 rounded-2xl border border-border bg-card p-3 transition hover:border-primary/40"
                    >
                      <button
                        onClick={() =>
                          e.kind === "artifact"
                            ? setOpen(e.artifact)
                            : setViewer(e.image.dataUrl)
                        }
                        className="flex min-w-0 flex-1 items-center gap-3 text-left"
                      >
                        {e.kind === "artifact" && Icon ? (
                          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                            <Icon className="size-5" />
                          </div>
                        ) : e.kind === "image" ? (
                          <img
                            src={e.image.dataUrl}
                            alt=""
                            className="size-10 shrink-0 rounded-xl border border-border object-cover"
                          />
                        ) : null}
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[14px] font-medium">
                            {e.kind === "artifact" ? e.artifact.title : e.chatTitle}
                          </div>
                          <div className="truncate text-[12px] text-muted-foreground">
                            {e.kind === "artifact"
                              ? `${typeLabel(e.artifact)} · ${e.chatTitle}`
                              : "Generated image"}{" "}
                            · {timeAgo(e.createdAt)}
                          </div>
                        </div>
                      </button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Open chat"
                        className="text-muted-foreground"
                        onClick={() => navigate(e.chatPath)}
                      >
                        <MessageSquareIcon />
                      </Button>
                    </div>
                  )
                })
              )}
            </div>
          </div>

          <ArtifactViewer artifact={open} onClose={() => setOpen(null)} />
          <ImageLightbox src={viewer} onClose={() => setViewer(null)} />
        </>
      )}
    </AppShell>
  )
}
