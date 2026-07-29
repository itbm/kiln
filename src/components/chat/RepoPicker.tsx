import { useEffect, useState } from "react"
import {
  ArrowLeftIcon,
  CheckIcon,
  GitBranchIcon,
  KeyIcon,
  LockIcon,
  Loader2Icon,
  RefreshCwIcon,
  ShieldAlertIcon,
} from "lucide-react"
import { useNavigate } from "react-router-dom"
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Button } from "@/components/ui/button"
import { useRepos } from "@/stores/repos"
import { useSettings } from "@/stores/settings"
import {
  listBranches,
  suggestWorkBranch,
  type GithubBranch,
  type GithubRepo,
} from "@/lib/github"
import type { CodeRepo } from "@/lib/types"
import { cn, timeAgo } from "@/lib/utils"

/**
 * Two-step chooser for a code chat: a repository, then the branch to work
 * from. Shaped like ModelPicker — same drawer, same cmdk search — because it
 * does the same job and should feel identical.
 *
 * The branch chosen here is the *base*: it is read and branched from, never
 * written to. The branch the agent commits on is generated separately.
 */
export function RepoPicker({
  open,
  onOpenChange,
  onSelect,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  onSelect: (repo: CodeRepo) => void
}) {
  const { repos, loading, error, fetchedAt, refresh } = useRepos()
  const hasToken = useSettings((s) => !!s.githubToken)
  const navigate = useNavigate()

  const [chosen, setChosen] = useState<GithubRepo | null>(null)
  const [branches, setBranches] = useState<GithubBranch[]>([])
  const [branchesLoading, setBranchesLoading] = useState(false)
  const [branchError, setBranchError] = useState<string | undefined>()

  useEffect(() => {
    if (open) void refresh()
  }, [open, refresh])

  // Reopening should always start at the repository list rather than resuming
  // a half-finished choice from last time.
  useEffect(() => {
    if (!open) {
      setChosen(null)
      setBranches([])
      setBranchError(undefined)
    }
  }, [open])

  const pickRepo = async (r: GithubRepo) => {
    setChosen(r)
    setBranches([])
    setBranchError(undefined)
    setBranchesLoading(true)
    try {
      // Branches aren't cached: they move far more than the repository list,
      // and a stale branch here would send the agent to the wrong base.
      setBranches(await listBranches(r.owner, r.name))
    } catch (e) {
      setBranchError((e as Error).message)
    } finally {
      setBranchesLoading(false)
    }
  }

  const pickBranch = (b: GithubBranch) => {
    if (!chosen) return
    onSelect({
      owner: chosen.owner,
      name: chosen.name,
      defaultBranch: chosen.defaultBranch,
      baseBranch: b.name,
      workBranch: suggestWorkBranch(),
      private: chosen.private,
    })
    onOpenChange(false)
  }

  return (
    // repositionInputs off for the same reason as ModelPicker: vaul's keyboard
    // handling fights --app-height/--kb-inset (see lib/viewport.ts).
    <Drawer open={open} onOpenChange={onOpenChange} repositionInputs={false}>
      <DrawerContent className="h-[calc(var(--app-height)*0.92)] !max-h-[calc(var(--app-height)*0.92)] !bottom-[var(--kb-inset)]">
        <div className="flex items-center justify-between gap-2 px-4 pt-3 pb-1">
          <div className="flex min-w-0 items-center gap-1.5">
            {chosen && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Back to repositories"
                onClick={() => setChosen(null)}
              >
                <ArrowLeftIcon className="size-4.5" />
              </Button>
            )}
            <DrawerTitle className="truncate text-[15px] font-semibold">
              {chosen ? `${chosen.owner}/${chosen.name}` : "Choose repository"}
            </DrawerTitle>
          </div>
          {!chosen && (
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0 text-muted-foreground"
              onClick={() => void refresh(true)}
              disabled={loading}
            >
              {loading ? (
                <Loader2Icon className="animate-spin" />
              ) : (
                <RefreshCwIcon />
              )}
              {fetchedAt ? timeAgo(fetchedAt) : "refresh"}
            </Button>
          )}
        </div>

        {chosen ? (
          /* Distinct keys on the two steps' Command elements: without them
             React reconciles these as one instance, and cmdk's search value
             survives the step change — so a repository query would silently
             filter the branch list down to nothing. */
          <Command key="branches" className="min-h-0 flex-1 bg-transparent">
            <div className="px-3 pb-2">
              <CommandInput placeholder="Search branches…" />
            </div>
            <CommandList className="max-h-none min-h-0 flex-1 px-3 pb-safe">
              {branchesLoading ? (
                <div className="flex items-center justify-center gap-2 py-8 text-[13px] text-muted-foreground">
                  <Loader2Icon className="size-4 animate-spin" />
                  Loading branches…
                </div>
              ) : branchError ? (
                <div className="px-2 py-8 text-center text-[13px] text-destructive">
                  {branchError}
                </div>
              ) : (
                <>
                  <CommandEmpty>No branches found.</CommandEmpty>
                  <CommandGroup heading="Work from">
                    {branches.map((b) => (
                      <CommandItem
                        key={b.name}
                        value={b.name}
                        onSelect={() => pickBranch(b)}
                        className="flex items-center gap-2 rounded-xl px-2 py-2.5"
                      >
                        <GitBranchIcon className="size-4 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate font-mono text-[13px]">
                          {b.name}
                        </span>
                        {b.name === chosen.defaultBranch && (
                          <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                            default
                          </span>
                        )}
                        {b.protected && (
                          <ShieldAlertIcon
                            className="size-3.5 shrink-0 text-muted-foreground"
                            aria-label="Protected branch"
                          />
                        )}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </>
              )}
            </CommandList>
          </Command>
        ) : (
          <Command key="repos" className="min-h-0 flex-1 bg-transparent">
            <div className="px-3 pb-2">
              <CommandInput placeholder="Search repositories…" />
            </div>
            <CommandList className="max-h-none min-h-0 flex-1 px-3 pb-safe">
              <CommandEmpty>No repositories found.</CommandEmpty>
              <CommandGroup heading="Recently pushed">
                {repos.map((r) => (
                  <CommandItem
                    key={r.fullName}
                    value={r.fullName}
                    onSelect={() => void pickRepo(r)}
                    className="flex items-center gap-2 rounded-xl px-2 py-2.5"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-[14px] font-medium">
                          {r.name}
                        </span>
                        {r.private && (
                          <LockIcon
                            className="size-3.5 shrink-0 text-muted-foreground"
                            aria-label="Private"
                          />
                        )}
                      </div>
                      <div className="truncate text-[11px] text-muted-foreground">
                        {r.owner}
                        {r.description ? ` · ${r.description}` : ""}
                      </div>
                    </div>
                    {r.pushedAt > 0 && (
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {timeAgo(r.pushedAt)}
                      </span>
                    )}
                    <CheckIcon className="size-4 shrink-0 opacity-0" />
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        )}

        <div
          className="border-t border-border px-4 pt-2.5 pb-safe-plus text-[12px] text-muted-foreground"
          data-pip-spot="sheet-foot"
        >
          {!hasToken ? (
            <button
              className="flex items-center gap-1.5 text-primary"
              onClick={() => {
                onOpenChange(false)
                navigate("/settings")
              }}
            >
              <KeyIcon className="size-3.5" />
              Add a GitHub token in Settings to code
            </button>
          ) : error ? (
            <span className={cn("text-destructive")}>{error}</span>
          ) : chosen ? (
            <span>
              Read from the branch you pick — commits go to a new branch, never
              this one.
            </span>
          ) : (
            <span>
              {repos.length} repositor{repos.length === 1 ? "y" : "ies"} · only
              those this token was granted
            </span>
          )}
        </div>
      </DrawerContent>
    </Drawer>
  )
}
