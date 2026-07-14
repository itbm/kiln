import { loadConfig } from "./config.js"
import { SbxDriver } from "./driver/sbx.js"
import { log, errClass } from "./log.js"
import { SessionManager } from "./manager.js"
import { buildServer } from "./server.js"

/**
 * kiln-agentd — a thin control plane between the Kiln PWA and per-session
 * sandbox microVMs. Live state is in memory; the only durable artefact is
 * the client-key-encrypted session journal (§5.7). See agentd/README.md.
 */
async function main(): Promise<void> {
  const config = loadConfig()
  const driver = new SbxDriver(config.sbxSocket, config.expectedApiVersion, config.templateImage)
  const manager = new SessionManager(config, driver)

  const health = await driver.health()
  log("info", "driver probe", {
    driver: health.driver,
    ok: health.ok,
    apiVersion: health.apiVersion,
    apiVersionOk: health.apiVersionOk,
    templatePresent: health.templatePresent,
  })
  if (health.apiVersionOk === false)
    log("warn", "sandboxd api_version differs from the pinned version — new sessions will be refused (§12)", {
      got: health.apiVersion,
      expected: config.expectedApiVersion,
    })

  await manager.reconcile()

  const app = buildServer(config, manager, driver)
  await app.listen({ host: config.host, port: config.port })
  log("info", "kiln-agentd listening", { host: config.host, port: config.port })

  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    log("info", "shutting down", { signal })
    try {
      // checkpoint + destroy sandboxes so nothing outlives the process
      await manager.shutdown()
      await app.close()
    } catch (e) {
      log("error", "shutdown error", { err: errClass(e) })
    }
    process.exit(0)
  }
  process.on("SIGTERM", () => void shutdown("SIGTERM"))
  process.on("SIGINT", () => void shutdown("SIGINT"))
}

main().catch((e) => {
  log("error", "fatal", { err: errClass(e) })
  process.exit(1)
})
