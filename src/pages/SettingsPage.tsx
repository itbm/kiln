import { useEffect, useRef, useState, type ReactNode } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useNavigate } from "react-router-dom"
import {
  ArrowLeftIcon,
  BellIcon,
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
  DatabaseIcon,
  EyeIcon,
  EyeOffIcon,
  KeyIcon,
  Loader2Icon,
  MonitorSmartphoneIcon,
  MoonIcon,
  PaletteIcon,
  PencilIcon,
  PlusIcon,
  ServerIcon,
  SparklesIcon,
  SquareTerminalIcon,
  SunIcon,
  Trash2Icon,
  UserIcon,
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ModelPicker } from "@/components/chat/ModelPicker"
import { LicensesDialog } from "@/components/LicensesDialog"
import { db } from "@/lib/db"
import { generateJournalKey, runnerHealth } from "@/lib/agent/client"
import { DEFAULT_SYSTEM_PROMPT } from "@/lib/prompts"
import { checkOpenRouterKey } from "@/lib/providers/openrouter"
import { checkOllamaKey } from "@/lib/providers/ollama"
import { ensureNotificationPermission } from "@/lib/notify"
import { exportAllData, importData } from "@/lib/sync"
import type { Skill } from "@/lib/types"
import { cleanKey, formatBytes } from "@/lib/utils"
import { confirmDialog } from "@/stores/dialogs"
import { displayModelName } from "@/stores/models"
import { useSettings, type ThemePref } from "@/stores/settings"

function Section({
  icon,
  title,
  description,
  children,
  id,
}: {
  icon: ReactNode
  title: string
  description?: string
  children: ReactNode
  id?: string
}) {
  return (
    <section id={id} className="rounded-2xl border border-border bg-card p-4">
      <div className="mb-3 flex items-start gap-2.5">
        <div className="mt-0.5 text-primary">{icon}</div>
        <div>
          <h2 className="text-[15px] font-semibold leading-tight">{title}</h2>
          {description && (
            <p className="mt-0.5 text-[12.5px] text-muted-foreground">{description}</p>
          )}
        </div>
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  )
}

