import { useEffect } from "react"
import { Navigate, Route, Routes } from "react-router-dom"
import { Toaster } from "@/components/ui/sonner"
import { DialogHost } from "@/stores/dialogs"
import { ErrorBoundary } from "@/components/ErrorBoundary"
import { useApplyTheme, useAppTheme, useIsDark } from "@/hooks/use-theme"
import { PipCanvas } from "@/pip/PipCanvas"
import { useSettings } from "@/stores/settings"
import { recoverInterrupted } from "@/lib/db"
import { clearBadge } from "@/lib/notify"
import { requestPersistentStorage, setupServiceWorker } from "@/lib/sw"
import { useModels } from "@/stores/models"
import ArtefactsPage from "@/pages/ArtefactsPage"
import ChatPage from "@/pages/ChatPage"
import ImagesPage from "@/pages/ImagesPage"
import SettingsPage from "@/pages/SettingsPage"

export default function App() {
  useApplyTheme()
  const isDark = useIsDark()
  const theme = useAppTheme()
  const pipOn = useSettings((s) => s.pipEnabled)

  useEffect(() => {
    const boot = async () => {
      if (new URLSearchParams(window.location.search).has("seed")) {
        const { seedDemo } = await import("@/lib/demo")
        await seedDemo()
        window.history.replaceState(null, "", "/")
      }
      void recoverInterrupted()
      void useModels.getState().refresh()
      void requestPersistentStorage()
    }
    void boot()
    setupServiceWorker()
    clearBadge()
    const onVisible = () => {
      if (document.visibilityState === "visible") clearBadge()
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => document.removeEventListener("visibilitychange", onVisible)
  }, [])

  return (
    <ErrorBoundary>
      <Routes>
        <Route path="/" element={<ChatPage />} />
        <Route path="/chat/:chatId" element={<ChatPage />} />
        <Route path="/images" element={<ImagesPage />} />
        <Route path="/images/:chatId" element={<ImagesPage />} />
        <Route path="/artefacts" element={<ArtefactsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        {/* Return leg of the auth-proxy re-login bounce (src/lib/sw.ts) on
            hosts that serve the SPA fallback instead of nginx's redirect. */}
        <Route path="/api/login" element={<Navigate to="/" replace />} />
        <Route path="*" element={<ChatPage />} />
      </Routes>
      <Toaster position="top-center" theme={isDark ? "dark" : "light"} />
      <DialogHost />
      {theme.features.pip && pipOn && <PipCanvas />}
      {theme.Overlay && <theme.Overlay />}
    </ErrorBoundary>
  )
}
