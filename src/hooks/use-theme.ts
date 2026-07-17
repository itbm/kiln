import { useEffect } from "react"
import { getTheme, THEMES, type AppThemeDef } from "@/lib/themes"
import { useSettings } from "@/stores/settings"

export function useApplyTheme() {
  const scheme = useSettings((s) => s.theme)
  const appThemeId = useSettings((s) => s.appTheme)
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)")
    const theme = getTheme(appThemeId)
    const apply = () => {
      const dark =
        scheme === "dark" || (scheme === "system" && mq.matches)
      const root = document.documentElement
      root.classList.toggle("dark", dark)
      for (const t of THEMES)
        root.classList.toggle(t.htmlClass, t.id === theme.id)
      const meta = document.querySelector(
        'meta[name="theme-color"]:not([media])',
      )
      const color = dark ? theme.themeColor.dark : theme.themeColor.light
      if (meta) meta.setAttribute("content", color)
      else {
        const m = document.createElement("meta")
        m.name = "theme-color"
        m.content = color
        document.head.appendChild(m)
      }
    }
    apply()
    mq.addEventListener("change", apply)
    return () => mq.removeEventListener("change", apply)
  }, [scheme, appThemeId])
}

/** The active app theme definition (Ember, Classic, …). */
export function useAppTheme(): AppThemeDef {
  return getTheme(useSettings((s) => s.appTheme))
}

export function useIsDark(): boolean {
  const theme = useSettings((s) => s.theme)
  if (theme === "system")
    return typeof window !== "undefined"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
      : false
  return theme === "dark"
}
