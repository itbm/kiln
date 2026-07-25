/**
 * Find in chat: locate a query across the rendered conversation and paint
 * the hits with the CSS Custom Highlight API — ranges only, no DOM
 * mutation, so react-markdown never sees a thing and highlighting can't
 * disturb code blocks, tables or artefact cards.
 *
 * Where the API is missing (older WebKit) the hits still drive scrolling
 * and the message flash; you just don't get the paint.
 */

export interface FindHit {
  /** message the hit sits in (data-msg-id on the message container) */
  messageId: string
  range: Range
}

const ALL = "kiln-find"
const CURRENT = "kiln-find-current"

type HighlightRegistryLike = {
  set(name: string, highlight: object): void
  delete(name: string): void
}
type HighlightCtor = new (...ranges: Range[]) => object

function registry(): HighlightRegistryLike | null {
  if (typeof CSS === "undefined") return null
  return (CSS as unknown as { highlights?: HighlightRegistryLike }).highlights ?? null
}

function highlightCtor(): HighlightCtor | null {
  return (window as unknown as { Highlight?: HighlightCtor }).Highlight ?? null
}

/** Every occurrence of `query` in the rendered messages, in document order. */
export function collectHits(root: HTMLElement, query: string): FindHit[] {
  const needle = query.trim().toLowerCase()
  const hits: FindHit[] = []
  if (!needle) return hits

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const parent = node.parentElement
      if (!parent || !node.nodeValue?.trim()) return NodeFilter.FILTER_REJECT
      // chrome (version switcher, captions, the bar itself) opts out
      return parent.closest("[data-find-skip]")
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT
    },
  })

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = (node.nodeValue ?? "").toLowerCase()
    const owner = node.parentElement?.closest<HTMLElement>("[data-msg-id]")
    const messageId = owner?.dataset.msgId ?? ""
    for (let from = 0; ; ) {
      const i = text.indexOf(needle, from)
      if (i < 0) break
      const range = document.createRange()
      range.setStart(node, i)
      range.setEnd(node, i + needle.length)
      hits.push({ messageId, range })
      from = i + needle.length
    }
  }
  return hits
}

/** Paint every hit, with the current one in the stronger colour. */
export function paintHits(hits: FindHit[], current: number): void {
  const reg = registry()
  const Highlight = highlightCtor()
  if (!reg || !Highlight) return
  clearHits()
  if (!hits.length) return
  const rest = hits.filter((_, i) => i !== current).map((h) => h.range)
  if (rest.length) reg.set(ALL, new Highlight(...rest))
  const cur = hits[current]
  if (cur) reg.set(CURRENT, new Highlight(cur.range))
}

export function clearHits(): void {
  const reg = registry()
  reg?.delete(ALL)
  reg?.delete(CURRENT)
}

/** Centre a rectangle (hit or element) inside its scroll container. */
function centre(scroller: HTMLElement, rect: DOMRect, smooth: boolean): void {
  if (!rect.height && !rect.width) return
  const box = scroller.getBoundingClientRect()
  const top =
    scroller.scrollTop + (rect.top - box.top) - (box.height - rect.height) / 2
  scroller.scrollTo({
    top: Math.max(0, Math.min(top, scroller.scrollHeight)),
    behavior: smooth ? "smooth" : "auto",
  })
}

export function scrollToHit(
  scroller: HTMLElement,
  hit: FindHit,
  smooth = true,
): void {
  centre(scroller, hit.range.getBoundingClientRect(), smooth)
}

/**
 * Scroll a message into the middle of the view and flash it — used when a
 * search result from the sidebar opens a chat, so the answer to "where was
 * that?" is on screen rather than 200 messages up.
 */
export function revealMessage(
  scroller: HTMLElement,
  messageId: string,
  smooth = false,
): boolean {
  const el = scroller.querySelector<HTMLElement>(
    `[data-msg-id="${CSS.escape(messageId)}"]`,
  )
  if (!el) return false
  centre(scroller, el.getBoundingClientRect(), smooth)
  el.classList.remove("find-flash")
  // restart the animation even if the same message is revealed twice
  void el.offsetWidth
  el.classList.add("find-flash")
  setTimeout(() => el.classList.remove("find-flash"), 2000)
  return true
}
