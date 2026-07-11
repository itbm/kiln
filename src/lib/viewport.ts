/**
 * Keeps CSS in sync with the visual viewport so the layout can react to the
 * on-screen keyboard.
 *
 * iOS Safari — home-screen web apps in particular — doesn't reliably resize
 * the layout viewport when the keyboard appears; it pans the whole page to
 * reveal the focused input, shifting the header off screen. Instead we
 * publish two custom properties on :root (defaults live in index.css):
 *
 *   --app-height  height of the visible area; the app shell is sized with it
 *                 so the composer rises above the keyboard while the header
 *                 and chat stay put
 *   --kb-inset    gap between the layout viewport's bottom edge and the top
 *                 of the keyboard, for fixed bottom sheets
 *
 * and pin the window scroll back to 0 — nothing in the app scrolls the
 * document itself, so any window scroll is the browser's keyboard pan.
 * In browsers that honour interactive-widget=resizes-content both values
 * simply match the already-resized viewport.
 */
export function initViewportTracking(): void {
  const vv = window.visualViewport
  if (!vv) return
  const root = document.documentElement
  const update = () => {
    // pinch-zoomed: keep the last stable values rather than reflowing
    if (Math.abs(vv.scale - 1) > 0.01) return
    root.style.setProperty("--app-height", `${Math.round(vv.height)}px`)
    const inset = Math.round(window.innerHeight - vv.height - vv.offsetTop)
    root.style.setProperty("--kb-inset", `${Math.max(0, inset)}px`)
    if (window.scrollX || window.scrollY) window.scrollTo(0, 0)
  }
  vv.addEventListener("resize", update)
  vv.addEventListener("scroll", update)
  update()
}
