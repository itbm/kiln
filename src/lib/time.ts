/**
 * Dates and times in UI copy. en-GB throughout, like the rest of the app's
 * wording — "25 July 2026, 14:32", never "7/25/2026".
 */

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

/** Time of day for a message's meta line: "14:32". */
export function clockTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  })
}

/** Which day a message belongs to: "Today", "Yesterday", "21 July". */
export function dayLabel(ts: number): string {
  const today = startOfDay(new Date())
  const d = new Date(ts)
  if (d >= today) return "Today"
  if (d >= new Date(today.getTime() - 86_400_000)) return "Yesterday"
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    // the year only earns its place once it isn't this one
    ...(d.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }),
  })
}

/** Do these two fall on the same calendar day? */
export function sameDay(a: number, b: number): boolean {
  const x = new Date(a)
  const y = new Date(b)
  return (
    x.getFullYear() === y.getFullYear() &&
    x.getMonth() === y.getMonth() &&
    x.getDate() === y.getDate()
  )
}

/** The long form, for a tooltip or a document header. */
export function fullDateTime(ts: number): string {
  return new Date(ts).toLocaleString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}
