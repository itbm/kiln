import { useState, type ReactNode } from "react"
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer"
import { SidebarContent } from "./Sidebar"
import { useIsDesktop } from "@/hooks/use-media"
import { pip } from "@/pip/bus"

export function AppShell({
  children,
}: {
  children: (openSidebar: () => void) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const isDesktop = useIsDesktop()

  // Let Pip react to the drawer: it can clobber him on the way open, and
  // he shoves it shut on the way closed. No-ops when he isn't mounted.
  const setDrawer = (o: boolean) => {
    if (o && !open) pip.drawerOpening()
    else if (!o && open) pip.drawerClosing()
    setOpen(o)
  }

  return (
    <div className="flex h-[var(--app-height)] w-full overflow-hidden">
      {isDesktop && (
        <aside className="w-72 shrink-0 border-r border-sidebar-border">
          <SidebarContent />
        </aside>
      )}
      <main className="relative flex min-w-0 flex-1 flex-col" data-ui="app-main">
        {children(() => setDrawer(true))}
      </main>
      {!isDesktop && (
        <Drawer direction="left" open={open} onOpenChange={setDrawer}>
          <DrawerContent className="!w-[85vw] !max-w-80 p-0">
            <DrawerTitle className="sr-only">Chats</DrawerTitle>
            <SidebarContent onNavigate={() => setDrawer(false)} />
          </DrawerContent>
        </Drawer>
      )}
    </div>
  )
}
