/**
 * Hidden mood tags: the model opens each reply with one, Pip acts on it.
 *
 *   <emotion>sad</emotion>
 *
 * The tag protocol lives alongside artifacts/questions: it is requested via
 * the system prompt (only while Pip is actually on stage — see
 * buildSystemPrompt), parsed out of the stream as it arrives
 * (lib/engine.ts → pip.emote), and never rendered (splitContent drops it).
 *
 * Some models drift into a dialect and emit the mood as its own bare tag
 * ("<thoughtful>") instead of the wrapper. Both parsers tolerate that form
 * at the start of the reply — Pip still reacts and nothing leaks on screen.
 */

export const PIP_EMOTIONS = [
  "neutral",
  "happy",
  "excited",
  "thoughtful",
  "worried",
  "sad",
  "crying",
  "surprised",
  "angry",
] as const

export type PipEmotion = (typeof PIP_EMOTIONS)[number]

const E_RE = /<emotion>\s*([^<]*?)\s*<\/emotion>/i

/* The bare-tag dialect: "<thoughtful>", "</thoughtful>", "<thoughtful/>".
   Anchored to the start of the reply — where the real tag belongs — so a
   mood word inside quoted markup deeper in the text is never eaten. */
export const BARE_EMOTION_RE = new RegExp(
  `^\\s*<\\s*/?\\s*(${PIP_EMOTIONS.join("|")})\\s*/?\\s*>\\s*`,
  "i",
)

/**
 * First complete emotion tag in the text, if any. An unknown value still
 * returns "neutral" — the model spoke the protocol, just not our dialect.
 * A bare mood tag opening the reply counts too.
 */
export function findEmotion(content: string): PipEmotion | null {
  const m = E_RE.exec(content)
  if (m) {
    const v = m[1].trim().toLowerCase()
    return (PIP_EMOTIONS as readonly string[]).includes(v)
      ? (v as PipEmotion)
      : "neutral"
  }
  const bare = BARE_EMOTION_RE.exec(content)
  return bare ? (bare[1].toLowerCase() as PipEmotion) : null
}

/**
 * Appended to the system prompt while Pip is enabled. Deliberately framed
 * as stage direction: one tag, first thing in the reply, never mentioned.
 */
export const EMOTION_PROMPT = `

## Mood tag (hidden stage direction)
The app has a small mascot who reacts to the conversation's emotional tone. Start every reply with exactly one mood tag, before any other text, e.g.:

<emotion>happy</emotion>

Valid moods: neutral, happy, excited, thoughtful, worried, sad, crying, surprised, angry.

Always exactly this shape: a tag named emotion with the mood word inside it. Never write the mood as its own tag — not <thoughtful>, but <emotion>thoughtful</emotion>.

Read the tone of the moment — mostly the user's last message: happy for warm or pleasant turns; excited for great news, wins or launches; thoughtful for deep or reflective topics; worried when the user faces a risk or problem; sad for mildly sad moments; crying only for genuinely heartbreaking ones; surprised for astonishing turns; angry for outrageous or unfair situations (never at the user); neutral otherwise. The tag is stripped before display and invisible to the user: never mention it, never explain it, and never place it anywhere except the very start of the reply.`
