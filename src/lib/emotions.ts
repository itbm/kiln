/**
 * Hidden mood tags: the model opens each reply with one, Pip acts on it.
 *
 *   <emotion>sad</emotion>
 *
 * The tag protocol lives alongside artifacts/questions: it is requested via
 * the system prompt (only while Pip is actually on stage — see
 * buildSystemPrompt), parsed out of the stream as it arrives
 * (lib/engine.ts → pip.emote), and never rendered (splitContent drops it).
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

/**
 * First complete emotion tag in the text, if any. An unknown value still
 * returns "neutral" — the model spoke the protocol, just not our dialect.
 */
export function findEmotion(content: string): PipEmotion | null {
  const m = E_RE.exec(content)
  if (!m) return null
  const v = m[1].trim().toLowerCase()
  return (PIP_EMOTIONS as readonly string[]).includes(v)
    ? (v as PipEmotion)
    : "neutral"
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

Read the tone of the moment — mostly the user's last message: happy for warm or pleasant turns; excited for great news, wins or launches; thoughtful for deep or reflective topics; worried when the user faces a risk or problem; sad for mildly sad moments; crying only for genuinely heartbreaking ones; surprised for astonishing turns; angry for outrageous or unfair situations (never at the user); neutral otherwise. The tag is stripped before display and invisible to the user: never mention it, never explain it, and never place it anywhere except the very start of the reply.`
