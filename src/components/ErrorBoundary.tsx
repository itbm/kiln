import { Component, type ReactNode } from "react"
import { RotateCcwIcon, TriangleAlertIcon } from "lucide-react"
import { Button } from "@/components/ui/button"

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  render() {
    if (!this.state.error) return this.props.children
    const detail = `${this.state.error.message}\n${this.state.error.stack ?? ""}`
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-4 px-8 text-center">
        <TriangleAlertIcon className="size-10 text-primary" />
        <div>
          <h1 className="font-serif text-xl font-semibold">
            Something went wrong
          </h1>
          <p className="mt-1 text-[13.5px] text-muted-foreground">
            The app hit an unexpected error. Your chats and settings are safe
            on this device — reloading usually fixes it.
          </p>
        </div>
        <pre className="max-h-40 w-full max-w-md overflow-auto rounded-xl border border-border bg-muted/50 p-3 text-left font-mono text-[11px] text-muted-foreground">
          {this.state.error.message}
        </pre>
        <div className="flex gap-2">
          <Button onClick={() => window.location.reload()}>
            <RotateCcwIcon /> Reload app
          </Button>
          <Button
            variant="outline"
            onClick={() => void navigator.clipboard.writeText(detail)}
          >
            Copy error
          </Button>
        </div>
      </div>
    )
  }
}
