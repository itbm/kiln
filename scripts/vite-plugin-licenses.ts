import { readFileSync } from "node:fs"
import path from "node:path"
import type { Plugin } from "vite"

// Serves `virtual:licenses` — the app's production dependency tree with each
// package's licence, regenerated from package-lock.json on every build so the
// Settings licences dialog can never drift from what actually ships. Keep the
// shape in sync with the module declaration in src/vite-env.d.ts.
interface PackageLicense {
  name: string
  version: string
  license: string
}

interface LockfilePackage {
  version?: string
  license?: string
  dev?: boolean
}

function collectLicenses(lockfilePath: string): PackageLicense[] {
  const lock = JSON.parse(readFileSync(lockfilePath, "utf8")) as {
    packages?: Record<string, LockfilePackage>
  }
  const marker = "node_modules/"
  const seen = new Map<string, PackageLicense>()
  for (const [key, pkg] of Object.entries(lock.packages ?? {})) {
    // dev-only packages never ship in the bundle; nested paths
    // (a/node_modules/b) are deduped to one entry per name@version
    if (!key.startsWith(marker) || pkg.dev) continue
    const name = key.slice(key.lastIndexOf(marker) + marker.length)
    const version = pkg.version ?? ""
    seen.set(`${name}@${version}`, {
      name,
      version,
      license: pkg.license ?? "Unknown",
    })
  }
  return [...seen.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  )
}

export function licenses(root: string): Plugin {
  const virtualId = "virtual:licenses"
  const resolvedId = "\0" + virtualId
  const lockfilePath = path.resolve(root, "package-lock.json")
  return {
    name: "kiln:licenses",
    resolveId(id) {
      return id === virtualId ? resolvedId : undefined
    },
    load(id) {
      if (id !== resolvedId) return
      this.addWatchFile(lockfilePath)
      return `export default ${JSON.stringify(collectLicenses(lockfilePath))}`
    },
  }
}
