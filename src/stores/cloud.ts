import { create } from "zustand"
import { probeCloud } from "@/lib/cloud"

/**
 * Whether this deployment's server has the cloud turn runner. Probed once
 * at boot (and again on demand); the composer's Local/Cloud pill only
 * appears when it does, so servers without the runner show no dead UI.
 */
interface CloudState {
  /** false until a probe has succeeded */
  available: boolean
  /** a probe has completed (successful or not) */
  checked: boolean
  probe: () => Promise<boolean>
}

export const useCloud = create<CloudState>()((set) => ({
  available: false,
  checked: false,
  probe: async () => {
    const available = await probeCloud()
    set({ available, checked: true })
    return available
  },
}))
