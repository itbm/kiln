import type { Attachment, Draft } from "./types"
import { db } from "./db"

/**
 * Unsent composer text, kept per chat.
 *
 * A phone is a hostile place to write a long prompt: you leave to copy
 * something, iOS discards the PWA, and the paragraph is gone. Every draft is
 * therefore mirrored into IndexedDB (idle-debounced, flushed the moment the
 * app is backgrounded) and restored when you come back to that chat.
 *
 * Drafts for temporary chats are `ephemeral`: they live in this module's
 * cache only, because ghost mode promises nothing is written to disk.
 */

/** Draft keys for the chats that don't exist yet — one per studio. */
export const NEW_CHAT_DRAFT = "new:chat"
export const NEW_IMAGE_DRAFT = "new:image"

/** how long typing has to pause before the draft is written */
const IDLE_MS = 1200

/** latest known draft for every key touched this session */
const cache = new Map<string, Draft>()
/** keys whose cached draft still needs writing to IndexedDB */
const dirty = new Set<string>()
let timer: ReturnType<typeof setTimeout> | undefined

/** The draft to put back in the composer, from the cache or from disk. */
export async function loadDraft(key: string): Promise<Draft | undefined> {
  const cached = cache.get(key)
  if (cached) return cached
  const stored = await db.drafts.get(key)
  if (stored) cache.set(key, stored)
  return stored
}

/** Record what's in the composer now. Empty text + no files clears it. */
export function saveDraft(
  key: string,
  text: string,
  attachments: Attachment[],
  ephemeral = false,
): void {
  const files = attachments.length ? attachments : undefined
  if (!text.trim() && !files) {
    clearDraft(key)
    return
  }
  cache.set(key, { id: key, text, attachments: files, updatedAt: Date.now() })
  if (ephemeral) return
  dirty.add(key)
  clearTimeout(timer)
  timer = setTimeout(() => void flushDrafts(), IDLE_MS)
}

/** Forget a draft entirely — it was sent, or the chat is gone. */
export function clearDraft(key: string): void {
  cache.delete(key)
  dirty.delete(key)
  void db.drafts.delete(key)
}

/**
 * The chat this draft belongs to just became temporary: keep the words in
 * the composer, but take them off the disk.
 */
export function makeDraftEphemeral(key: string): void {
  dirty.delete(key)
  void db.drafts.delete(key)
}

/** …and the reverse: a ghost chat saved to history takes its draft with it. */
export async function persistDraft(key: string): Promise<void> {
  const draft = cache.get(key)
  if (draft) await db.drafts.put(draft)
}

/** Write pending drafts now (idle timer, or the app going away). */
export async function flushDrafts(): Promise<void> {
  clearTimeout(timer)
  timer = undefined
  if (!dirty.size) return
  const rows: Draft[] = []
  for (const key of dirty) {
    const draft = cache.get(key)
    if (draft) rows.push(draft)
  }
  dirty.clear()
  if (rows.length) await db.drafts.bulkPut(rows)
}

/** One line of a draft for the chat list. */
export function draftPreview(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 80)
}

/* An iOS PWA is often never "unloaded" — it just stops existing. Backgrounding
   is the last reliable moment to get the words on disk. */
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => void flushDrafts())
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void flushDrafts()
  })
}
