import { useState } from "react"
import { useNavigate } from "react-router-dom"
import {
  ChevronDownIcon,
  CpuIcon,
  GlobeIcon,
  Loader2Icon,
  RocketIcon,
  ShieldIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { ModelPicker } from "@/components/chat/ModelPicker"
import { parseExtraHosts, startAgentTask } from "@/lib/agent/runtime"
import type { AgentNetworkPolicy, AgentPermissionMode } from "@/lib/agent/types"
import type { ModelRef } from "@/lib/types"
import { cn } from "@/lib/utils"
import { displayModelName } from "@/stores/models"
import { useSettings } from "@/stores/settings"

const NETWORK_OPTIONS: { v: AgentNetworkPolicy; label: string; hint: string }[] = [
  { v: "deny-all", label: "Locked down", hint: "GitHub + model only" },
  { v: "balanced", label: "Balanced", hint: "common dev registries" },
  { v: "allow-all", label: "Open", hint: "everything" },
]

const PERMISSION_OPTIONS: { v: AgentPermissionMode; label: string; hint: string }[] = [
  { v: "bypassPermissions", label: "Autonomous", hint: "runs unattended (default)" },
  { v: "acceptEdits", label: "Accept edits", hint: "SDK auto-accepts edits only" },
  { v: "plan", label: "Plan only", hint: "propose-only dry run" },
]

/** The new-task composer (§5.6): repo, base branch, task, model, network, permissions. */
export function NewTaskSheet({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const s = useSettings()
  const navigate = useNavigate()
  const [repo, setRepo] = useState(s.lastAgentRepo)
  const [baseBranch, setBaseBranch] = useState(s.lastAgentBaseBranch || "main")
  const [task, setTask] = useState("")
  const [modelRef, setModelRef] = useState<ModelRef | null>(s.lastAgentModel)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [network, setNetwork] = useState<AgentNetworkPolicy>(s.agentNetworkPolicy)
  const [extraHosts, setExtraHosts] = useState(s.agentExtraHosts)
  const [allowPkg, setAllowPkg] = useState(s.agentAllowPackageManagers)
  const [permission, setPermission] = useState<AgentPermissionMode>(s.agentPermissionMode)
  const [advanced, setAdvanced] = useState(false)
  const [busy, setBusy] = useState(false)

  const repoValid = /^[\w.-]+\/[\w.-]+$/.test(repo.trim())
  const ready = repoValid && task.trim().length > 0 && !!modelRef && !busy

  const start = async () => {
    if (!modelRef) return
    setBusy(true)
    try {
      const [owner, name] = repo.trim().split("/")
      s.set({
        agentNetworkPolicy: network,
        agentAllowPackageManagers: allowPkg,
        agentPermissionMode: permission,
        agentExtraHosts: extraHosts,
      })
      const chatId = await startAgentTask({
        task: task.trim(),
        repoOwner: owner!,
        repoName: name!,
        baseBranch: baseBranch.trim() || "main",
        modelRef,
        permissionMode: permission,
        networkPolicy: network,
        allowPackageManagers: allowPkg,
        extraHosts: parseExtraHosts(extraHosts),
      })
      onOpenChange(false)
      setTask("")
      navigate(`/code/${chatId}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not start the task")
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Drawer open={open} onOpenChange={onOpenChange} repositionInputs={false}>
        <DrawerContent className="max-h-[calc(var(--app-height)*0.94)] !bottom-[var(--kb-inset)]">
          <div className="min-h-0 overflow-y-auto px-4 pb-safe-plus">
            <DrawerTitle className="pt-3 text-[15px] font-semibold">New coding task</DrawerTitle>
            <div className="mt-3 space-y-3">
              <div className="grid grid-cols-[1fr_auto] gap-2">
                <div className="space-y-1.5">
                  <Label className="text-[13px]">Repository</Label>
                  <Input
                    value={repo}
                    onChange={(e) => setRepo(e.target.value.trim())}
                    placeholder="owner/name"
                    autoCapitalize="off"
                    autoCorrect="off"
                    className="font-mono text-[16px] md:text-[13px]"
                  />
                </div>
                <div className="w-28 space-y-1.5">
                  <Label className="text-[13px]">Base</Label>
                  <Input
                    value={baseBranch}
                    onChange={(e) => setBaseBranch(e.target.value.trim())}
                    placeholder="main"
                    autoCapitalize="off"
                    className="font-mono text-[16px] md:text-[13px]"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label className="text-[13px]">Task</Label>
                <Textarea
                  value={task}
                  onChange={(e) => setTask(e.target.value)}
                  placeholder="e.g. Fix the flaky retry logic in src/lib/relay.ts and add a unit test"
                  className="min-h-28 text-[16px] md:text-[14px]"
                />
              </div>

              <button
                onClick={() => setPickerOpen(true)}
                className="flex w-full items-center justify-between rounded-xl border border-border p-3 text-left"
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <CpuIcon className="size-4 shrink-0 text-primary" />
                  <div className="min-w-0">
                    <div className="text-[13.5px] font-medium">
                      {modelRef ? displayModelName(modelRef) : "Choose model"}
                    </div>
                    <div className="text-[11.5px] text-muted-foreground">
                      Needs strong tool calling · 64k+ context recommended
                    </div>
                  </div>
                </div>
                <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
              </button>

              <div className="space-y-1.5">
                <Label className="flex items-center gap-1.5 text-[13px]">
                  <GlobeIcon className="size-3.5 text-muted-foreground" /> Sandbox network
                </Label>
                <div className="grid grid-cols-3 gap-2">
                  {NETWORK_OPTIONS.map((opt) => (
                    <button
                      key={opt.v}
                      onClick={() => setNetwork(opt.v)}
                      className={cn(
                        "rounded-xl border p-2 text-center transition-colors",
                        network === opt.v
                          ? "border-primary bg-primary/8 text-primary"
                          : "border-border hover:bg-accent",
                      )}
                    >
                      <div className="text-[12.5px] font-medium">{opt.label}</div>
                      <div className="text-[10.5px] text-muted-foreground">{opt.hint}</div>
                    </button>
                  ))}
                </div>
                {network === "allow-all" && (
                  <p className="flex items-start gap-1.5 text-[11.5px] leading-snug text-amber-600 dark:text-amber-400">
                    <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
                    Open egress widens the exfiltration surface if the agent is prompt-injected
                    by repository content. GitHub and your model stay reachable on every setting.
                  </p>
                )}
              </div>

              <button
                onClick={() => setAdvanced(!advanced)}
                className="flex items-center gap-1 text-[12.5px] text-muted-foreground"
              >
                <ChevronDownIcon className={cn("size-3.5 transition-transform", advanced && "rotate-180")} />
                Advanced
              </button>

              {advanced && (
                <div className="space-y-3 rounded-xl border border-border p-3">
                  <label className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-[13px] font-medium">Package managers</div>
                      <div className="text-[11.5px] text-muted-foreground">
                        Allow npm/pip registry access
                      </div>
                    </div>
                    <Switch checked={allowPkg} onCheckedChange={setAllowPkg} />
                  </label>
                  <div className="space-y-1.5">
                    <Label className="text-[13px]">Extra allowed hosts</Label>
                    <Input
                      value={extraHosts}
                      onChange={(e) => setExtraHosts(e.target.value)}
                      placeholder="registry.npmjs.org:443, **.pypi.org"
                      autoCapitalize="off"
                      className="font-mono text-[16px] md:text-[12px]"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="flex items-center gap-1.5 text-[13px]">
                      <ShieldIcon className="size-3.5 text-muted-foreground" /> Permissions
                    </Label>
                    <div className="grid grid-cols-3 gap-2">
                      {PERMISSION_OPTIONS.map((opt) => (
                        <button
                          key={opt.v}
                          onClick={() => setPermission(opt.v)}
                          className={cn(
                            "rounded-xl border p-2 text-center transition-colors",
                            permission === opt.v
                              ? "border-primary bg-primary/8 text-primary"
                              : "border-border hover:bg-accent",
                          )}
                        >
                          <div className="text-[12.5px] font-medium">{opt.label}</div>
                          <div className="text-[10.5px] text-muted-foreground">{opt.hint}</div>
                        </button>
                      ))}
                    </div>
                    <p className="text-[11.5px] leading-snug text-muted-foreground">
                      Autonomy is the default — the microVM, egress policy, PAT scope and branch
                      protection are the guardrails, not prompts. Changes only ever land on a{" "}
                      <span className="font-mono">kiln/*</span> branch as a pull request.
                    </p>
                  </div>
                </div>
              )}

              <Button className="w-full" size="lg" disabled={!ready} onClick={() => void start()}>
                {busy ? <Loader2Icon className="animate-spin" /> : <RocketIcon />}
                Start task
              </Button>
            </div>
          </div>
        </DrawerContent>
      </Drawer>
      <ModelPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        value={modelRef}
        onSelect={(ref) => setModelRef(ref)}
        toolsOnly
      />
    </>
  )
}
