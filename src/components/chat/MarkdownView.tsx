import { memo, useState } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import rehypeHighlight from "rehype-highlight"
import { CheckIcon, CopyIcon } from "lucide-react"
import { cn } from "@/lib/utils"

function CopyButton({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-accent active:scale-95 transition",
        className,
      )}
      onClick={() => {
        void navigator.clipboard.writeText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }}
    >
      {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
      {copied ? "Copied" : "Copy"}
    </button>
  )
}

function extractText(node: unknown): string {
  if (typeof node === "string") return node
  if (Array.isArray(node)) return node.map(extractText).join("")
  if (node && typeof node === "object" && "props" in node)
    return extractText((node as { props: { children?: unknown } }).props.children)
  return ""
}

export const MarkdownView = memo(function MarkdownView({
  content,
  className,
}: {
  content: string
  className?: string
}) {
  return (
    <div className={cn("prose-chat", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
        components={{
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div className="table-wrap">
              <table>{children}</table>
            </div>
          ),
          pre: ({ children }) => {
            const text = extractText(children).replace(/\n$/, "")
            let lang = ""
            if (
              children &&
              typeof children === "object" &&
              "props" in children
            ) {
              const cls =
                (children as { props: { className?: string } }).props
                  .className ?? ""
              lang = /language-([\w-]+)/.exec(cls)?.[1] ?? ""
            }
            return (
              <div className="group/code relative my-1">
                <div
                  className="flex items-center justify-between rounded-t-xl border border-b-0 border-border bg-muted/70 px-3 py-1"
                  data-ui="code-head"
                >
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {lang || "code"}
                  </span>
                  <CopyButton text={text} />
                </div>
                <pre className="!mt-0 !rounded-t-none">{children}</pre>
              </div>
            )
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
})
