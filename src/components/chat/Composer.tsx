import { useEffect, useRef, useState } from "react"
import {
  ArrowUpIcon,
  ChevronDownIcon,
  GaugeIcon,
  GhostIcon,
  ImageIcon,
  PaperclipIcon,
  PlusIcon,
  SparklesIcon,
  SquareIcon,
  XIcon,
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ModelPicker } from "./ModelPicker"
import { SkillsSheet } from "./SkillsSheet"
import {
  parseSlashCommand,
  SLASH_COMMANDS,
  type SlashCommand,
} from "@/lib/commands"
import type { Attachment, Effort, ModelRef } from "@/lib/types"
import {
  cn,
  downscaleImage,
  formatBytes,
  readFileAsDataUrl,
  readFileAsText,
  uid,
} from "@/lib/utils"
import { displayModelName, findModel } from "@/stores/models"
import { isTouchDevice } from "@/hooks/use-media"

const EFFORTS: Effort[] = ["auto", "low", "medium", "high"]

export interface ComposerProps {
  placeholder?: string
  disabled?: boolean
  generating: boolean
  modelRef: ModelRef | null
  effort: Effort
  onModelChange: (ref: ModelRef) => void
  onEffortChange: (e: Effort) => void
  onSend: (text: string, attachments: Attachment[]) => void
  onStop: () => void
  /** handles non-local slash commands (compact, clear, title, export, help) */
  onCommand?: (name: string, arg?: string) => void
  imageMode?: boolean
  /* new-chat extras */
  isNewChat?: boolean
  temporary?: boolean
  onToggleTemporary?: () => void
  skillIds?: string[]
  onSkillIdsChange?: (ids: string[]) => void
}

