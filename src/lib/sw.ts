import { registerSW } from "virtual:pwa-register"
import { toast } from "sonner"

let started = false

export function setupServiceWorker(): void {
  if (started || !("serviceWorker" in navigator)) return
  started = true
  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      toast("A new version of Kiln is ready", {
        id: "sw-update",
        duration: Infinity,
        action: {
          label: "Update",
          onClick: () => void updateSW(true),
        },
      })
    },
  })
}

/** Ask the browser to protect IndexedDB from eviction. Safe to call repeatedly. */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false
    if (await navigator.storage.persisted()) return true
    return await navigator.storage.persist()
  } catch {
    return false
  }
}
