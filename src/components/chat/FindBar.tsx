import { useEffect, useRef, useState, type RefObject } from "react"
import { ChevronDownIcon, ChevronUpIcon, SearchIcon, XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  clearHits,
  collectHits,
  paintHits,
  scrollToHit,
  type FindHit,
} from "@/lib/find"

/** Hit closest to the middle of the current view — where the eye already is. */
function nearestHit(scroller: HTMLElement, hits: FindHit[]): number {
  if (hits.length < 2) return 0
  const box = scroller.getBoundingClientRect()
  const eye = box.top + box.height / 2
  let best = 0
  let bestDist = Infinity
  hits.forEach((h, i) => {
    const r = h.range.getBoundingClientRect()
    if (!r.height && !r.width) return
    const d = Math.abs(r.top + r.height / 2 - eye)
    if (d < bestDist) {
      bestDist = d
      best = i
    }
  })
  return best
}

/**
 * Find-in-chat bar. Lives above the composer because that's where the thumb
 * is; an installed PWA has no browser find-in-page to fall back on.
 */
export function FindBar({
  scroller,
  revision,
  initialQuery = "",
  onClose,
}: {
  scroller: RefObject<HTMLDivElement | null>
  /** bump to recompute hits (messages changed / a reply streamed in) */
  revision: number
  initialQuery?: string
  onClose: () => void
}) {
  const [query, setQuery] = useState(initialQuery)
  const [hits, setHits] = useState<FindHit[]>([])
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  /* a fresh query re-picks the nearest hit and jumps to it; a recompute
     caused by new messages must not yank the view around */
  const jump = useRef(true)

  useEffect(() => {
    // arriving from a search result: show the hits, don't pop the keyboard
    if (!initialQuery) inputRef.current?.focus()
  }, [initialQuery])

  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const t = setTimeout(() => {
      const next = collectHits(el, query)
      setHits(next)
      if (jump.current) {
        jump.current = false
        const i = nearestHit(el, next)
        setIndex(i)
        if (next[i]) scrollToHit(el, next[i])
      } else {
        setIndex((v) => Math.min(v, Math.max(0, next.length - 1)))
      }
    }, 110)
    return () => clearTimeout(t)
  }, [query, revision, scroller])

  useEffect(() => {
    paintHits(hits, index)
  }, [hits, index])

  useEffect(() => clearHits, [])

  const step = (delta: number) => {
    if (!hits.length) return
    const next = (index + delta + hits.length) % hits.length
    setIndex(next)
    const el = scroller.current
    if (el) scrollToHit(el, hits[next])
  }

  const typed = !!query.trim()

  return (
    <div className="px-4 pb-1.5" data-find-skip>
      <div
        data-ui="find-bar"
        data-pip-spot="ledge"
        className="flex items-center gap-1 rounded-full border border-border bg-card px-3 py-1.5 shadow-sm"
      >
        <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            jump.current = true
            setQuery(e.target.value)
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              step(e.shiftKey ? -1 : 1)
            } else if (e.key === "Escape") {
              e.preventDefault()
              onClose()
            }
          }}
          placeholder="Find in chat"
          aria-label="Find in chat"
          className="min-w-0 flex-1 bg-transparent text-[16px] outline-none placeholder:text-muted-foreground/70 md:text-[14px]"
        />
        <span
          className="shrink-0 tabular-nums text-[12px] text-muted-foreground"
          data-ui="find-count"
        >
          {typed ? `${hits.length ? index + 1 : 0}/${hits.length}` : ""}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Previous match"
          disabled={!hits.length}
          onClick={() => step(-1)}
        >
          <ChevronUpIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Next match"
          disabled={!hits.length}
          onClick={() => step(1)}
        >
          <ChevronDownIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Close find"
          onClick={onClose}
        >
          <XIcon />
        </Button>
      </div>
    </div>
  )
}
