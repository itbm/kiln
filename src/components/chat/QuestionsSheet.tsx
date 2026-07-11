import { useEffect, useState } from "react"
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  MessageCircleQuestionIcon,
  PencilIcon,
} from "lucide-react"
import {
  Drawer,
  DrawerContent,
  DrawerTitle,
} from "@/components/ui/drawer"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import type { QAnswer, QuestionsBlock, QuestionSpec } from "@/lib/questions"
import { cn } from "@/lib/utils"

const OTHER = "__other__"

/** Card shown inline in the chat where the questions block appears. */
export function QuestionsCard({
  block,
  answered,
  onOpen,
}: {
  block: QuestionsBlock
  answered: boolean
  onOpen: () => void
}) {
  const n = block.questions.length
  if (!block.complete || n === 0) {
    return (
      <div className="my-2 flex w-full max-w-md animate-pulse items-center gap-3 rounded-2xl border border-primary/30 bg-primary/5 p-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
          <MessageCircleQuestionIcon className="size-5" />
        </div>
        <div className="text-[13px] text-muted-foreground">Preparing questions…</div>
      </div>
    )
  }
  return (
    <button
      onClick={onOpen}
      disabled={answered}
      className={cn(
        "my-2 flex w-full max-w-md items-center gap-3 rounded-2xl border p-3 text-left transition",
        answered
          ? "border-border bg-muted/40"
          : "border-primary/40 bg-primary/5 hover:shadow-sm active:scale-[0.99]",
      )}
    >
      <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
        {answered ? (
          <CheckIcon className="size-5" />
        ) : (
          <MessageCircleQuestionIcon className="size-5" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14px] font-medium">
          {n === 1 ? block.questions[0].text : "A few questions for you"}
        </div>
        <div className="text-[12px] text-muted-foreground">
          {answered
            ? "Answered ✓"
            : `${n} question${n === 1 ? "" : "s"} · tap to answer`}
        </div>
      </div>
    </button>
  )
}

function OptionRow({
  label,
  selected,
  onSelect,
}: {
  label: string
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left text-[14px] transition-colors",
        selected
          ? "border-primary bg-primary/8 font-medium"
          : "border-border hover:bg-accent",
      )}
    >
      <span
        className={cn(
          "flex size-4 shrink-0 items-center justify-center rounded-full border",
          selected ? "border-primary" : "border-muted-foreground/40",
        )}
      >
        {selected && <span className="size-2 rounded-full bg-primary" />}
      </span>
      {label}
    </button>
  )
}

export function QuestionsSheet({
  open,
  onOpenChange,
  questions,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  questions: QuestionSpec[]
  onSubmit: (answers: QAnswer[]) => void
}) {
  const n = questions.length
  // idx in 0..n-1 is a question; idx === n is the review step (multi only)
  const [idx, setIdx] = useState(0)
  const [picks, setPicks] = useState<(string | null)[]>([])
  const [others, setOthers] = useState<string[]>([])

  useEffect(() => {
    if (open) {
      setIdx(0)
      setPicks(questions.map(() => null))
      setOthers(questions.map(() => ""))
    }
  }, [open, questions])

  const answered = (i: number) =>
    picks[i] !== null && (picks[i] !== OTHER || others[i]?.trim().length > 0)
  const answerText = (i: number) =>
    picks[i] === OTHER ? others[i].trim() : (picks[i] ?? "")
  const allAnswered = questions.every((_, i) => answered(i))
  const review = n > 1 && idx === n
  const q = review ? null : questions[idx]

  const submit = () =>
    onSubmit(
      questions.map((question, i) => ({
        question: question.text,
        answer: answerText(i),
      })),
    )

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent>
        <div className="mx-auto w-full max-w-xl px-4 pb-safe-plus">
          <div className="flex items-center gap-2 pt-1 pb-3">
            <MessageCircleQuestionIcon className="size-4 text-primary" />
            <DrawerTitle className="text-[13px] font-medium text-muted-foreground">
              {review
                ? "Review your answers"
                : n === 1
                  ? "Question"
                  : `Question ${idx + 1} of ${n}`}
            </DrawerTitle>
          </div>

          {q ? (
            <>
              <h3 className="text-[16px] font-semibold leading-snug">{q.text}</h3>
              <div className="mt-3 space-y-2">
                {q.options.map((opt) => (
                  <OptionRow
                    key={opt}
                    label={opt}
                    selected={picks[idx] === opt}
                    onSelect={() =>
                      setPicks((p) => p.map((v, i) => (i === idx ? opt : v)))
                    }
                  />
                ))}
                <OptionRow
                  label="Other…"
                  selected={picks[idx] === OTHER}
                  onSelect={() =>
                    setPicks((p) => p.map((v, i) => (i === idx ? OTHER : v)))
                  }
                />
                {picks[idx] === OTHER && (
                  <Textarea
                    autoFocus
                    value={others[idx] ?? ""}
                    onChange={(e) =>
                      setOthers((o) =>
                        o.map((v, i) => (i === idx ? e.target.value : v)),
                      )
                    }
                    placeholder="Type your answer…"
                    className="min-h-16"
                  />
                )}
              </div>
            </>
          ) : (
            <div className="space-y-2">
              {questions.map((question, i) => (
                <button
                  key={i}
                  onClick={() => setIdx(i)}
                  className="flex w-full items-center gap-2 rounded-xl border border-border p-3 text-left hover:bg-accent"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-[12px] text-muted-foreground">
                      {question.text}
                    </div>
                    <div className="truncate text-[14px] font-medium">
                      {answerText(i) || "—"}
                    </div>
                  </div>
                  <PencilIcon className="size-3.5 shrink-0 text-muted-foreground" />
                </button>
              ))}
            </div>
          )}

          <div className="mt-4 flex items-center gap-2">
            {(review || idx > 0) && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setIdx((i) => Math.max(0, i - 1))}
              >
                <ChevronLeftIcon /> Back
              </Button>
            )}
            <div className="flex-1" />
            {n === 1 ? (
              <Button size="sm" disabled={!answered(0)} onClick={submit}>
                Submit
              </Button>
            ) : review ? (
              <Button size="sm" disabled={!allAnswered} onClick={submit}>
                Submit
              </Button>
            ) : (
              <Button
                size="sm"
                disabled={!answered(idx)}
                onClick={() => setIdx((i) => i + 1)}
              >
                {idx === n - 1 ? "Review" : "Next"} <ChevronRightIcon />
              </Button>
            )}
          </div>
        </div>
      </DrawerContent>
    </Drawer>
  )
}
