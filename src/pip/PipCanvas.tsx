import { useEffect, useRef } from "react"
import { useStream } from "@/stores/stream"
import { pip } from "./bus"
import { PipEngine } from "./engine"

/**
 * The full-viewport canvas Pip lives on. Mount once (App.tsx gates it on
 * the theme's pip feature + the Settings toggle). pointer-events: none —
 * Pip watches taps but never intercepts them. Sits above sheets/drawers
 * (z-50) so he can perch on their edges, below toasts.
 */
export function PipCanvas() {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    const engine = new PipEngine(cv)
    engine.start()
    pip.bind(engine)

    /* flare when a reply starts streaming; celebrate when one lands */
    const unsub = useStream.subscribe((state, prev) => {
      for (const id of Object.keys(state.generating))
        if (!(id in prev.generating)) engine.flareUp()
      for (const id of Object.keys(prev.generating))
        if (!(id in state.generating)) engine.celebrate()
    })

    return () => {
      unsub()
      pip.unbind(engine)
      engine.destroy()
    }
  }, [])

  return (
    /* the engine sets the CSS size in px to match the bitmap exactly —
       percentage sizing drifts from window.innerHeight while the iOS
       keyboard is up, which drew Pip stretched (see PipEngine.resize) */
    <canvas
      ref={ref}
      aria-hidden
      className="pointer-events-none fixed left-0 top-0 z-[60]"
    />
  )
}
