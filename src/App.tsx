import { useEffect } from "react"
import { Route, Routes } from "react-router-dom"
import { Toaster } from "@/components/ui/sonner"
import { DialogHost } from "@/stores/dialogs"
import { useApplyTheme, useIsDark } from "@/hooks/use-theme"
import { recoverInterrupted } from "@/lib/db"
import { clearBadge } from "@/lib/notify"
import { useModels } from "@/stores/models"
import ChatPage from "@/pages/ChatPage"
import ImagesPage from "@/pages/ImagesPage"
import SettingsPage from "@/pages/SettingsPage"

export default function App() {
  useApplyTheme()
  const isDark = useIsDark()

  useEffect(() => {
    const boot = async () => {
      if (new URLSearchParams(window.location.search).has("seed")) {
        const { seedDemo } = await import("@/lib/demo")
        await seedDemo()
        window.history.replaceState(null, "", "/")
      }
      void recoverInterrupted()
      void useModels.getState().refresh()
    }
    void boot()
    clearBadge()
    const onVisible = () => {
      if (document.visibilityState === "visible") clearBadge()
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => document.removeEventListener("visibilitychange", onVisible)
  }, [])

  return (
    <>
      <Routes>
        <Route path="/" element={<ChatPage />} />
        <Route path="/chat/:chatId" element={<ChatPage />} />
        <Route path="/images" element={<ImagesPage />} />
        <Route path="/images/:chatId" element={<ImagesPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<ChatPage />} />
      </Routes>
      <Toaster position="top-center" theme={isDark ? "dark" : "light"} />
      <DialogHost />
    </>
  )
}
