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
            usage: { promptTokens: 396, completionTokens: 58, genMs: 1900 },
          },
        ],
        versionIndex: 1,
        usage: { promptTokens: 412, completionTokens: 642, genMs: 14600 },
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

  const paas = mk(
    {
      id: "demo-strata",
      title: "PaaS landing page",
      updatedAt: now - 3 * H,
      createdAt: now - 3.4 * H,
    },
    [
      {
        role: "user",
        content:
          "Landing page for my cloud platform “Strata” — near-black, one sharp red accent, big confident type, a deploy terminal in the hero, numbered feature grid. One file, no external assets.",
      },
      {
        role: "assistant",
        modelName: "glm-5.2",
        usage: { promptTokens: 388, completionTokens: 2210, genMs: 51_000 },
        content: `Dark canvas, one loud red, and the terminal doing the selling — everything inline:

<artifact identifier="strata-landing" type="text/html" title="Strata — Landing page">
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Strata &mdash; ship on your terms</title>
<style>
  :root{--bg:#0a0a0c;--card:#101014;--ink:#ededf0;--mut:#8f8f99;--line:#ffffff14;
    --red:#ff2d20;--red-2:#ff7433;--green:#3fdf8f;--amber:#ffd166;
    --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace}
  *{margin:0;box-sizing:border-box}
  body{background:var(--bg);color:var(--ink);line-height:1.6;
    font-family:system-ui,-apple-system,"Segoe UI",Roboto,Ubuntu,sans-serif;
    background-image:radial-gradient(85% 42% at 50% -6%,rgba(255,45,32,.17),transparent 64%)}
  .wrap{max-width:660px;margin:0 auto;padding:0 22px}
  a{text-decoration:none;color:inherit}
  nav{display:flex;align-items:center;gap:16px;padding:16px 22px}
  .logo{display:flex;align-items:center;gap:9px;font-weight:800;font-size:17px;letter-spacing:-.02em}
  .mark{width:22px;height:22px;border-radius:6px;flex:none;
    background:conic-gradient(from 210deg,var(--red),var(--red-2),var(--red));
    box-shadow:0 0 18px rgba(255,45,32,.55)}
  nav a.lnk{color:var(--mut);font-size:13.5px}
  .navcta{margin-left:auto;font-size:13px;font-weight:600;
    border:1px solid var(--line);border-radius:999px;padding:7px 15px}
  header{padding:44px 0 26px}
  .pill{display:inline-flex;align-items:center;gap:8px;font-size:12px;color:#ffb3a8;
    border:1px solid rgba(255,45,32,.35);border-radius:999px;padding:5px 12px;
    background:rgba(255,45,32,.08)}
  .pill i{width:6px;height:6px;border-radius:50%;background:var(--green)}
  h1{font-size:clamp(2.35rem,10.5vw,3.4rem);line-height:1.05;letter-spacing:-.035em;
    font-weight:800;margin:18px 0 14px}
  h1 span{background:linear-gradient(100deg,var(--red),var(--red-2));
    -webkit-background-clip:text;background-clip:text;color:transparent}
  .sub{color:var(--mut);font-size:1.02rem;max-width:36ch}
  .ctas{display:flex;gap:10px;flex-wrap:wrap;margin-top:24px}
  .btn{font-size:14px;font-weight:700;border-radius:10px;padding:12px 22px;
    background:var(--red);color:#fff;box-shadow:0 10px 30px -10px rgba(255,45,32,.7)}
  .ghost{font-size:14px;font-weight:600;border-radius:10px;padding:12px 20px;
    border:1px solid var(--line);color:var(--ink);font-family:var(--mono)}
  .term{margin:34px 0 6px;border:1px solid var(--line);border-radius:14px;
    background:#0d0d11;overflow:hidden;
    box-shadow:0 40px 80px -40px rgba(255,45,32,.35),0 30px 60px -30px rgba(0,0,0,.8)}
  .tbar{display:flex;align-items:center;gap:6px;padding:11px 14px;border-bottom:1px solid var(--line)}
  .tbar i{width:10px;height:10px;border-radius:50%;background:#2c2c33}
  .tbar i:first-child{background:rgba(255,45,32,.6)}
  .tbar b{margin-left:auto;font:500 11px var(--mono);color:var(--mut)}
  .term pre{padding:15px 16px 17px;font:12.5px/1.85 var(--mono);color:#c9c9d2;overflow-x:auto}
  .c{color:var(--mut)}.g{color:var(--green)}.r{color:#ff8a7a}.y{color:var(--amber)}
  section{padding:46px 0 0}
  .eyebrow{font:700 11px var(--mono);letter-spacing:.3em;text-transform:uppercase;color:var(--red-2)}
  h2{font-size:1.65rem;letter-spacing:-.02em;line-height:1.2;font-weight:800;margin:10px 0 22px}
  .grid{display:grid;gap:12px}
  .card{border:1px solid var(--line);border-radius:14px;padding:18px;background:var(--card)}
  .card b{display:block;font-size:15px;margin:10px 0 4px}
  .card p{color:var(--mut);font-size:13.5px}
  .num{font:700 12px var(--mono);color:var(--red)}
  .stats{display:flex;gap:8px;margin-top:40px;text-align:center}
  .stats div{flex:1;border:1px solid var(--line);border-radius:14px;padding:14px 6px;background:var(--card)}
  .stats b{display:block;font-size:19px;letter-spacing:-.02em}
  .stats span{font:500 10.5px var(--mono);color:var(--mut);letter-spacing:.06em}
  .last{margin:52px 0 0;padding:30px 22px 34px;text-align:center;border-top:1px solid var(--line);
    background:radial-gradient(70% 100% at 50% 115%,rgba(255,45,32,.14),transparent 70%)}
  .last h2{margin:0 0 8px}
  .last p{color:var(--mut);font-size:14px;margin-bottom:20px}
  .curl{display:inline-block;margin-top:16px;font:12px var(--mono);color:var(--mut);
    border:1px dashed #ffffff22;border-radius:8px;padding:8px 14px}
  footer{padding:22px;text-align:center;font-size:12.5px;color:#5d5d66}
</style>
</head>
<body>
<nav>
  <a class="logo" href="#"><span class="mark"></span>Strata</a>
  <a class="lnk" href="#why">Docs</a>
  <a class="lnk" href="#why">Pricing</a>
  <a class="navcta" href="#go">Sign in</a>
</nav>
<header class="wrap">
  <p class="pill"><i></i>Now in public beta &middot; free while it lasts</p>
  <h1>Deploy in seconds.<br><span>Scale on cue.</span></h1>
  <p class="sub">Strata is the platform layer your side project graduates to:
  git push, and we handle the servers, certs, queues and 3am pages.</p>
  <div class="ctas"><a class="btn" href="#go">Start deploying</a>
  <a class="ghost" href="#why">strata docs &rarr;</a></div>
  <div class="term">
    <div class="tbar"><i></i><i></i><i></i><b>~/side-project</b></div>
    <pre><span class="c">$</span> strata deploy --prod
<span class="c">&rsaquo;</span> build     <span class="c">........</span> done <span class="c">in</span> <span class="y">8.2s</span>
<span class="c">&rsaquo;</span> postgres  <span class="c">........</span> migrated <span class="c">(4 new)</span>
<span class="c">&rsaquo;</span> rollout   <span class="c">........</span> healthy <span class="c">in 9 regions</span>
<span class="g">&check;</span> live <span class="c">at</span> <span class="r">https://app.strata.dev</span>
  <span class="c">p99 34ms &middot; scaled to zero overnight</span></pre>
  </div>
</header>
<section id="why" class="wrap">
  <p class="eyebrow">The platform</p>
  <h2>Everything between<br>git push and production.</h2>
  <div class="grid">
    <div class="card"><span class="num">01</span>
      <b>Zero-config deploys</b>
      <p>Push to main. Buildpacks detect the stack, build it, and roll out behind health checks.</p></div>
    <div class="card"><span class="num">02</span>
      <b>Batteries: included</b>
      <p>Postgres, Redis and object storage provisioned in one click, backed up nightly.</p></div>
    <div class="card"><span class="num">03</span>
      <b>A URL for every branch</b>
      <p>Each PR gets its own preview environment with a seeded database. Merge, and it&rsquo;s gone.</p></div>
    <div class="card"><span class="num">04</span>
      <b>Scale to zero</b>
      <p>Up on traffic, down to nothing at 3am. You pay for requests, not for idle.</p></div>
  </div>
  <div class="stats">
    <div><b>99.99%</b><span>UPTIME</span></div>
    <div><b>9</b><span>REGIONS</span></div>
    <div><b>34ms</b><span>P99</span></div>
  </div>
</section>
<div class="last" id="go">
  <h2>Live in the next five minutes.</h2>
  <p>No YAML. No sales call. A free Postgres you&rsquo;ll outgrow eventually.</p>
  <a class="btn" href="#">Create your first app</a><br>
  <span class="curl">curl -fsSL get.strata.dev | sh</span>
</div>
<footer>Strata &copy; 2026 &middot; status &middot; changelog &middot; @strata</footer>
</body>
</html>
</artifact>

One red on near-black, the gradient saved for the verb, and the terminal does the actual pitch. Want a pricing table or a dark/light toggle next?`,
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
        usage: { promptTokens: 301, completionTokens: 512, genMs: 9800 },
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
        usage: { promptTokens: 348, completionTokens: 131, genMs: 3200 },
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
        usage: { promptTokens: 24, completionTokens: 2580, cost: 0.0065 },
        status: "done",
        createdAt: now - 8 * H + 30_000,
      },
    ],
  }

  await db.transaction("rw", db.chats, db.messages, async () => {
    for (const { c, list } of [kyoto, paas, script, quiz, images]) {
      await db.chats.put(c)
      await db.messages.bulkPut(list)
    }
  })
}
