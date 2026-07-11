import { useState, type ReactNode } from "react"
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer"
import { SidebarContent } from "./Sidebar"
import { useIsDesktop } from "@/hooks/use-media"

export function AppShell({
  children,
}: {
  children: (openSidebar: () => void) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const isDesktop = useIsDesktop()

  return (
    <div className="flex h-[var(--app-height)] w-full overflow-hidden">
      {isDesktop && (
        <aside className="w-72 shrink-0 border-r border-sidebar-border">
          <SidebarContent />
        </aside>
      )}
      <main className="relative flex min-w-0 flex-1 flex-col">
        {children(() => setOpen(true))}
      </main>
      {!isDesktop && (
        <Drawer direction="left" open={open} onOpenChange={setOpen}>
          <DrawerContent className="!w-[85vw] !max-w-80 p-0">
            <DrawerTitle className="sr-only">Chats</DrawerTitle>
            <SidebarContent onNavigate={() => setOpen(false)} />
          </DrawerContent>
        </Drawer>
      )}
    </div>
  )
}
