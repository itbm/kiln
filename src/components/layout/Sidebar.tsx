import { useEffect, useMemo, useState } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import {
  AmphoraIcon,
  CloudUploadIcon,
  DownloadIcon,
  GhostIcon,
  GitBranchIcon,
  ImageIcon,
  MoonIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PencilLineIcon,
  PinIcon,
  PinOffIcon,
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
import { useDraftPreviews } from "@/hooks/use-drafts"
import { useIsDark } from "@/hooks/use-theme"
import { deleteChat, db, searchMessages, type SearchHit } from "@/lib/db"
import { clearDraft } from "@/lib/drafts"
import { exportChatFile, uploadChatToServer } from "@/lib/sync"
import type { Chat, CodeRepo } from "@/lib/types"
import { cn, uid } from "@/lib/utils"
import { confirmDialog, promptDialog } from "@/stores/dialogs"
import { useSettings } from "@/stores/settings"
import { useTemp } from "@/stores/temp"
import { useForge } from "@/stores/forge"
import { RepoPicker } from "@/components/chat/RepoPicker"

/** Pinned chats sit above the ghosts, which sit above the day buckets. */
const GROUP_ORDER = [
  "Pinned",
  "Temporary",
  "Today",
  "Yesterday",
  "Previous 7 days",
  "Previous 30 days",
  "Older",
]

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
  hit,
  draft,
  query,
  onNavigate,
}: {
  chat: Chat
  active: boolean
  /** the message this chat matched on, when the row came from a search */
  hit?: SearchHit
  /** preview of an unsent message waiting in this chat's composer */
  draft?: string
  query: string
  onNavigate: (path: string) => void
}) {
  const syncUrl = useSettings((s) => s.syncUrl)
  const base = chat.kind === "image" ? `/images/${chat.id}` : `/chat/${chat.id}`
  /* opening a search result should land on the matching message, with the
     find bar primed to step through the rest of them */
  const path =
    hit && chat.kind === "chat"
      ? `${base}?m=${encodeURIComponent(hit.messageId)}&q=${encodeURIComponent(query)}`
      : base

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
    clearDraft(chat.id)
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
      data-ui="chat-row"
      data-active={active ? "true" : undefined}
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
          {chat.kind === "code" && (
            <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate text-[13.5px]">{chat.title}</span>
          {draft && !hit && (
            <PencilLineIcon
              className="ml-auto size-3 shrink-0 text-primary"
              aria-label="Unsent draft"
            />
          )}
        </span>
        {hit ? (
          <span className="mt-0.5 block truncate text-[11.5px] text-muted-foreground">
            {hit.snippet}
          </span>
        ) : (
          draft && (
            <span className="mt-0.5 block truncate text-[11.5px] text-muted-foreground">
              <span className="text-primary">Draft</span> · {draft}
            </span>
          )
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
              <DropdownMenuItem
                onClick={() =>
                  void db.chats.update(chat.id, {
                    pinned: chat.pinned ? undefined : Date.now(),
                  })
                }
              >
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
  const drafts = useDraftPreviews()
  const [query, setQuery] = useState("")
  const navigate = useNavigate()
  const location = useLocation()
  const isDark = useIsDark()
  const setSettings = useSettings((s) => s.set)
  const theme = useSettings((s) => s.theme)
  const forgeAvailable = useForge((s) => s.available)
  const hasToken = useSettings((s) => !!s.githubToken)
  const lastModel = useSettings((s) => s.lastModel)
  const [repoPickerOpen, setRepoPickerOpen] = useState(false)

  const go = (path: string) => {
    navigate(path)
    onNavigate?.()
  }

  /**
   * A code chat is an ordinary chat that carries a repository, so everything
   * downstream — history, search, export, the version switcher — works on it
   * unchanged. The model comes from the same last-used setting as any chat;
   * the sandbox turns it into ANTHROPIC_MODEL.
   */
  const startCodeChat = async (repo: CodeRepo) => {
    const id = uid()
    const now = Date.now()
    await db.chats.add({
      id,
      kind: "code",
      title: `${repo.owner}/${repo.name}`,
      createdAt: now,
      updatedAt: now,
      repo,
      provider: lastModel?.provider,
      model: lastModel?.model,
      titleIsManual: true, // named after the repo; don't let a model rename it
    })
    go(`/chat/${id}`)
  }

  // full-text search over message content (debounced)
  const [contentHits, setContentHits] = useState<Map<string, SearchHit> | null>(
    null,
  )
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
      const label = c.pinned
        ? "Pinned"
        : c.temporary
          ? "Temporary"
          : groupLabel(c.updatedAt)
      const g = out.find((x) => x.label === label)
      if (g) g.chats.push(c)
      else out.push({ label, chats: [c] })
    }
    // chats arrive newest-first, so groups appear in date order already —
    // except Pinned, which can be seeded by a chat of any age
    return out.sort(
      (a, b) => GROUP_ORDER.indexOf(a.label) - GROUP_ORDER.indexOf(b.label),
    )
  }, [chats, query, contentHits])

  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex items-center justify-between px-4 pb-1 pt-safe">
        <button
          onClick={() => go("/")}
          data-ui="sb-brand"
          className="flex items-center gap-2 pt-3 font-serif text-[22px] font-semibold tracking-tight"
        >
          <img
            src="/icons/icon.svg"
            alt=""
            className="size-6 rounded-md"
            data-ui="sb-logo"
          />
          <span aria-hidden data-ui="spyhole" />
          Kiln
        </button>
      </div>

      <div className="space-y-0.5 px-2 pt-2">
        {/* Coding needs a sandbox on the server and a GitHub token on the
            device. Without both there is nothing this button could do, so it
            isn't shown — same rule as the Local/Cloud pill. */}
        {forgeAvailable && hasToken && (
          <button
            onClick={() => setRepoPickerOpen(true)}
            className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-[13.5px] font-medium hover:bg-accent/60"
          >
            <GitBranchIcon className="size-4 text-muted-foreground" />
            New code chat
          </button>
        )}
        {(
          [
            { path: "/", label: "New chat", icon: SquarePenIcon, exact: true },
            { path: "/images", label: "Images", icon: ImageIcon, exact: false },
            { path: "/artefacts", label: "Artefacts", icon: AmphoraIcon, exact: false },
          ] as const
        ).map((item) => {
          const active = item.exact
            ? location.pathname === item.path
            : location.pathname.startsWith(item.path)
          return (
            <button
              key={item.path}
              onClick={() => go(item.path)}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-[13.5px] font-medium hover:bg-accent/60",
                active && "bg-accent text-primary",
              )}
            >
              <item.icon
                className={cn(
                  "size-4",
                  active ? "text-primary" : "text-muted-foreground",
                )}
              />
              {item.label}
            </button>
          )
        })}
      </div>

      <div className="px-2 py-2">
        <div
          className="flex items-center gap-2 rounded-xl bg-background/70 px-2.5 py-1.5 border border-border/60"
          data-ui="sb-search"
          data-pip-spot="sb-search"
        >
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
              <div
                className="px-2.5 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/80"
                data-ui="sb-group"
              >
                {g.label}
              </div>
              {g.chats.map((c) => (
                <ChatRow
                  key={c.id}
                  chat={c}
                  active={location.pathname.includes(c.id)}
                  hit={contentHits?.get(c.id)}
                  draft={drafts.get(c.id)}
                  query={query.trim()}
                  onNavigate={go}
                />
              ))}
            </div>
          ))
        )}
      </div>

      <div
        className="flex items-center gap-1 border-t border-sidebar-border px-2 pt-2 pb-safe-plus"
        data-pip-spot="sb-foot"
      >
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

      <RepoPicker
        open={repoPickerOpen}
        onOpenChange={setRepoPickerOpen}
        onSelect={(repo) => void startCodeChat(repo)}
      />
    </div>
  )
}
