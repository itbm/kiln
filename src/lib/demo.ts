// Demo seed: visit /?seed=1 to populate the app with sample data so you can
// explore the UI without API keys. Safe to run repeatedly (idempotent-ish).
import { db } from "./db"
import type { Chat, Message, ModelInfo } from "./types"
import { uid } from "./utils"

const now = Date.now()
const H = 3_600_000

const OR = (
  id: string,
  name: string,
  ctx: number,
  opts: Partial<ModelInfo> = {},
): ModelInfo => ({ id, name, provider: "openrouter", ctx, tools: true, ...opts })

const OL = (
  id: string,
  ctx: number,
  opts: Partial<ModelInfo> = {},
): ModelInfo => ({ id, name: id, provider: "ollama", ctx, tools: true, ...opts })

// Demo catalogue sticks to open models available on Ollama cloud (mirrored
// on OpenRouter where sensible) so screenshots and the seeded UI stay
// provider-neutral.
const MODELS: { openrouter: ModelInfo[]; ollama: ModelInfo[]; fetchedAt: number } = {
  fetchedAt: now,
  openrouter: [
    OR("z-ai/glm-5.2", "GLM-5.2", 200_000, { reasoning: true, reasoningToggle: true, pricing: { prompt: 0.6, completion: 2.2 } }),
    OR("deepseek/deepseek-v3.2", "DeepSeek V3.2", 163_840, { reasoning: true, reasoningToggle: true, pricing: { prompt: 0.27, completion: 1 } }),
    OR("openai/gpt-oss-120b", "gpt-oss 120B", 131_072, { reasoning: true, efforts: ["high", "medium", "low"], defaultEffort: "medium", pricing: { prompt: 0.09, completion: 0.45 } }),
    OR("qwen/qwen3.5-397b", "Qwen3.5 397B", 262_144, { reasoning: true, reasoningToggle: true, pricing: { prompt: 0.4, completion: 1.6 } }),
    OR("qwen/qwen3-coder", "Qwen3 Coder", 262_144, { pricing: { prompt: 0.22, completion: 0.95 } }),
    OR("moonshotai/kimi-k2.5", "Kimi K2.5", 256_000, { reasoning: true, reasoningToggle: true, pricing: { prompt: 0.55, completion: 2.2 } }),
    OR("mistralai/mistral-large-3", "Mistral Large 3", 262_144, { vision: true, pricing: { prompt: 2, completion: 6 } }),
    OR("meta-llama/llama-4-maverick", "Llama 4 Maverick", 1_048_576, { vision: true, pricing: { prompt: 0.15, completion: 0.6 } }),
    OR("qwen/qwen-image", "Qwen Image", 32_768, { imageOutput: true, pricing: { prompt: 0.3, completion: 2.5 } }),
  ],
  ollama: [
    OL("glm-5.2", 200_000, { reasoning: true, reasoningToggle: true }),
    OL("glm-4.7", 200_000, { reasoning: true, reasoningToggle: true }),
    OL("gpt-oss:120b", 131_072, { reasoning: true, efforts: ["high", "medium", "low"], defaultEffort: "medium" }),
    OL("gpt-oss:20b", 131_072, { reasoning: true, efforts: ["high", "medium", "low"], defaultEffort: "medium" }),
    OL("deepseek-v3.2", 163_840, { reasoning: true, reasoningToggle: true }),
    OL("qwen3-coder:480b", 262_144),
    OL("kimi-k2.5", 256_000, { reasoning: true, reasoningToggle: true }),
    OL("gemma4:31b", 131_072, { vision: true }),
    OL("minimax-m3", 196_608, { reasoning: true, reasoningToggle: true }),
  ],
}

function paintDemoImage(hueA: number, hueB: number, label: string): string {
  const c = document.createElement("canvas")
  c.width = c.height = 640
  const ctx = c.getContext("2d")!
  const g = ctx.createLinearGradient(0, 0, 640, 640)
  g.addColorStop(0, `hsl(${hueA} 60% 62%)`)
  g.addColorStop(1, `hsl(${hueB} 55% 30%)`)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 640, 640)
  ctx.fillStyle = "rgba(255,246,235,0.92)"
  ctx.beginPath()
  ctx.arc(480, 150, 60, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = "rgba(20,16,12,0.55)"
  for (let i = 0; i < 7; i++) {
    const w = 40 + ((i * 53) % 90)
    ctx.fillRect(30 + i * 90, 640 - 140 - ((i * 37) % 120), w, 400)
  }
  ctx.fillStyle = "rgba(255,255,255,0.85)"
  ctx.font = "500 28px system-ui"
  ctx.fillText(label, 28, 600)
  return c.toDataURL("image/jpeg", 0.85)
}

