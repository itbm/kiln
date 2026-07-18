import { registerSW } from "virtual:pwa-register"
import { toast } from "sonner"
import { create } from "zustand"

// The browser only looks for a new service worker when the page (re)loads.
// An installed app — especially on the iOS Home Screen — resumes from a
// snapshot instead of reloading, so that built-in check almost never runs
// and users can sit on a stale version for weeks. We check ourselves:
// whenever the app returns to the foreground, hourly while it stays open,
// and on demand from Settings → App updates.

/** `ready` flips true once a new version is downloaded and waiting. */
export const useSWUpdate = create<{ ready: boolean }>(() => ({ ready: false }))

let started = false
let updateSW: ((reloadPage?: boolean) => Promise<void>) | undefined
let registration: ServiceWorkerRegistration | undefined

/** Throttle foreground checks so rapid app-switching doesn't spam the server. */
const FOREGROUND_CHECK_GAP = 60 * 1000
const PERIODIC_CHECK_EVERY = 60 * 60 * 1000
let lastCheck = 0

async function checkNow(): Promise<void> {
  if (!registration || registration.installing) return
  if (!navigator.onLine) return
  lastCheck = Date.now()
  try {
    await registration.update()
  } catch {
    // offline or server unreachable — the next foreground check retries
  }
}

export function setupServiceWorker(): void {
  if (started || !("serviceWorker" in navigator)) return
  started = true
  updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      useSWUpdate.setState({ ready: true })
      toast("A new version of Kiln is ready", {
        id: "sw-update",
        duration: Infinity,
        action: {
          label: "Update",
          onClick: () => applyUpdate(),
        },
      })
    },
    onRegisteredSW(_url, r) {
      registration = r
      if (!r) return
      const onForeground = () => {
        if (document.visibilityState !== "visible") return
        if (Date.now() - lastCheck < FOREGROUND_CHECK_GAP) return
        void checkNow()
      }
      document.addEventListener("visibilitychange", onForeground)
      window.addEventListener("pageshow", onForeground)
      setInterval(() => {
        if (document.visibilityState === "visible") void checkNow()
      }, PERIODIC_CHECK_EVERY)
    },
  })
}

/** Swap to the downloaded version and reload the app. */
export function applyUpdate(): void {
  void updateSW?.(true)
}

export type UpdateCheckResult =
  | "update-ready"
  | "up-to-date"
  | "offline"
  | "unavailable"

/**
 * Manual check for Settings. Resolves once the check has actually finished:
 * if a new version exists it is downloaded before this returns, so
 * "update-ready" means it can be applied immediately.
 */
export async function checkForUpdates(): Promise<UpdateCheckResult> {
  if (useSWUpdate.getState().ready) return "update-ready"
  if (!("serviceWorker" in navigator)) return "unavailable"
  // registerSW resolves asynchronously — fall back to the live registration
  // if the button is hit before onRegisteredSW has run (or in dev, where
  // no service worker is registered at all).
  registration ??= await navigator.serviceWorker.getRegistration()
  if (!registration) return "unavailable"
  if (!navigator.onLine) return "offline"
  lastCheck = Date.now()
  try {
    await registration.update()
  } catch {
    return "offline"
  }
  // A found update shows up on the registration as an installing (or already
  // waiting) worker. On a first-ever visit the initial install looks the same,
  // but the page isn't controlled yet — that's not an update.
  if (!navigator.serviceWorker.controller) return "up-to-date"
  if (registration.waiting) {
    useSWUpdate.setState({ ready: true })
    return "update-ready"
  }
  const installing = registration.installing
  if (!installing) return "up-to-date"
  const installed = await new Promise<boolean>((resolve) => {
    const done = (ok: boolean) => {
      clearTimeout(timer)
      installing.removeEventListener("statechange", onState)
      resolve(ok)
    }
    const timer = setTimeout(() => done(false), 20_000)
    const onState = () => {
      if (installing.state === "installed" || installing.state === "activated")
        done(true)
      else if (installing.state === "redundant") done(false)
    }
    installing.addEventListener("statechange", onState)
    onState()
  })
  if (installed) useSWUpdate.setState({ ready: true })
  return installed ? "update-ready" : "up-to-date"
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