function KeyInput({
  label,
  value,
  onChange,
  placeholder,
  onVerify,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder: string
  onVerify?: () => Promise<string>
}) {
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  return (
    <div className="space-y-1.5">
      <Label className="text-[13px]">{label}</Label>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Input
            type={show ? "text" : "password"}
            autoComplete="off"
            value={value}
            onChange={(e) => onChange(cleanKey(e.target.value))}
            placeholder={placeholder}
            className="pr-9 font-mono text-[16px] md:text-[13px]"
          />
          <button
            type="button"
            aria-label={show ? "Hide key" : "Show key"}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
            onClick={() => setShow(!show)}
          >
            {show ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
          </button>
        </div>
        {onVerify && (
          <Button
            variant="outline"
            disabled={!value || busy}
            onClick={() => {
              setBusy(true)
              onVerify()
                .then((msg) => toast.success(`Connected — ${msg}`))
                .catch((e) => toast.error(`Check failed: ${e.message}`))
                .finally(() => setBusy(false))
            }}
          >
            {busy ? <Loader2Icon className="animate-spin" /> : <CheckIcon />}
            Test
          </Button>
        )}
      </div>
    </div>
  )
}

function SkillDialog({
  skill,
  open,
  onOpenChange,
}: {
  skill: Skill | null
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const { addSkill, updateSkill } = useSettings()
  const [name, setName] = useState(skill?.name ?? "")
  const [description, setDescription] = useState(skill?.description ?? "")
  const [instructions, setInstructions] = useState(skill?.instructions ?? "")
  const [enabled, setEnabled] = useState(skill?.enabled ?? true)

  const save = () => {
    if (!name.trim() || !instructions.trim()) {
      toast.error("Name and instructions are required")
      return
    }
    const data = {
      name: name.trim(),
      description: description.trim(),
      instructions: instructions.trim(),
      enabled,
    }
    if (skill) updateSkill(skill.id, data)
    else addSkill(data)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{skill ? "Edit skill" : "New skill"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Recipe formatter" />
          </div>
          <div className="space-y-1.5">
            <Label>Short description</Label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Shown in the skills list"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Instructions</Label>
            <Textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="Instructions the assistant follows when this skill is active…"
              className="min-h-36"
            />
          </div>
          <label className="flex items-center justify-between rounded-xl border border-border p-3">
            <div>
              <div className="text-[13.5px] font-medium">On by default</div>
              <div className="text-[12px] text-muted-foreground">Active in every new chat</div>
            </div>
            <Switch checked={enabled} onCheckedChange={setEnabled} />
          </label>
        </div>
        <DialogFooter>
          <Button onClick={save}>Save skill</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Sum the actual bytes of chat data (text + base64 media) in IndexedDB. */
async function measureAppData() {
  let bytes = 0
  let messages = 0
  const chats = await db.chats.count()
  await db.messages.each((m) => {
    messages++
    bytes += (m.content?.length ?? 0) + (m.reasoning?.length ?? 0)
    for (const a of m.attachments ?? [])
      bytes += (a.dataUrl?.length ?? 0) + (a.text?.length ?? 0)
    for (const im of m.images ?? []) bytes += im.dataUrl.length
    for (const s of m.steps ?? []) bytes += s.result?.length ?? 0
    for (const v of m.versions ?? []) {
      bytes += (v.content?.length ?? 0) + (v.reasoning?.length ?? 0)
      for (const im of v.images ?? []) bytes += im.dataUrl.length
    }
  })
  return { bytes, chats, messages }
}

function StorageInfo() {
  // live: re-measures automatically whenever chats/messages change
  const appData = useLiveQuery(measureAppData, [])
  const [browser, setBrowser] = useState<{
    used: number
    quota: number
    persisted: boolean
  } | null>(null)

  useEffect(() => {
    const read = async () => {
      try {
        const est = await navigator.storage?.estimate?.()
        const persisted = (await navigator.storage?.persisted?.()) ?? false
        setBrowser({ used: est?.usage ?? 0, quota: est?.quota ?? 0, persisted })
      } catch {
        /* unsupported */
      }
    }
    void read()
    const onVisible = () => {
      if (document.visibilityState === "visible") void read()
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => document.removeEventListener("visibilitychange", onVisible)
    // re-read the browser estimate when app data changes (e.g. delete all)
  }, [appData?.bytes])

  return (
    <div className="space-y-0.5 text-[12px] text-muted-foreground">
      {appData && (
        <p>
          Chat data: ~{formatBytes(appData.bytes)} ({appData.chats} chat
          {appData.chats === 1 ? "" : "s"}, {appData.messages} message
          {appData.messages === 1 ? "" : "s"})
        </p>
      )}
      {browser && (
        <p>
          Browser storage: {formatBytes(browser.used)}
          {browser.quota ? ` of ~${formatBytes(browser.quota)}` : ""} ·{" "}
          {browser.persisted ? (
            <span className="text-primary">protected from eviction ✓</span>
          ) : (
            "eviction protection not granted (install the app to improve this)"
          )}
        </p>
      )}
      <p className="text-muted-foreground/70">
        The browser figure covers the whole app — including the ~1 MB offline
        cache — and can lag after deletions until the browser compacts its
        database. “Chat data” is measured directly and updates instantly.
      </p>
    </div>
  )
}

function ToggleRow({
  title,
  description,
  checked,
  onCheckedChange,
}: {
  title: string
  description?: string
  checked: boolean
  onCheckedChange: (v: boolean) => void
}) {
  return (
    <label className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="text-[13.5px] font-medium">{title}</div>
        {description && (
          <div className="text-[12px] text-muted-foreground">{description}</div>
        )}
      </div>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </label>
  )
}

// No sync backend exists yet; the section stays hidden so it can't confuse.
const SHOW_SERVER_SECTION = false

/** Settings → Agent runner (§5.6): connection + per-session credentials. */
function AgentRunnerSection() {
  const s = useSettings()
  const [health, setHealth] = useState<string | null>(null)
  const checkHealth = async (): Promise<string> => {
    const h = await runnerHealth()
    const bits = [
      h.driver.ok ? `driver ${h.driver.driver} ok` : `driver: ${h.driver.detail ?? "down"}`,
      h.driver.apiVersionOk === false
        ? `sbx api ${h.driver.apiVersion} (drift!)`
        : h.driver.apiVersion
          ? `sbx api ${h.driver.apiVersion}`
          : null,
      h.driver.kvm === false ? "KVM: unavailable" : null,
      h.driver.templatePresent === false ? "template image missing" : null,
      `${h.sessions.live}/${h.sessions.max} sessions`,
    ].filter(Boolean)
    const text = bits.join(" · ")
    setHealth(text)
    if (!h.ok) throw new Error(text)
    return text
  }

  return (
    <Section
      id="agent"
      icon={<SquareTerminalIcon className="size-4.5" />}
      title="Agent runner"
      description="Optional self-hosted runner for the Code tab. Keys never leave this device except to your runner, per task — nothing readable persists on the server."
    >
      <div className="space-y-1.5">
        <Label className="text-[13px]">Runner URL</Label>
        <Input
          value={s.agentRunnerUrl}
          onChange={(e) => s.set({ agentRunnerUrl: e.target.value.trim() })}
          placeholder="/agent (same origin, default)"
          className="font-mono text-[16px] md:text-[13px]"
        />
      </div>
      <KeyInput
        label="Runner token"
        value={s.agentRunnerToken}
        onChange={(v) => s.set({ agentRunnerToken: v })}
        placeholder="KILN_AGENT_TOKEN from your server"
        onVerify={checkHealth}
      />
      {health && <p className="text-[12px] text-muted-foreground">{health}</p>}
      <KeyInput
        label="GitHub token (fine-grained PAT)"
        value={s.agentGithubToken}
        onChange={(v) => s.set({ agentGithubToken: v })}
        placeholder="github_pat_…"
      />
      <p className="text-[12px] leading-snug text-muted-foreground">
        Grant the PAT access to selected repositories only, with{" "}
        <span className="font-mono">Contents</span> and{" "}
        <span className="font-mono">Pull requests</span> read/write. It is sent per task, held in
        runner memory and scrubbed at teardown. Protect <span className="font-mono">main</span>{" "}
        with branch protection — agent changes only land via pull requests on{" "}
        <span className="font-mono">kiln/*</span> branches.
      </p>
      <div className="space-y-1.5">
        <Label className="text-[13px]">Journal key</Label>
        <div className="flex gap-2">
          <Input
            readOnly
            type="password"
            value={s.agentJournalKey}
            placeholder="not generated yet"
            className="flex-1 font-mono text-[16px] md:text-[13px]"
          />
          {s.agentJournalKey ? (
            <Button
              variant="outline"
              size="icon"
              aria-label="Copy journal key"
              onClick={() => {
                void navigator.clipboard.writeText(s.agentJournalKey)
                toast.success("Journal key copied")
              }}
            >
              <CopyIcon />
            </Button>
          ) : (
            <Button variant="outline" onClick={() => s.set({ agentJournalKey: generateJournalKey() })}>
              Generate
            </Button>
          )}
        </div>
        <p className="text-[12px] leading-snug text-muted-foreground">
          Encrypts the runner&apos;s tiny session journal so the server itself can&apos;t read it.
          Only this device holds the key; losing it only costs post-restart session recovery.
        </p>
      </div>
    </Section>
  )
}

function SavedIndicator() {
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle")
  useEffect(() => {
    let t1: ReturnType<typeof setTimeout>
    let t2: ReturnType<typeof setTimeout>
    const unsub = useSettings.subscribe(() => {
      setState("saving")
      clearTimeout(t1)
      clearTimeout(t2)
      t1 = setTimeout(() => {
        setState("saved")
        t2 = setTimeout(() => setState("idle"), 2000)
      }, 600)
    })
    return () => {
      unsub()
      clearTimeout(t1)
      clearTimeout(t2)
    }
  }, [])
  if (state === "idle") return null
  return (
    <span className="ml-auto mr-2 flex items-center gap-1.5 text-[12px] text-muted-foreground">
      {state === "saving" ? (
        <Loader2Icon className="size-3.5 animate-spin" />
      ) : (
        <CheckIcon className="size-3.5 text-primary" />
      )}
      {state === "saving" ? "Saving…" : "Saved"}
    </span>
  )
}

export default function SettingsPage() {
  const navigate = useNavigate()
  const s = useSettings()
  const [titlePickerOpen, setTitlePickerOpen] = useState(false)
  const [licensesOpen, setLicensesOpen] = useState(false)
  const [skillDialog, setSkillDialog] = useState<{ open: boolean; skill: Skill | null }>({
    open: false,
    skill: null,
  })
  const importRef = useRef<HTMLInputElement>(null)
  const promptDirty = s.systemPrompt !== null

  // deep links like /settings#agent scroll to their section
  useEffect(() => {
    const id = window.location.hash.slice(1)
    if (id) document.getElementById(id)?.scrollIntoView({ block: "start" })
  }, [])

  return (
    <div className="mx-auto flex h-[var(--app-height)] max-w-2xl flex-col">
      <header className="pt-safe">
        <div className="flex h-12 items-center gap-1 px-2">
          <Button variant="ghost" size="icon-sm" aria-label="Back" onClick={() => navigate(-1)}>
            <ArrowLeftIcon className="size-5" />
          </Button>
          <h1 className="text-[16px] font-semibold">Settings</h1>
          <SavedIndicator />
        </div>
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 pb-16">
        <p className="px-1 text-[12px] text-muted-foreground">
          Changes save to this device automatically.
        </p>
        <Section
          icon={<KeyIcon className="size-4.5" />}
          title="Providers"
          description="Keys are stored only on this device (localStorage) and sent directly to each provider."
        >
          <KeyInput
            label="OpenRouter API key"
            value={s.openrouterKey}
            onChange={(v) => s.set({ openrouterKey: v })}
            placeholder="sk-or-…"
            onVerify={() => checkOpenRouterKey(s.openrouterKey)}
          />
          <KeyInput
            label="Ollama API key"
            value={s.ollamaKey}
            onChange={(v) => s.set({ ollamaKey: v })}
            placeholder="ollama cloud key"
            onVerify={() => checkOllamaKey(s.ollamaKey, s.ollamaBaseUrl)}
          />
          <div className="space-y-1.5">
            <Label className="text-[13px]">Ollama endpoint</Label>
            <Input
              value={s.ollamaBaseUrl}
              onChange={(e) => s.set({ ollamaBaseUrl: e.target.value.trim() })}
              placeholder="/api/ollama"
              className="font-mono text-[16px] md:text-[13px]"
            />
            <p className="text-[12px] leading-snug text-muted-foreground">
              The default{" "}
              <button
                className="font-mono text-primary underline underline-offset-2"
                onClick={() => s.set({ ollamaBaseUrl: "/api/ollama" })}
              >
                /api/ollama
              </button>{" "}
              relays to ollama.com through the server hosting this app (ollama.com
              itself blocks direct browser calls). A local/LAN Ollama also works, e.g.{" "}
              <span className="font-mono">http://192.168.1.10:11434</span> with{" "}
              <span className="font-mono">OLLAMA_ORIGINS</span> set.
            </p>
          </div>
          <KeyInput
            label="Tavily API key (web search)"
            value={s.tavilyKey}
            onChange={(v) => s.set({ tavilyKey: v })}
            placeholder="tvly-…"
          />
        </Section>

        <Section
          icon={<SparklesIcon className="size-4.5" />}
          title="Chat behaviour"
        >
          <ToggleRow
            title="Generate chat titles"
            description="A second model call names each chat after the first reply"
            checked={s.generateTitles}
            onCheckedChange={(v) => s.set({ generateTitles: v })}
          />
          <ToggleRow
            title="Auto-compact long chats"
            description="Summarises older messages when a chat nears the model's context limit"
            checked={s.autoCompact}
            onCheckedChange={(v) => s.set({ autoCompact: v })}
          />
          {(s.generateTitles || s.autoCompact) && (
            <button
              onClick={() => setTitlePickerOpen(true)}
              className="flex w-full items-center justify-between rounded-xl border border-border p-3 text-left"
            >
              <div>
                <div className="text-[13.5px] font-medium">Utility model</div>
                <div className="text-[12px] text-muted-foreground">
                  {s.titleModel
                    ? displayModelName(s.titleModel)
                    : "Same model as the chat"}{" "}
                  · used for titles & compaction
                </div>
              </div>
              <div className="flex items-center gap-2">
                {s.titleModel && (
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={(e) => {
                      e.stopPropagation()
                      s.set({ titleModel: null })
                    }}
                  >
                    Reset
                  </Button>
                )}
                <ChevronRightIcon className="size-4 text-muted-foreground" />
              </div>
            </button>
          )}
          <ToggleRow
            title="Web search tool"
            description="Lets the model search via Tavily (needs API key above)"
            checked={s.webSearchEnabled}
            onCheckedChange={(v) => s.set({ webSearchEnabled: v })}
          />
          <ToggleRow
            title="Web fetch tool"
            description="Lets the model read pages from links"
            checked={s.webFetchEnabled}
            onCheckedChange={(v) => s.set({ webFetchEnabled: v })}
          />
        </Section>

        <Section
          icon={<PencilIcon className="size-4.5" />}
          title="System prompt"
          description={promptDirty ? "Customised" : "Using the built-in default"}
        >
          <Textarea
            value={s.systemPrompt ?? DEFAULT_SYSTEM_PROMPT}
            onChange={(e) => s.set({ systemPrompt: e.target.value })}
            className="min-h-44 font-mono text-[16px] leading-relaxed md:text-[12px]"
          />
          <div className="flex justify-end">
            <Button
              variant="outline"
              size="sm"
              disabled={!promptDirty}
              onClick={() => s.set({ systemPrompt: null })}
            >
              Reset to default
            </Button>
          </div>
        </Section>

        <Section
          icon={<UserIcon className="size-4.5" />}
          title="Personalisation"
          description="Appended to the system prompt so every model knows you."
        >
          <ToggleRow
            title="Enable personalisation"
            checked={s.personalization.enabled}
            onCheckedChange={(v) =>
              s.set({ personalization: { ...s.personalization, enabled: v } })
            }
          />
          {s.personalization.enabled && (
            <>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1.5">
                  <Label className="text-[13px]">Your name</Label>
                  <Input
                    value={s.personalization.name}
                    onChange={(e) =>
                      s.set({ personalization: { ...s.personalization, name: e.target.value } })
                    }
                    placeholder="Alex"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-[13px]">What you do</Label>
                  <Input
                    value={s.personalization.role}
                    onChange={(e) =>
                      s.set({ personalization: { ...s.personalization, role: e.target.value } })
                    }
                    placeholder="iOS developer"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-[13px]">Preferences</Label>
                <Textarea
                  value={s.personalization.notes}
                  onChange={(e) =>
                    s.set({ personalization: { ...s.personalization, notes: e.target.value } })
                  }
                  placeholder="e.g. Keep answers brief. I use metric units. UK English."
                  className="min-h-20"
                />
              </div>
            </>
          )}
        </Section>

        <Section
          id="skills"
          icon={<SparklesIcon className="size-4.5" />}
          title="Skills"
          description="Reusable instruction packs you can switch on per chat."
        >
          {s.skills.map((sk) => (
            <div key={sk.id} className="flex items-center gap-2 rounded-xl border border-border p-3">
              <div className="min-w-0 flex-1">
                <div className="text-[13.5px] font-medium">{sk.name}</div>
                <div className="truncate text-[12px] text-muted-foreground">
                  {sk.description || sk.instructions.slice(0, 60)}
                </div>
              </div>
              <Switch
                checked={sk.enabled}
                onCheckedChange={(v) => s.updateSkill(sk.id, { enabled: v })}
              />
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Edit skill"
                onClick={() => setSkillDialog({ open: true, skill: sk })}
              >
                <PencilIcon />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Delete skill"
                onClick={() => {
                  void confirmDialog({
                    title: `Delete skill “${sk.name}”?`,
                    confirmLabel: "Delete",
                    destructive: true,
                  }).then((ok) => ok && s.removeSkill(sk.id))
                }}
              >
                <Trash2Icon />
              </Button>
            </div>
          ))}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setSkillDialog({ open: true, skill: null })}
          >
            <PlusIcon /> Add skill
          </Button>
        </Section>

        <Section icon={<PaletteIcon className="size-4.5" />} title="Appearance">
          <div className="grid grid-cols-3 gap-2">
            {(
              [
                { v: "system", label: "System", icon: <MonitorSmartphoneIcon className="size-4" /> },
                { v: "light", label: "Light", icon: <SunIcon className="size-4" /> },
                { v: "dark", label: "Dark", icon: <MoonIcon className="size-4" /> },
              ] as { v: ThemePref; label: string; icon: ReactNode }[]
            ).map((opt) => (
              <button
                key={opt.v}
                onClick={() => s.set({ theme: opt.v })}
                className={`flex flex-col items-center gap-1.5 rounded-xl border p-3 text-[12.5px] font-medium transition-colors ${
                  s.theme === opt.v
                    ? "border-primary bg-primary/8 text-primary"
                    : "border-border hover:bg-accent"
                }`}
              >
                {opt.icon}
                {opt.label}
              </button>
            ))}
          </div>
        </Section>

        <Section icon={<BellIcon className="size-4.5" />} title="While generating">
          <ToggleRow
            title="Notify when a reply finishes"
            description="Shows a notification if the app is in the background"
            checked={s.notifications}
            onCheckedChange={(v) => {
              if (!v) return s.set({ notifications: false })
              void ensureNotificationPermission().then((ok) => {
                s.set({ notifications: ok })
                if (!ok) toast.error("Notifications are blocked for this app in your browser/OS")
              })
            }}
          />
          <ToggleRow
            title="Keep screen awake"
            description="Prevents your phone locking mid-answer, so long replies aren't cut off"
            checked={s.keepAwake}
            onCheckedChange={(v) => s.set({ keepAwake: v })}
          />
          <p className="text-[12px] leading-snug text-muted-foreground">
            Streams save to your device continuously, so nothing is lost up to the moment
            iOS pauses a backgrounded tab — reopen the chat and tap “Continue generating”.
          </p>
        </Section>

        <AgentRunnerSection />

        {/* Hidden until a sync backend actually exists — flip SHOW_SERVER_SECTION
            to bring it back. The plumbing (lib/sync.ts, "Send to server" menu
            items gated on syncUrl) is all still wired up. */}
        {SHOW_SERVER_SECTION && (
          <Section
            icon={<ServerIcon className="size-4.5" />}
            title="Server (optional)"
            description="Kiln runs fully on-device. Add a server to push chats to it."
          >
            <div className="space-y-1.5">
              <Label className="text-[13px]">Server URL</Label>
              <Input
                value={s.syncUrl}
                onChange={(e) => s.set({ syncUrl: e.target.value.trim() })}
                placeholder="https://kiln.example.com/api"
                className="font-mono text-[16px] md:text-[13px]"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[13px]">Auth token</Label>
              <Input
                value={s.syncToken}
                onChange={(e) => s.set({ syncToken: e.target.value.trim() })}
                placeholder="optional bearer token"
                className="font-mono text-[16px] md:text-[13px]"
              />
            </div>
            <p className="text-[12px] text-muted-foreground">
              “Send to server” in a chat’s menu POSTs the chat JSON to{" "}
              <code className="font-mono">{"{url}"}/chats</code>.
            </p>
          </Section>
        )}

        <Section icon={<DatabaseIcon className="size-4.5" />} title="Data">
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => void exportAllData()}>
              Export everything
            </Button>
            <Button variant="outline" size="sm" onClick={() => importRef.current?.click()}>
              Import backup
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="text-destructive"
              onClick={() => {
                void confirmDialog({
                  title: "Delete ALL chats?",
                  description:
                    "Every chat and message on this device will be removed. Settings are kept. This cannot be undone.",
                  confirmLabel: "Delete everything",
                  destructive: true,
                }).then((ok) => {
                  if (!ok) return
                  void db
                    .transaction("rw", db.chats, db.messages, async () => {
                      await db.messages.clear()
                      await db.chats.clear()
                    })
                    .then(() => toast.success("All chats deleted"))
                })
              }}
            >
              Delete all chats
            </Button>
          </div>
          <input
            ref={importRef}
            type="file"
            accept="application/json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f)
                importData(f)
                  .then((n) => toast.success(`Imported ${n} chat${n === 1 ? "" : "s"}`))
                  .catch((err) => toast.error(err.message))
              e.target.value = ""
            }}
          />
          <StorageInfo />
          <p className="text-[12px] text-muted-foreground">
            Everything lives in your browser’s storage on this device. Export regularly if
            the chats matter to you.
          </p>
        </Section>

        <p className="pb-safe pt-2 text-center text-[11.5px] text-muted-foreground">
          Kiln · v{__APP_VERSION__} ·{" "}
          <button
            className="underline underline-offset-2 hover:text-foreground"
            onClick={() => setLicensesOpen(true)}
          >
            licences
          </button>
        </p>
      </div>

      <LicensesDialog open={licensesOpen} onOpenChange={setLicensesOpen} />
      <ModelPicker
        open={titlePickerOpen}
        onOpenChange={setTitlePickerOpen}
        value={s.titleModel}
        onSelect={(ref) => s.set({ titleModel: ref })}
      />
      {skillDialog.open && (
        <SkillDialog
          key={skillDialog.skill?.id ?? "new"}
          skill={skillDialog.skill}
          open={skillDialog.open}
          onOpenChange={(o) => setSkillDialog((d) => ({ ...d, open: o }))}
        />
      )}
    </div>
  )
}
