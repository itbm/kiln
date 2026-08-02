import { create } from "zustand"
import { probeForge } from "@/lib/forge"

/**
 * Whether this deployment can run coding turns. Probed once at boot, like the
 * cloud runner — no forge, no Code chat entry point, so a server without one
 * shows no dead UI.
 *
 * `reason` exists because the forge can be deployed and still unusable: sbx
 * needs KVM and a logged-in Docker account on the host. "sbx daemon
 * unreachable" is a fixable message; silently hiding the feature is not.
 */
interface ForgeState {
  available: boolean
  checked: boolean
  reason?: string
  probe: () => Promise<boolean>
}

export const useForge = create<ForgeState>()((set) => ({
  available: false,
  checked: false,
  probe: async () => {
    const { ok, reason } = await probeForge()
    set({ available: ok, checked: true, reason })
    return ok
  },
}))
