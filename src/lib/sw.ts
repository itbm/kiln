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

const UPDATE_SETTLE_TIMEOUT = 8000
let updateInFlight: Promise<"settled" | "timeout"> | null = null

/**
 * registration.update() occasionally never settles in Chromium (notably when
 * a check lands while the just-installed worker is still activating), which
 * would pin the Settings button on "Checking…" forever. Share one in-flight
 * call between the automatic and manual checks so they can't race each other,
 * and give it a deadline — on timeout the caller falls back to reading the
 * registration's state, which reflects any update the fetch did find.
 */
function requestUpdateCheck(
  reg: ServiceWorkerRegistration,
): Promise<"settled" | "timeout"> {
  if (!updateInFlight) {
    let timer: ReturnType<typeof setTimeout> | undefined
    const attempt = reg.update().then(() => "settled" as const)
    const deadline = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), UPDATE_SETTLE_TIMEOUT)
    })
    updateInFlight = Promise.race([attempt, deadline]).finally(() => {
      clearTimeout(timer)
      updateInFlight = null
    })
  }
  return updateInFlight
}

async function checkNow(): Promise<void> {
  if (!registration || registration.installing) return
  if (!navigator.onLine) return
  lastCheck = Date.now()
  try {
    const outcome = await requestUpdateCheck(registration)
    if (outcome === "settled") clearSessionExpiredWarning()
  } catch {
    // offline or server unreachable — the next foreground check retries.
    // Unless it wasn't the network at all, but a login wall:
    void warnIfSessionExpired()
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

// Self-hosted instances often sit behind a login proxy (Cloudflare Access,
// Authelia, …). Once its session cookie expires the update check fails — but
// the app itself keeps loading from the service worker cache, so the only
// visible symptom is the check reporting "offline" forever. Nothing the app
// does through the worker cache ever reaches the proxy again, so the session
// can't renew on its own either; the user has to be told.

/**
 * Force a round trip through whatever auth proxy sits in front. Navigations
 * under /api/ are on the service worker's navigateFallbackDenylist
 * (vite.config.ts), so unlike a plain reload — which the worker serves from
 * cache without touching the network — this navigation always reaches the
 * server, giving the proxy its chance to run the login flow. Afterwards
 * nginx 302s /api/login back to /; hosts that serve the SPA fallback instead
 * land in the router, which redirects the same way (App.tsx).
 */
export function reloginViaProxy(): void {
  window.location.assign("/api/login")
}

/**
 * registration.update() rejects with a bare TypeError whether the server is
 * unreachable or an auth proxy bounced the request (the spec treats even a
 * redirect on a worker-script fetch as a hard failure). To tell the two
 * apart, fetch sw.js ourselves and look at what actually comes back.
 */
async function classifyUpdateFailure(): Promise<"offline" | "auth-expired"> {
  try {
    const res = await fetch("/sw.js", { cache: "no-store" })
    // A login wall answers with a redirect to its portal, an auth status,
    // or an HTML login page — never the worker script itself.
    if (res.redirected || res.status === 401 || res.status === 403)
      return "auth-expired"
    if (res.ok && (res.headers.get("content-type") ?? "").includes("html"))
      return "auth-expired"
    return "offline"
  } catch {
    if (!navigator.onLine) return "offline"
    // A redirect to a cross-origin login page without CORS headers makes a
    // normal fetch throw — indistinguishable from being offline. A no-cors
    // fetch follows redirects opaquely, so it succeeding while the browser
    // still believes it has a network points at a login wall, not an outage.
    try {
      await fetch("/sw.js", { mode: "no-cors", cache: "no-store" })
      return "auth-expired"
    } catch {
      return "offline"
    }
  }
}

/** One persistent toast per expiry — cleared when a later check gets through. */
let warnedSessionExpired = false

async function warnIfSessionExpired(): Promise<void> {
  if (warnedSessionExpired) return
  if ((await classifyUpdateFailure()) !== "auth-expired") return
  warnedSessionExpired = true
  toast("Your login session has expired", {
    id: "sw-relogin",
    duration: Infinity,
    description: "Kiln can't check for updates until you log in again.",
    action: { label: "Log in", onClick: () => reloginViaProxy() },
  })
}

function clearSessionExpiredWarning(): void {
  if (!warnedSessionExpired) return
  warnedSessionExpired = false
  toast.dismiss("sw-relogin")
}

export type UpdateCheckResult =
  | "update-ready"
  | "up-to-date"
  | "offline"
  | "auth-expired"
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
    const outcome = await requestUpdateCheck(registration)
    if (outcome === "settled") clearSessionExpiredWarning()
  } catch {
    return classifyUpdateFailure()
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
