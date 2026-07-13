/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

declare const __APP_VERSION__: string

// Generated at build time by scripts/vite-plugin-licenses.ts — keep the
// shape in sync with the PackageLicense interface there.
declare module "virtual:licenses" {
  export interface PackageLicense {
    name: string
    version: string
    license: string
  }
  const licenses: PackageLicense[]
  export default licenses
}
