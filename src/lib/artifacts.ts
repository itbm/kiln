import { parseQuestionsInner, type QuestionsBlock } from "./questions"
import { BARE_EMOTION_RE, PIP_EMOTIONS } from "./emotions"

export type ArtifactType =
  | "text/markdown"
  | "text/html"
  | "application/code"
  | "image/svg+xml"

export interface ArtifactBlock {
  id: string
  type: ArtifactType
  title: string
  language?: string
  content: string
  complete: boolean
}

export type ContentSegment =
  | { kind: "text"; text: string }
  | { kind: "artifact"; artifact: ArtifactBlock }
  | { kind: "questions"; block: QuestionsBlock }

const OPEN_RE = /<artifact\s+([^>]*?)>/
const FULL_RE = /<artifact\s+([^>]*?)>\r?\n?([\s\S]*?)\r?\n?<\/artifact>/
const Q_OPEN_RE = /<questions>/
const Q_FULL_RE = /<questions>\s*([\s\S]*?)\s*<\/questions>/
/* hidden mood tags (see lib/emotions.ts) — consumed, never rendered */
const E_OPEN_RE = /<emotion>/i
const E_FULL_RE = /<emotion>[^<]*<\/emotion>\s*/i

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  for (const m of raw.matchAll(/([\w-]+)\s*=\s*"([^"]*)"/g)) attrs[m[1]] = m[2]
  return attrs
}

function normalizeType(t: string | undefined): ArtifactType {
  switch (t) {
    case "text/html":
      return "text/html"
    case "image/svg+xml":
      return "image/svg+xml"
    case "application/code":
      return "application/code"
    default:
      return "text/markdown"
  }
}

function makeBlock(
  attrRaw: string,
  content: string,
  complete: boolean,
  index: number,
): ArtifactBlock {
  const attrs = parseAttrs(attrRaw)
  return {
    id: attrs.identifier || `artifact-${index}`,
    type: normalizeType(attrs.type),
    title: attrs.title || "Untitled",
    language: attrs.language,
    content,
    complete,
  }
}

/**
 * Split raw assistant text into text/artifact/questions segments. Hidden
 * emotion tags are consumed without producing a segment. Robust to a
 * partially streamed block at the tail. The earliest tag in the remaining
 * text always wins, so a tag nested inside an earlier block stays part of
 * that block's content.
 */