export async function seedDemo(): Promise<void> {
  const { useSettings } = await import("@/stores/settings")

  // Demo keys so the app shows the normal chat UI instead of first-run
  // onboarding (persist middleware writes these to localStorage for us).
  const st = useSettings.getState()
  useSettings.setState({
    openrouterKey: st.openrouterKey || "sk-or-demo-not-a-real-key",
    ollamaKey: st.ollamaKey || "demo-not-a-real-key",
    lastModel: { provider: "ollama", model: "glm-5.2" },
    lastImageModel: { provider: "openrouter", model: "qwen/qwen-image" },
    favoriteModels: [
      "ollama:glm-5.2",
      "ollama:gpt-oss:120b",
      "ollama:qwen3-coder:480b",
    ],
    skills: st.skills.length
      ? st.skills
      : [
          {
            id: uid(),
            name: "Recipe formatter",
            description: "Structured recipes with metric units",
            instructions:
              "When sharing recipes: metric units, prep/cook time up top, ingredients as a checklist, then numbered steps.",
            enabled: false,
          },
          {
            id: uid(),
            name: "Code reviewer",
            description: "Terse, actionable code review style",
            instructions:
              "Review code tersely: list issues by severity, suggest concrete fixes, no praise padding.",
            enabled: false,
          },
        ],
  })

  // Model cache signature must match the (now keyed) settings, or the next
  // refresh would wipe the demo catalogue.
  const { useModels, modelsSignature } = await import("@/stores/models")
  const cache = { ...MODELS, signature: modelsSignature(), v: 2 }
  localStorage.setItem("amber-models-cache", JSON.stringify(cache))
  useModels.setState(cache)

  if ((await db.chats.count()) > 0) return

  const mk = (
    chat: Partial<Chat> & { id: string; title: string },
    msgs: Array<Partial<Message> & { role: Message["role"]; content: string }>,
  ) => {
    const c: Chat = {
      kind: "chat",
      createdAt: now - 5 * H,
      updatedAt: now - 5 * H,
      titleGenerated: true,
      provider: "ollama",
      model: "glm-5.2",
      effort: "auto",
      ...chat,
    } as Chat
    const list: Message[] = msgs.map((m, i) => ({
      id: uid(),
      chatId: c.id,
      status: "done",
      createdAt: c.createdAt + i * 60_000,
      provider: m.role === "assistant" ? (m.provider ?? c.provider) : undefined,
      model: m.role === "assistant" ? (m.model ?? c.model) : undefined,
      ...m,
    })) as Message[]
    return { c, list }
  }

  const kyoto = mk(
    {
      id: "demo-kyoto",
      title: "Kyoto in October: 5-day plan",
      updatedAt: now - 0.4 * H,
      createdAt: now - 0.6 * H,
    },
    [
      {
        role: "user",
        content:
          "I'm visiting Kyoto for 5 days in late October. Plan the trip — I love temples, food markets and quiet neighbourhoods, and I'd rather walk than take taxis.",
      },
      {
        role: "assistant",
        modelName: "glm-5.2",
        effort: "auto",
        versions: [
          {
            content:
              "Here's a quick outline for 5 days: Higashiyama temples, Arashiyama bamboo, a Kurama day-hike, Nishiki market food crawl, and a flexible last day around Fushimi Inari. Want me to expand it into a full plan?",
            provider: "ollama",
            model: "deepseek-v3.2",
            modelName: "deepseek-v3.2",
            effort: "auto",
            status: "done",
            createdAt: now - 0.62 * H,
          },
        ],
        versionIndex: 1,
        reasoning:
          "The user prefers walking, temples, food, quiet areas. Cluster geographically to minimise transit: Higashiyama day, Arashiyama day, north Kyoto (Kurama/Kibune) for autumn colour, downtown market day, and a flexible finale. Late October = early koyo in the hills, comfortable 12–20°C.",
        reasoningMs: 4200,
        content: `Late October is a lovely time — early autumn colour in the hills, mild days around 18°C. Here's a walk-first plan, clustered so each day stays in one area:

## Day-by-day

| Day | Area | Highlights |
| --- | --- | --- |
| 1 | Higashiyama | Kiyomizu-dera at opening (7am, beat the crowds), Sannenzaka lanes, Kōdai-ji, evening in Gion |
| 2 | Arashiyama | Bamboo grove before 8am, Ōkōchi Sansō villa, Togetsukyō bridge, hidden Gio-ji moss temple |
| 3 | North hills | Kurama → Kibune hike (2h, gorgeous maples), riverside kaiseki lunch, onsen before heading back |
| 4 | Downtown | Nishiki Market grazing, knife shopping on Teramachi, Pontochō alley at dusk |
| 5 | Flexible | Fushimi Inari early (6am is magical), then whatever stole your heart |

## Food not to miss
- **Yudōfu** (simmered tofu) near Nanzen-ji — the temple-side restaurants are worth it
- Standing sushi at Nishiki, tamagoyaki straight off the grill
- A proper **matcha** in Uji if you take a half-day detour

Want me to turn this into a printable itinerary with opening hours and walking distances?`,
      },
    ],
  )

  const coffee = mk(
    {
      id: "demo-coffee",
      title: "Coffee shop landing page",
      updatedAt: now - 3 * H,
      createdAt: now - 3.4 * H,
    },
    [
      {
        role: "user",
        content:
          "Make me a simple landing page for my coffee shop “Ember & Oak” — warm colours, hero section, menu highlights, opening hours. Just one file.",
      },
      {
        role: "assistant",
        modelName: "glm-5.2",
        content: `Here's a self-contained landing page with a warm palette and everything inline:

<artifact identifier="ember-oak-landing" type="text/html" title="Ember & Oak — Landing page">
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ember &amp; Oak</title>
<style>
  :root{--bg:#faf6f0;--ink:#2b211a;--ember:#c96442;--oak:#8a5a3b}
  *{margin:0;box-sizing:border-box}
  body{font-family:Georgia,serif;background:var(--bg);color:var(--ink)}
  header{padding:12vh 8vw;background:linear-gradient(160deg,#f3e3d3,#e8c9ae)}
  h1{font-size:clamp(2.4rem,7vw,4rem)}
  .tag{font-style:italic;color:var(--oak);margin-top:.6rem}
  .cta{display:inline-block;margin-top:1.6rem;background:var(--ember);color:#fff;
       padding:.8rem 1.6rem;border-radius:999px;text-decoration:none}
  section{padding:9vh 8vw}
  .menu{display:grid;gap:1rem;grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}
  .card{background:#fff;border-radius:18px;padding:1.2rem;box-shadow:0 4px 14px #0001}
  .price{float:right;color:var(--ember)}
  footer{padding:6vh 8vw;background:var(--ink);color:#f5ead9}
</style>
</head>
<body>
<header>
  <h1>Ember &amp; Oak</h1>
  <p class="tag">Slow-roasted coffee, baked mornings, warm rooms.</p>
  <a class="cta" href="#menu">See the menu</a>
</header>
<section id="menu">
  <h2>House favourites</h2><br>
  <div class="menu">
    <div class="card"><h3>Flat White <span class="price">£3.6</span></h3><p>Velvety double ristretto, oat by default.</p></div>
    <div class="card"><h3>Maple Cardamom Bun <span class="price">£4.2</span></h3><p>Baked 7am &amp; 11am, gone by noon.</p></div>
    <div class="card"><h3>Pour-over — Huila <span class="price">£4.8</span></h3><p>Washed Colombian, stone fruit &amp; honey.</p></div>
  </div>
</section>
<footer>
  <h3>Find us</h3>
  <p>14 Alder Lane · Mon–Fri 7–17 · Sat–Sun 8–18</p>
</footer>
</body>
</html>
</artifact>

The palette leans on ember-orange against oak browns. Tap the card to preview it — want a booking section or a map embed next?`,
      },
    ],
  )

  const script = mk(
    {
      id: "demo-owid",
      title: "CSV cleanup one-liner",
      updatedAt: now - 26 * H,
      createdAt: now - 26.2 * H,
      provider: "ollama",
      model: "gpt-oss:120b",
      effort: "high",
      summary:
        "- User is cleaning sales.csv: mixed US/ISO dates, £/$ symbols in amount column\n- Wants pandas; prefers concise answers",
      summaryCutoff: now - 26.2 * H,
    },
    [
      {
        role: "user",
        content:
          "I have sales.csv with mixed date formats (US and ISO) and £/$ symbols in the amount column. Give me a pandas script to normalise it.",
      },
      {
        role: "assistant",
        modelName: "gpt-oss:120b",
        provider: "ollama",
        model: "gpt-oss:120b",
        effort: "high",
        reasoning:
          "Mixed date formats: pandas to_datetime with format='mixed' handles US vs ISO if dayfirst is consistent... safer to try ISO first then fall back. Currency: strip symbols and thousands separators, cast to float, keep a currency column from the symbol.",
        reasoningMs: 11800,
        content: `Here's a script that handles both problems and keeps the original currency:

<artifact identifier="clean-sales-csv" type="application/code" language="python" title="clean_sales.py">
import pandas as pd

df = pd.read_csv("sales.csv")

# --- dates: ISO (2025-10-31) and US (10/31/2025) mixed ---
df["date"] = pd.to_datetime(df["date"], format="mixed", dayfirst=False)

# --- amounts: "£1,234.50" / "$99" -> float + currency column ---
amt = df["amount"].astype(str).str.strip()
df["currency"] = amt.str[0].map({"£": "GBP", "$": "USD"}).fillna("USD")
df["amount"] = (
    amt.str.replace(r"[^0-9.\\-]", "", regex=True)
       .replace("", pd.NA)
       .astype("Float64")
)

df = df.dropna(subset=["amount"]).sort_values("date")
df.to_csv("sales_clean.csv", index=False)
print(df.dtypes, "\\n", df.head())
</artifact>

Two things to check on your data: if any dates are day-first (UK style \`31/10/2025\`), flip \`dayfirst=True\`; and if you have other currencies, extend the symbol map.`,
      },
    ],
  )

  const quiz = mk(
    {
      id: "demo-quiz",
      title: "Start a self-hosted blog",
      updatedAt: now - 1.2 * H,
      createdAt: now - 1.3 * H,
    },
    [
      {
        role: "user",
        content: "I want to start a self-hosted blog. Help me pick the stack.",
      },
      {
        role: "assistant",
        modelName: "glm-5.2",
        content: `Happy to help — two choices shape everything else, so let me ask first:

<questions>
<question text="Which platform appeals most?">
<option>Ghost (polished, batteries included)</option>
<option>WordPress (endless plugins)</option>
<option>Hugo static site (fast, no server)</option>
</question>
<question text="How do you want to write posts?">
<option>Web editor in the browser</option>
<option>Markdown files in git</option>
</question>
</questions>`,
      },
    ],
  )

  const images: { c: Chat; list: Message[] } = {
    c: {
      id: "demo-images",
      kind: "image",
      title: "Neon alley at dusk",
      createdAt: now - 8 * H,
      updatedAt: now - 8 * H,
      provider: "openrouter",
      model: "qwen/qwen-image",
    },
    list: [
      {
        id: uid(),
        chatId: "demo-images",
        role: "user",
        content: "A rainy neon alley at dusk, cinematic, reflections on wet pavement",
        status: "done",
        createdAt: now - 8 * H,
      },
      {
        id: uid(),
        chatId: "demo-images",
        role: "assistant",
        content: "",
        modelName: "Qwen Image",
        provider: "openrouter",
        model: "qwen/qwen-image",
        images: [
          { id: uid(), dataUrl: paintDemoImage(275, 210, "demo render") },
          { id: uid(), dataUrl: paintDemoImage(15, 320, "demo render") },
        ],
        status: "done",
        createdAt: now - 8 * H + 30_000,
      },
    ],
  }

  await db.transaction("rw", db.chats, db.messages, async () => {
    for (const { c, list } of [kyoto, coffee, script, quiz, images]) {
      await db.chats.put(c)
      await db.messages.bulkPut(list)
    }
  })
}
