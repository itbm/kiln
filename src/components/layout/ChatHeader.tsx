import type { ReactNode } from "react"
import { GhostIcon, PanelLeftIcon, SquarePenIcon } from "lucide-react"
import { useNavigate } from "react-router-dom"
import { Button } from "@/components/ui/button"
import { useIsDesktop } from "@/hooks/use-media"

export function ChatHeader({
  title,
  subtitle,
  temporary,
  wordmark,
  onOpenSidebar,
  newPath = "/",
  actions,
}: {
  title: string
  subtitle?: string
  temporary?: boolean
  /** render the title as the brand wordmark (Ember theme home screen) */
  wordmark?: boolean
  onOpenSidebar: () => void
  newPath?: string
  actions?: ReactNode
}) {
  const navigate = useNavigate()
  const isDesktop = useIsDesktop()

  return (
    <header className="pt-safe" data-ui="app-header">
      <div aria-hidden data-ui="topline" />
      <div
        className="flex h-12 items-center gap-1 border-b border-border/70 bg-background/90 px-2 backdrop-blur"
        data-pip-spot="header"
      >
        {!isDesktop && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Open menu"
            data-pip-spot="menu"
            onClick={onOpenSidebar}
          >
            <PanelLeftIcon className="size-5" />
          </Button>
        )}
        <div className="min-w-0 flex-1 px-1 text-center">
          <div className="mx-auto flex max-w-[70vw] items-center justify-center gap-1.5">
            {temporary && <GhostIcon className="size-4 shrink-0 text-primary" />}
            <h1
              className="truncate text-[15px] font-semibold"
              data-ui="app-title"
              data-wordmark={wordmark ? "true" : undefined}
            >
              {title}
            </h1>
          </div>
          {subtitle && (
            <div
              className="truncate text-[11px] leading-tight text-muted-foreground"
              data-ui="header-sub"
            >
              {subtitle}
            </div>
          )}
        </div>
        {actions}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="New chat"
          onClick={() => navigate(newPath)}
        >
          <SquarePenIcon className="size-5" />
        </Button>
      </div>
    </header>
  )
}