export function splitContent(raw: string): ContentSegment[] {
  const segments: ContentSegment[] = []
  const pushText = (t: string) => {
    if (t.trim()) segments.push({ kind: "text", text: t })
  }
  let rest = raw
  let index = 0

  /* Bare-mood dialect ("<thoughtful>" instead of the <emotion> wrapper):
     consume any such tags opening the reply, plus a closing twin of the
     same mood at the very end. findEmotion honours the same head form, so
     Pip still gets the mood. */
  let headMood: string | null = null
  let bare = BARE_EMOTION_RE.exec(rest)
  while (bare) {
    headMood ??= bare[1].toLowerCase()
    rest = rest.slice(bare[0].length)
    bare = BARE_EMOTION_RE.exec(rest)
  }
  if (headMood)
    rest = rest.replace(
      new RegExp(`\\s*<\\s*/\\s*${headMood}\\s*>\\s*$`, "i"),
      "",
    )

  while (rest) {
    const fullA = FULL_RE.exec(rest)
    const fullQ = Q_FULL_RE.exec(rest)
    const fullE = E_FULL_RE.exec(rest)
    const openA = OPEN_RE.exec(rest)
    const openQ = Q_OPEN_RE.exec(rest)
    const openE = E_OPEN_RE.exec(rest)
    const at = (m: RegExpExecArray | null) => (m ? m.index : Infinity)
    const first = Math.min(
      at(fullA),
      at(fullQ),
      at(fullE),
      at(openA),
      at(openQ),
      at(openE),
    )

    // Complete blocks first (a full tag shares its index with its open tag)
    if (fullA && first === fullA.index) {
      pushText(rest.slice(0, fullA.index))
      segments.push({
        kind: "artifact",
        artifact: makeBlock(fullA[1], fullA[2], true, index++),
      })
      rest = rest.slice(fullA.index + fullA[0].length)
      continue
    }
    if (fullQ && first === fullQ.index) {
      pushText(rest.slice(0, fullQ.index))
      segments.push({
        kind: "questions",
        block: { questions: parseQuestionsInner(fullQ[1]), complete: true },
      })
      rest = rest.slice(fullQ.index + fullQ[0].length)
      continue
    }
    if (fullE && first === fullE.index) {
      pushText(rest.slice(0, fullE.index))
      rest = rest.slice(fullE.index + fullE[0].length)
      continue
    }

    // Unclosed but fully-opened blocks (still streaming)
    if (openA && first === openA.index) {
      pushText(rest.slice(0, openA.index))
      const partial = rest.slice(openA.index + openA[0].length)
      // Hide a trailing partial "</artifact" close tag while it streams in
      const content = partial.replace(/\r?\n?<\/?a?r?t?i?f?a?c?t?>?\s*$/, "")
      segments.push({
        kind: "artifact",
        artifact: makeBlock(openA[1], content, false, index++),
      })
      return segments
    }
    if (openQ && first === openQ.index) {
      pushText(rest.slice(0, openQ.index))
      const inner = rest.slice(openQ.index + openQ[0].length)
      segments.push({
        kind: "questions",
        block: { questions: parseQuestionsInner(inner), complete: false },
      })
      return segments
    }
    if (openE && first === openE.index) {
      // Emotion value still streaming — keep it hidden
      pushText(rest.slice(0, openE.index))
      return segments
    }

    // Hide a partially streamed tag at the very end ("<artif", "</quest"…)
    const lt = rest.lastIndexOf("<")
    if (lt >= 0 && !rest.slice(lt).includes(">")) {
      const after = rest.slice(lt + 1)
      const tail = after
        .replace(/^\//, "")
        .split(/[\s=]/)[0]
        .toLowerCase()
      /* a bare mood tag may be being born too: at the head of the reply,
         or its closing twin once a head mood was seen */
      const moodTag =
        segments.length === 0 && !rest.slice(0, lt).trim()
          ? PIP_EMOTIONS.some((e) => e.startsWith(tail))
          : headMood !== null &&
            after.startsWith("/") &&
            headMood.startsWith(tail)
      // a bare trailing "<" may be a tag being born; "< 3" is just maths
      if (
        (after === "" || tail !== "") &&
        ((tail.length <= 9 &&
          ("artifact".startsWith(tail) ||
            "questions".startsWith(tail) ||
            "emotion".startsWith(tail))) ||
          moodTag)
      ) {
        pushText(rest.slice(0, lt))
        return segments
      }
    }
    pushText(rest)
    return segments
  }
  return segments
}

export function extractArtifacts(raw: string): ArtifactBlock[] {
  return splitContent(raw)
    .filter((s): s is Extract<ContentSegment, { kind: "artifact" }> => s.kind === "artifact")
    .map((s) => s.artifact)
}

/** Content with artifact/question bodies removed (titles, compaction, previews). */
export function contentWithoutArtifacts(raw: string): string {
  return splitContent(raw)
    .map((s) =>
      s.kind === "text"
        ? s.text
        : s.kind === "artifact"
          ? `[Artifact: ${s.artifact.title}]`
          : `[Asked the user ${s.block.questions.length} question${s.block.questions.length === 1 ? "" : "s"}]`,
    )
    .join("\n")
    .trim()
}

export function artifactExtension(a: ArtifactBlock): string {
  switch (a.type) {
    case "text/html":
      return "html"
    case "image/svg+xml":
      return "svg"
    case "application/code": {
      const map: Record<string, string> = {
        python: "py",
        javascript: "js",
        typescript: "ts",
        tsx: "tsx",
        jsx: "jsx",
        rust: "rs",
        ruby: "rb",
        kotlin: "kt",
        csharp: "cs",
        "c++": "cpp",
        shell: "sh",
        bash: "sh",
      }
      const lang = (a.language ?? "").toLowerCase()
      return map[lang] ?? (lang || "txt")
    }
    default:
      return "md"
  }
}
