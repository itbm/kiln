/**
 * Interactive questions the model can pose at the end of a reply, using a
 * tag protocol like artifacts:
 *
 *   <questions>
 *   <question text="Where will you deploy?">
 *   <option>Docker on a VPS</option>
 *   <option>Fly.io</option>
 *   </question>
 *   </questions>
 *
 * The UI always offers a free-text "Other" answer, so models don't include
 * one. Answers are sent back as a normal user message ("Q — A" lines).
 */

export interface QuestionSpec {
  text: string
  options: string[]
}

export interface QuestionsBlock {
  questions: QuestionSpec[]
  complete: boolean
}

export interface QAnswer {
  question: string
  answer: string
}

const Q_BLOCK = /<questions>\s*([\s\S]*?)\s*<\/questions>/

export function parseQuestionsInner(inner: string): QuestionSpec[] {
  const questions: QuestionSpec[] = []
  for (const qm of inner.matchAll(
    /<question\s+text="([^"]*)"\s*>([\s\S]*?)<\/question>/g,
  )) {
    const options = [...qm[2].matchAll(/<option>([\s\S]*?)<\/option>/g)]
      .map((m) => m[1].trim())
      .filter(Boolean)
    const text = qm[1].trim()
    if (text && options.length) questions.push({ text, options })
  }
  return questions
}

/** First complete questions block in a message, if any. */
export function findQuestions(content: string): QuestionsBlock | null {
  const m = Q_BLOCK.exec(content)
  if (!m) return null
  const questions = parseQuestionsInner(m[1])
  return questions.length ? { questions, complete: true } : null
}

export function formatAnswers(answers: QAnswer[]): string {
  return answers.map((a) => `${a.question} — ${a.answer}`).join("\n")
}