export function Composer(props: ComposerProps) {
  const [text, setText] = useState("")
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)
  const [skillsOpen, setSkillsOpen] = useState(false)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const modelInfo = findModel(props.modelRef)
  const supportsEffort = modelInfo?.reasoning ?? false
  const isCommand = !props.imageMode && !!parseSlashCommand(text.trim())
  const canSend =
    !props.disabled &&
    !props.generating &&
    (isCommand ||
      (!!props.modelRef &&
        (text.trim().length > 0 || attachments.length > 0)))

  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = "0px"
    ta.style.height = Math.min(ta.scrollHeight, 168) + "px"
  }, [text])

  const runCommand = (cmd: SlashCommand, arg?: string): void => {
    if (cmd.name === "model") {
      setPickerOpen(true)
    } else if (cmd.name === "effort") {
      const e = (arg ?? "").toLowerCase() as Effort
      if (EFFORTS.includes(e)) {
        props.onEffortChange(e)
        toast.success(`Reasoning effort: ${e}`)
      } else {
        toast.error("Usage: /effort auto|low|medium|high")
        return
      }
    } else if (props.onCommand) {
      props.onCommand(cmd.name, arg)
    } else {
      toast.error("Commands aren't available here")
      return
    }
    setText("")
  }

  const send = () => {
    const trimmed = text.trim()
    const parsed = !props.imageMode ? parseSlashCommand(trimmed) : null
    if (parsed) {
      const cmd = SLASH_COMMANDS.find((c) => c.name === parsed.name)
      if (!cmd) {
        toast.error(`Unknown command /${parsed.name} — try /help`)
        return
      }
      runCommand(cmd, parsed.arg)
      return
    }
    if (!canSend) return
    props.onSend(trimmed, attachments)
    setText("")
    setAttachments([])
    taRef.current?.focus()
  }

  const slashPrefix = !props.imageMode
    ? /^\/([a-z]*)$/i.exec(text)?.[1]?.toLowerCase()
    : undefined
  const slashMatches =
    slashPrefix !== undefined
      ? SLASH_COMMANDS.filter((c) => c.name.startsWith(slashPrefix))
      : []

  const addFiles = async (files: FileList | null) => {
    if (!files) return
    for (const file of Array.from(files)) {
      try {
        if (file.type.startsWith("image/")) {
          const raw = await readFileAsDataUrl(file)
          const dataUrl = await downscaleImage(raw)
          setAttachments((a) => [
            ...a,
            { id: uid(), name: file.name, mime: file.type, size: file.size, kind: "image", dataUrl },
          ])
        } else if (file.type === "application/pdf") {
          if (file.size > 15 * 1024 * 1024) throw new Error("PDF too large (15 MB max)")
          const dataUrl = await readFileAsDataUrl(file)
          setAttachments((a) => [
            ...a,
            { id: uid(), name: file.name, mime: file.type, size: file.size, kind: "pdf", dataUrl },
          ])
        } else {
          if (file.size > 400 * 1024) throw new Error(`${file.name}: text files up to 400 KB`)
          const content = await readFileAsText(file)
          setAttachments((a) => [
            ...a,
            { id: uid(), name: file.name, mime: file.type || "text/plain", size: file.size, kind: "text", text: content },
          ])
        }
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not read file")
      }
    }
    if (fileRef.current) fileRef.current.value = ""
  }

  return (
    <div className="px-3 pt-1 pb-safe-plus">
      <div className="rounded-[26px] border border-border bg-card shadow-[0_2px_16px_rgba(0,0,0,0.06)] dark:shadow-none">
        {slashMatches.length > 0 && (
          <div className="border-b border-border/70 px-2 py-1.5">
            {slashMatches.map((c) => (
              <button
                key={c.name}
                onClick={() => {
                  if (c.args) {
                    setText(`/${c.name} `)
                    taRef.current?.focus()
                  } else {
                    runCommand(c)
                  }
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-accent"
              >
                <span className="font-mono text-[13px] font-medium text-primary">
                  /{c.name}
                </span>
                {c.args && (
                  <span className="font-mono text-[11.5px] text-muted-foreground">
                    {c.args}
                  </span>
                )}
                <span className="ml-auto truncate text-[12px] text-muted-foreground">
                  {c.description}
                </span>
              </button>
            ))}
          </div>
        )}
        {attachments.length > 0 && (
          <div className="flex gap-2 overflow-x-auto px-3 pt-3 scrollbar-none">
            {attachments.map((a) => (
              <div key={a.id} className="relative shrink-0">
                {a.kind === "image" && a.dataUrl ? (
                  <img
                    src={a.dataUrl}
                    alt={a.name}
                    className="size-16 rounded-xl border border-border object-cover"
                  />
                ) : (
                  <div className="flex h-16 w-36 flex-col justify-center rounded-xl border border-border bg-muted/50 px-2.5">
                    <div className="truncate text-[12px] font-medium">{a.name}</div>
                    <div className="text-[10.5px] text-muted-foreground">
                      {a.kind.toUpperCase()} · {formatBytes(a.size)}
                    </div>
                  </div>
                )}
                <button
                  aria-label="Remove attachment"
                  onClick={() => setAttachments((list) => list.filter((x) => x.id !== a.id))}
                  className="absolute -right-1.5 -top-1.5 rounded-full border border-border bg-background p-0.5 shadow-sm"
                >
                  <XIcon className="size-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !isTouchDevice()) {
              e.preventDefault()
              send()
            }
          }}
          placeholder={props.placeholder ?? "Message Amber…"}
          rows={1}
          className="w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-[16px] leading-relaxed outline-none placeholder:text-muted-foreground/70 md:text-[15px]"
        />

        <div className="flex items-center gap-1 px-2 pb-2">
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            accept="image/*,.pdf,.txt,.md,.markdown,.csv,.json,.js,.mjs,.ts,.tsx,.jsx,.py,.rb,.go,.rs,.java,.kt,.c,.h,.cpp,.cs,.swift,.html,.css,.xml,.yaml,.yml,.toml,.sh,.sql,.log"
            onChange={(e) => void addFiles(e.target.files)}
          />
          {props.imageMode ? (
            <Button
              variant="ghost"
              size="icon-sm"
              className="rounded-full text-muted-foreground"
              onClick={() => fileRef.current?.click()}
              aria-label="Attach"
            >
              <PaperclipIcon />
            </Button>
          ) : (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="rounded-full text-muted-foreground"
                  aria-label="More options"
                >
                  <PlusIcon className="size-5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="top">
                <DropdownMenuItem onClick={() => fileRef.current?.click()}>
                  <PaperclipIcon /> Photos & files
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setSkillsOpen(true)}>
                  <SparklesIcon /> Skills
                  {props.skillIds?.length ? (
                    <span className="ml-auto text-xs text-muted-foreground">
                      {props.skillIds.length} on
                    </span>
                  ) : null}
                </DropdownMenuItem>
                {props.isNewChat && props.onToggleTemporary && (
                  <DropdownMenuItem onClick={props.onToggleTemporary}>
                    <GhostIcon />
                    {props.temporary ? "Disable temporary chat" : "Temporary chat"}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          <button
            onClick={() => setPickerOpen(true)}
            className="flex min-w-0 items-center gap-1 rounded-full px-2 py-1.5 text-[12.5px] font-medium text-muted-foreground hover:bg-accent transition-colors"
          >
            {props.imageMode && <ImageIcon className="size-3.5 shrink-0" />}
            <span className="max-w-36 truncate">
              {displayModelName(props.modelRef)}
            </span>
            <ChevronDownIcon className="size-3.5 shrink-0" />
          </button>

          {supportsEffort && !props.imageMode && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  className={cn(
                    "flex items-center gap-1 rounded-full px-2 py-1.5 text-[12.5px] font-medium transition-colors hover:bg-accent",
                    props.effort === "auto"
                      ? "text-muted-foreground"
                      : "text-primary",
                  )}
                >
                  <GaugeIcon className="size-3.5" />
                  <span className="capitalize">
                    {props.effort === "auto" ? "Effort" : props.effort}
                  </span>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="top">
                {EFFORTS.map((e) => (
                  <DropdownMenuItem
                    key={e}
                    onClick={() => props.onEffortChange(e)}
                    className={cn("capitalize", e === props.effort && "bg-accent")}
                  >
                    {e === "auto" ? "Auto (model default)" : e}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {props.isNewChat && props.temporary && (
            <span className="flex items-center gap-1 rounded-full bg-primary/10 px-2 py-1 text-[11.5px] font-medium text-primary">
              <GhostIcon className="size-3" /> Temp
            </span>
          )}

          <div className="flex-1" />

          {props.generating ? (
            <Button
              size="icon-sm"
              className="rounded-full"
              onClick={props.onStop}
              aria-label="Stop"
            >
              <SquareIcon className="size-3.5 fill-current" />
            </Button>
          ) : (
            <Button
              size="icon-sm"
              className="rounded-full"
              disabled={!canSend}
              onClick={send}
              aria-label="Send"
            >
              <ArrowUpIcon className="size-4.5" />
            </Button>
          )}
        </div>
      </div>

      <ModelPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        value={props.modelRef}
        onSelect={(ref) => props.onModelChange(ref)}
        imageOnly={props.imageMode}
      />
      {props.onSkillIdsChange && (
        <SkillsSheet
          open={skillsOpen}
          onOpenChange={setSkillsOpen}
          selected={props.skillIds ?? []}
          onChange={props.onSkillIdsChange}
        />
      )}
    </div>
  )
}
