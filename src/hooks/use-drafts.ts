import { useLiveQuery } from "dexie-react-hooks"
import { db } from "@/lib/db"
import { draftPreview } from "@/lib/drafts"

const NONE = new Map<string, string>()

/**
 * chat id → one-line preview of its unsent draft, for the chat list.
 * Rows are read and dropped inside the query so attachment data URLs never
 * linger in React state. Ghost-mode drafts aren't on disk, so aren't here.
 */
export function useDraftPreviews(): Map<string, string> {
  return useLiveQuery(
    async () => {
      const previews = new Map<string, string>()
      await db.drafts.each((d) => {
        const n = d.attachments?.length ?? 0
        previews.set(
          d.id,
          draftPreview(d.text) ||
            `${n} attachment${n === 1 ? "" : "s"}`,
        )
      })
      return previews
    },
    [],
    NONE,
  )
}
