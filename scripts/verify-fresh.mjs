// Proves default app state and key-gated model fetching, in two phases:
//   1) brand-new profile, NO key: empty DB, no chats, and NO provider
//      requests at all — the model list stays empty with a key hint.
//   2) new profile WITH an OpenRouter key stored: the picker populates from
//      a LIVE fetch of the real OpenRouter /models API.
// The sandbox's egress proxy blocks Chromium's CONNECT tunnels (but not Node
// clients), so provider calls are relayed through Playwright's Node request
// context — still fetched live from the real API at run time.
import { chromium, request as pwRequest } from "playwright"
import { mkdirSync } from "node:fs"

mkdirSync("shots", { recursive: true })
const BASE = "http://localhost:4173"

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium",
})
const api = await pwRequest.newContext({
  proxy: process.env.HTTPS_PROXY
    ? { server: process.env.HTTPS_PROXY }
    : undefined,
  ignoreHTTPSErrors: true,
})

async function newPage(withKey) {
  const ctx = await browser.newContext({
    viewport: { width: 393, height: 852 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  })
  const page = await ctx.newPage()
  if (withKey) {
    await page.addInitScript(() => {
      localStorage.setItem(
        "amber-settings",
        JSON.stringify({
          version: 0,
          state: { openrouterKey: "sk-or-set-but-not-needed-for-model-list" },
        }),
      )
    })
  }
  const orRequests = []
  await page.route("**/openrouter.ai/**", async (route) => {
    orRequests.push(route.request().url())
    const res = await api.get(route.request().url(), { timeout: 30000 })
    await route.fulfill({
      status: res.status(),
      contentType: res.headers()["content-type"] ?? "application/json",
      body: await res.body(),
    })
  })
  return { ctx, page, orRequests }
}

const dumpState = (page) =>
  page.evaluate(async () => {
    const req = indexedDB.open("amber")
    const idb = await new Promise((res, rej) => {
      req.onsuccess = () => res(req.result)
      req.onerror = () => rej(req.error)
    })
    const count = (store) =>
      new Promise((res) => {
        try {
          const r = idb
            .transaction(store, "readonly")
            .objectStore(store)
            .count()
          r.onsuccess = () => res(r.result)
          r.onerror = () => res("err")
        } catch {
          res("missing")
        }
      })
    const settings = JSON.parse(
      localStorage.getItem("amber-settings") ?? "{}",
    ).state
    const cache = JSON.parse(localStorage.getItem("amber-models-cache") ?? "null")
    return {
      chats: await count("chats"),
      messages: await count("messages"),
      keysStored: {
        openrouter: !!settings?.openrouterKey,
        ollama: !!settings?.ollamaKey,
        tavily: !!settings?.tavilyKey,
      },
      skills: settings?.skills?.length ?? 0,
      cachedModels: cache
        ? { openrouter: cache.openrouter.length, ollama: cache.ollama.length }
        : null,
    }
  })

// ---------- phase 1: no key → first-run welcome ----------
{
  const { ctx, page, orRequests } = await newPage(false)
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" })
  await page.waitForTimeout(1500)
  console.log("PHASE 1 (no key) boot state:", JSON.stringify(await dumpState(page)))
  await page.getByText("Welcome to Kiln").waitFor({ timeout: 5000 })
  console.log("welcome screen shown:", true)
  console.log(
    "composer hidden without keys:",
    (await page.getByPlaceholder("Message Kiln…").count()) === 0,
  )
  await page.screenshot({ path: "shots/v1-welcome-nokeys.png" })
  await page.getByLabel("Open menu").click()
  await page.waitForTimeout(400)
  console.log("sidebar empty-state visible:", (await page.getByText("No chats yet").count()) > 0)
  await page.keyboard.press("Escape")
  await page.waitForTimeout(300)
  // the CTA leads to settings
  await page.getByRole("button", { name: "Add API keys" }).click()
  await page.getByText("Providers").waitFor({ timeout: 5000 })
  console.log("CTA navigates to settings:", true)
  console.log("provider requests made WITHOUT a key:", orRequests.length, orRequests)
  await ctx.close()
}

// ---------- phase 2: OpenRouter key stored ----------
{
  const { ctx, page, orRequests } = await newPage(true)
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" })
  await page.getByText("Choose model").click()
  await page.waitForTimeout(5000)
  await page.screenshot({ path: "shots/v2-key-live-models.png" })
  const live = await page.evaluate(() => {
    const cache = JSON.parse(localStorage.getItem("amber-models-cache") ?? "{}")
    const or = cache.openrouter ?? []
    return { count: or.length, sample: or.slice(0, 5).map((m) => m.id) }
  })
  console.log("PHASE 2 (key set) live models:", JSON.stringify(live))
  console.log("provider requests made WITH a key:", orRequests)
  await page.getByPlaceholder("Search models…").fill("claude")
  await page.waitForTimeout(600)
  await page.screenshot({ path: "shots/v3-key-live-search.png" })
  await ctx.close()
}

// ---------- phase 3: an existing install upgrades without losing chats ----------
// The Dexie schema gained a `drafts` store (db v2 → IDB version 20). Every
// existing install is on the v1 schema (IDB version 10), so this seeds a
// database exactly as Dexie left it there and checks the upgrade is additive.
{
  const { ctx, page } = await newPage(true)
  await page.addInitScript(() => {
    const open = indexedDB.open("amber", 10) // Dexie multiplies its version by 10
    open.onupgradeneeded = () => {
      const idb = open.result
      const chats = idb.createObjectStore("chats", { keyPath: "id" })
      chats.createIndex("updatedAt", "updatedAt")
      chats.createIndex("kind", "kind")
      const messages = idb.createObjectStore("messages", { keyPath: "id" })
      messages.createIndex("chatId", "chatId")
      messages.createIndex("createdAt", "createdAt")
    }
    window.__seeded = new Promise((res, rej) => {
      open.onerror = () => rej(open.error)
      open.onsuccess = () => {
        const idb = open.result
        const tx = idb.transaction(["chats", "messages"], "readwrite")
        tx.objectStore("chats").put({
          id: "legacy-1",
          kind: "chat",
          title: "Chat from before the upgrade",
          createdAt: 1_700_000_000_000,
          updatedAt: 1_700_000_000_000,
        })
        tx.objectStore("messages").put({
          id: "legacy-msg-1",
          chatId: "legacy-1",
          role: "user",
          content: "Words written on the old schema",
          status: "done",
          createdAt: 1_700_000_000_000,
        })
        tx.oncomplete = () => {
          idb.close()
          res(true)
        }
        tx.onerror = () => rej(tx.error)
      }
    })
  })
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" })
  await page.waitForTimeout(1500)
  // the pre-existing chat is still listed…
  await page.getByLabel("Open menu").click()
  const legacyVisible =
    (await page.getByText("Chat from before the upgrade").count()) > 0
  console.log("legacy chat survives the schema upgrade:", legacyVisible)
  await page.keyboard.press("Escape")
  await page.waitForTimeout(400)
  // …and the message with it, alongside the new drafts store
  const after = await page.evaluate(async () => {
    const req = indexedDB.open("amber")
    const idb = await new Promise((res, rej) => {
      req.onsuccess = () => res(req.result)
      req.onerror = () => rej(req.error)
    })
    const count = (store) =>
      new Promise((res) => {
        try {
          const r = idb.transaction(store, "readonly").objectStore(store).count()
          r.onsuccess = () => res(r.result)
          r.onerror = () => res("err")
        } catch {
          res("missing")
        }
      })
    return {
      version: idb.version,
      stores: [...idb.objectStoreNames],
      chats: await count("chats"),
      messages: await count("messages"),
      drafts: await count("drafts"),
    }
  })
  console.log("PHASE 3 after upgrade:", JSON.stringify(after))
  // typing still lands on disk on the upgraded database
  await page.getByPlaceholder("Message Kiln…").fill("draft on an upgraded db")
  await page.waitForTimeout(1600)
  const drafted = await page.evaluate(async () => {
    const req = indexedDB.open("amber")
    const idb = await new Promise((res) => (req.onsuccess = () => res(req.result)))
    const all = await new Promise((res) => {
      const r = idb.transaction("drafts", "readonly").objectStore("drafts").getAll()
      r.onsuccess = () => res(r.result)
    })
    return all.map((d) => d.text)
  })
  console.log("draft written on the upgraded database:", JSON.stringify(drafted))
  if (
    !legacyVisible ||
    after.chats !== 1 ||
    after.messages !== 1 ||
    after.version !== 20 ||
    !after.stores.includes("drafts") ||
    drafted[0] !== "draft on an upgraded db"
  ) {
    console.error("ASSERT FAIL: v1 → v2 schema upgrade did not preserve data")
    process.exitCode = 1
  }
  await ctx.close()
}

await api.dispose()
await browser.close()
console.log(process.exitCode ? "VERIFY FAILED" : "VERIFY DONE")
