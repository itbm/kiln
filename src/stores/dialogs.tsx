import { useState } from "react"
import { create } from "zustand"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"

interface DialogRequest {
  kind: "confirm" | "prompt"
  title: string
  description?: string
  initial?: string
  confirmLabel?: string
  destructive?: boolean
  resolve: (value: string | boolean | null) => void
}

interface DialogState {
  current: DialogRequest | null
  open: (req: DialogRequest) => void
  close: (value: string | boolean | null) => void
}

const useDialogs = create<DialogState>()((set, get) => ({
  current: null,
  open: (req) => set({ current: req }),
  close: (value) => {
    get().current?.resolve(value)
    set({ current: null })
  },
}))

/** Promise-based confirm — replaces window.confirm (flaky in iOS PWAs). */
export function confirmDialog(opts: {
  title: string
  description?: string
  confirmLabel?: string
  destructive?: boolean
}): Promise<boolean> {
  return new Promise((resolve) => {
    useDialogs.getState().open({
      kind: "confirm",
      ...opts,
      resolve: (v) => resolve(v === true),
    })
  })
}

/** Promise-based text prompt — replaces window.prompt. */
export function promptDialog(opts: {
  title: string
  description?: string
  initial?: string
  confirmLabel?: string
}): Promise<string | null> {
  return new Promise((resolve) => {
    useDialogs.getState().open({
      kind: "prompt",
      ...opts,
      resolve: (v) => resolve(typeof v === "string" ? v : null),
    })
  })
}

export function DialogHost() {
  const current = useDialogs((s) => s.current)
  const close = useDialogs((s) => s.close)
  const [text, setText] = useState("")

  if (!current) return null
  const isPrompt = current.kind === "prompt"

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) close(null)
      }}
    >
      <DialogContent
        className="max-w-[90vw] rounded-2xl sm:max-w-sm"
        onOpenAutoFocus={(e) => {
          if (isPrompt) {
            e.preventDefault()
            const el = document.getElementById("dialog-prompt-input")
            el?.focus()
            setText(current.initial ?? "")
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{current.title}</DialogTitle>
          {current.description && (
            <DialogDescription>{current.description}</DialogDescription>
          )}
        </DialogHeader>
        {isPrompt && (
          <Input
            id="dialog-prompt-input"
            defaultValue={current.initial ?? ""}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") close(text.trim() || null)
            }}
          />
        )}
        <DialogFooter className="flex-row justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => close(null)}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant={current.destructive ? "destructive" : "default"}
            onClick={() => close(isPrompt ? text.trim() || null : true)}
          >
            {current.confirmLabel ?? (isPrompt ? "Save" : "Confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
