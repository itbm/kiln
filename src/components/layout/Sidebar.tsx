import { useEffect, useMemo, useState } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import {
  CloudUploadIcon,
  DownloadIcon,
  GhostIcon,
  ImageIcon,
  MoonIcon,
  MoreHorizontalIcon,
  PencilIcon,
  SearchIcon,
  SettingsIcon,
  SquarePenIcon,
  SunIcon,
  Trash2Icon,
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useAllChats } from "@/hooks/use-chat-data"
import { useIsDark } from "@/hooks/use-theme"
import { deleteChat, db, searchMessages } from "@/lib/db"
import { exportChatFile, uploadChatToServer } from "@/lib/sync"
import type { Chat } from "@/lib/types"
import { cn } from "@/lib/utils"
import { confirmDialog, promptDialog } from "@/stores/dialogs"
import { useSettings } from "@/stores/settings"
import { useTemp } from "@/stores/temp"

function groupLabel(ts: number): string {
  const now = new Date()
  const d = new Date(ts)
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (d >= startOfDay) return "Today"
  if (d >= new Date(startOfDay.getTime() - 86_400_000)) return "Yesterday"
  if (d >= new Date(startOfDay.getTime() - 7 * 86_400_000)) return "Previous 7 days"
  if (d >= new Date(startOfDay.getTime() - 30 * 86_400_000)) return "Previous 30 days"
  return "Older"
}

function ChatRow({
  chat,
  active,
  snippet,
  onNavigate,
}: {
  chat: Chat
  active: boolean
  snippet?: string
  onNavigate: (path: string) => void
}) {
  const syncUrl = useSettings((s) => s.syncUrl)
  const path = chat.kind === "image" ? `/images/${chat.id}` : `/chat/${chat.id}`

  const rename = async () => {
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

  const remove = async () => {
    const ok = await confirmDialog({
      title: `Delete “${chat.title}”?`,
      description: "This cannot be undone.",
      confirmLabel: "Delete",
      destructive: true,
    })
    if (!ok) return
    if (chat.temporary) useTemp.getState().remove(chat.id)
    else await deleteChat(chat.id)
    if (active) onNavigate(chat.kind === "image" ? "/images" : "/")
  }

  const upload = async () => {
    try {
      await uploadChatToServer(chat)
      toast.success("Chat uploaded to your server")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed")
    }
  }

  return (
    <div
      className={cn(
        "group flex items-center rounded-xl transition-colors",
        active ? "bg-accent" : "hover:bg-accent/60",
      )}
    >
      <button
        onClick={() => onNavigate(path)}
        className="min-w-0 flex-1 px-2.5 py-2 text-left"
      >
        <span className="flex items-center gap-2">
          {chat.temporary && <GhostIcon className="size-3.5 shrink-0 text-primary" />}
          {chat.kind === "image" && (
            <ImageIcon className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate text-[13.5px]">{chat.title}</span>
        </span>
        {snippet && (
          <span className="mt-0.5 block truncate text-[11.5px] text-muted-foreground">
            {snippet}
          </span>
        )}
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Chat options"
            className="mr-1 text-muted-foreground opacity-60 group-hover:opacity-100"
          >
            <MoreHorizontalIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onClick={rename}>
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
              {syncUrl && (
                <DropdownMenuItem onClick={() => void upload()}>
                  <CloudUploadIcon /> Send to server
                </DropdownMenuItem>
              )}
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={() => void remove()}>
            <Trash2Icon /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

export function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const chats = useAllChats()
  const [query, setQuery] = useState("")
  const navigate = useNavigate()
  const location = useLocation()
  const isDark = useIsDark()
  const setSettings = useSettings((s) => s.set)
  const theme = useSettings((s) => s.theme)

  const go = (path: string) => {
    navigate(path)
    onNavigate?.()
  }

  // full-text search over message content (debounced)
  const [contentHits, setContentHits] = useState<Map<string, string> | null>(null)
  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) {
      setContentHits(null)
      return
    }
    const t = setTimeout(() => {
      void searchMessages(q).then(setContentHits)
    }, 250)
    return () => clearTimeout(t)
  }, [query])

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = (chats ?? []).filter(
      (c) => c.title.toLowerCase().includes(q) || contentHits?.has(c.id),
    )
    const out: { label: string; chats: Chat[] }[] = []
    for (const c of filtered) {
      const label = c.temporary ? "Temporary" : groupLabel(c.updatedAt)
      const g = out.find((x) => x.label === label)
      if (g) g.chats.push(c)
      else out.push({ label, chats: [c] })
    }
    return out
  }, [chats, query, contentHits])

  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex items-center justify-between px-4 pb-1 pt-safe">
        <button
          onClick={() => go("/")}
          className="flex items-center gap-2 pt-3 font-serif text-[22px] font-semibold tracking-tight"
        >
          <img src="/icons/icon.svg" alt="" className="size-6 rounded-md" />
          Kiln
        </button>
      </div>

      <div className="space-y-0.5 px-2 pt-2">
        <button
          onClick={() => go("/")}
          className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-[13.5px] font-medium text-primary hover:bg-accent/60"
        >
          <SquarePenIcon className="size-4" /> New chat
        </button>
        <button
          onClick={() => go("/images")}
          className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-[13.5px] font-medium hover:bg-accent/60"
        >
          <ImageIcon className="size-4 text-muted-foreground" /> Images
        </button>
      </div>

      <div className="px-2 py-2">
        <div className="flex items-center gap-2 rounded-xl bg-background/70 px-2.5 py-1.5 border border-border/60">
          <SearchIcon className="size-3.5 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats"
            className="w-full bg-transparent text-[16px] outline-none placeholder:text-muted-foreground/70 md:text-[13px]"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {chats === undefined ? null : groups.length === 0 ? (
          <p className="px-2.5 py-6 text-center text-[12.5px] text-muted-foreground">
            {query ? "No chats match your search." : "No chats yet — say hello!"}
          </p>
        ) : (
          groups.map((g) => (
            <div key={g.label} className="mb-1">
              <div className="px-2.5 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/80">
                {g.label}
              </div>
              {g.chats.map((c) => (
                <ChatRow
                  key={c.id}
                  chat={c}
                  active={location.pathname.includes(c.id)}
                  snippet={contentHits?.get(c.id)}
                  onNavigate={go}
                />
              ))}
            </div>
          ))
        )}
      </div>

      <div className="flex items-center gap-1 border-t border-sidebar-border px-2 pt-2 pb-safe-plus">
        <Button
          variant="ghost"
          size="sm"
          className="flex-1 justify-start text-[13px]"
          onClick={() => go("/settings")}
        >
          <SettingsIcon /> Settings
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Toggle theme"
          onClick={() => setSettings({ theme: isDark ? "light" : "dark" })}
          title={`Theme: ${theme}`}
        >
          {isDark ? <SunIcon /> : <MoonIcon />}
        </Button>
      </div>
    </div>
  )
}
