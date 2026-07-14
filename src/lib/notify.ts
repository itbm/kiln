import { getSettings } from "@/stores/settings"

export async function ensureNotificationPermission(): Promise<boolean> {
  if (!("Notification" in window)) return false
  if (Notification.permission === "granted") return true
  if (Notification.permission === "denied") return false
  const res = await Notification.requestPermission()
  return res === "granted"
}

/** Notify that a chat finished generating (only when app is hidden). */
export async function notifyChatDone(
  chatId: string,
  title: string,
  preview: string,
  url = `/chat/${chatId}`,
): Promise<void> {
  if (!getSettings().notifications) return
  if (document.visibilityState === "visible") return
  try {
    navigator.setAppBadge?.(1).catch(() => {})
    if (!("Notification" in window) || Notification.permission !== "granted")
      return
    const reg = await navigator.serviceWorker?.getRegistration()
    await reg?.showNotification(title || "Response ready", {
      body: preview.slice(0, 140) || "Your assistant has finished responding.",
      tag: `chat-${chatId}`,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: { url },
    })
  } catch {
    /* notifications are best-effort */
  }
}

export function clearBadge(): void {
  navigator.clearAppBadge?.().catch(() => {})
}

/* ---------- Screen wake lock (opt-in): keeps iOS from suspending mid-stream */

let wakeLock: WakeLockSentinel | null = null
let wanted = false

export async function acquireWakeLock(): Promise<void> {
  wanted = true
  if (!getSettings().keepAwake || !("wakeLock" in navigator)) return
  try {
    wakeLock ??= await navigator.wakeLock.request("screen")
    wakeLock.addEventListener("release", () => {
      wakeLock = null
    })
  } catch {
    /* low battery or unsupported */
  }
}

export function releaseWakeLock(): void {
  wanted = false
  wakeLock?.release().catch(() => {})
  wakeLock = null
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && wanted) void acquireWakeLock()
})
