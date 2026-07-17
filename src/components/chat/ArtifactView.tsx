import { useMemo, useState } from "react"
import {
  CheckIcon,
  CodeIcon,
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FileTextIcon,
  GlobeIcon,
  ImageIcon,
  XIcon,
} from "lucide-react"
import {
  Drawer,
  DrawerContent,
  DrawerTitle,
} from "@/components/ui/drawer"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { MarkdownView } from "./MarkdownView"
import {
  artifactExtension,
  type ArtifactBlock,
} from "@/lib/artifacts"
import { cn } from "@/lib/utils"

export function artifactIcon(type: ArtifactBlock["type"]) {
  switch (type) {
    case "text/html":
      return GlobeIcon
    case "application/code":
      return CodeIcon
    case "image/svg+xml":
      return ImageIcon
    default:
      return FileTextIcon
  }
}

export function typeLabel(a: ArtifactBlock): string {
  switch (a.type) {
    case "text/html":
      return "Web page"
    case "application/code":
      return a.language ? `Code · ${a.language}` : "Code"
    case "image/svg+xml":
      return "SVG image"
    default:
      return "Document"
  }
}

export function ArtifactCard({
  artifact,
  onOpen,
}: {
  artifact: ArtifactBlock
  onOpen: () => void
}) {
  const Icon = artifactIcon(artifact.type)
  const streaming = !artifact.complete
  return (
    <button
      onClick={onOpen}
      disabled={streaming}
      data-ui="art-card"
      className={cn(
        "my-2 flex w-full max-w-md items-center gap-3 rounded-2xl border border-border bg-card p-3 text-left shadow-xs transition",
        streaming
          ? "animate-pulse cursor-default"
          : "hover:border-primary/40 hover:shadow-sm active:scale-[0.99]",
      )}
    >
      <div
        className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"
        data-ui="art-ico"
      >
        <Icon className="size-5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14px] font-medium">{artifact.title}</div>
        <div className="text-[12px] text-muted-foreground" data-ui="art-sub">
          {streaming
            ? `Writing… ${artifact.content.split("\n").length} lines`
            : `${typeLabel(artifact)} · tap to open`}
        </div>
      </div>
    </button>
  )
}

export function ArtifactViewer({
  artifact,
  onClose,
}: {
  artifact: ArtifactBlock | null
  onClose: () => void
}) {
  const [tab, setTab] = useState<"preview" | "source">("preview")
  const [copied, setCopied] = useState(false)
  const previewable = artifact?.type !== "application/code"

  const blobUrl = useMemo(() => {
    if (!artifact) return ""
    const mime =
      artifact.type === "application/code" ? "text/plain" : artifact.type
    return URL.createObjectURL(
      new Blob([artifact.content], { type: `${mime};charset=utf-8` }),
    )
  }, [artifact])

  if (!artifact) return null
  const activeTab = previewable ? tab : "source"

  const download = () => {
    const a = document.createElement("a")
    a.href = blobUrl
    a.download = `${artifact.id}.${artifactExtension(artifact)}`
    a.click()
  }

  return (
    <Drawer open={!!artifact} onOpenChange={(o) => !o && onClose()}>
      <DrawerContent className="!max-h-[96dvh] h-[96dvh]">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
          <div className="min-w-0 flex-1">
            <DrawerTitle className="truncate text-[15px] font-semibold">
              {artifact.title}
            </DrawerTitle>
            <div className="text-[11.5px] text-muted-foreground">
              {typeLabel(artifact)}
            </div>
          </div>
          {previewable && (
            <Tabs value={activeTab} onValueChange={(v) => setTab(v as never)}>
              <TabsList className="h-8">
                <TabsTrigger value="preview" className="px-2.5 text-xs">
                  Preview
                </TabsTrigger>
                <TabsTrigger value="source" className="px-2.5 text-xs">
                  Source
                </TabsTrigger>
              </TabsList>
            </Tabs>
          )}
          <Button variant="ghost" size="icon-sm" onClick={onClose}>
            <XIcon />
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden bg-background">
          {activeTab === "preview" ? (
            artifact.type === "text/html" ? (
              <iframe
                title={artifact.title}
                sandbox="allow-scripts allow-popups allow-forms allow-modals"
                srcDoc={artifact.content}
                className="h-full w-full border-0 bg-white"
              />
            ) : artifact.type === "image/svg+xml" ? (
              <div className="flex h-full items-center justify-center overflow-auto bg-white p-4 dark:bg-[#1d1d1b]">
                <img src={blobUrl} alt={artifact.title} className="max-h-full max-w-full" />
              </div>
            ) : (
              <div className="h-full overflow-y-auto px-4 py-4">
                <MarkdownView content={artifact.content} />
                <div className="h-8" />
              </div>
            )
          ) : (
            <div className="h-full overflow-auto p-3">
              <pre className="font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-words">
                {artifact.content}
              </pre>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-border px-3 pt-2 pb-safe-plus">
          <Button
            variant="outline"
            size="sm"
            className="flex-1"
            onClick={() => {
              void navigator.clipboard.writeText(artifact.content)
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            }}
          >
            {copied ? <CheckIcon /> : <CopyIcon />} {copied ? "Copied" : "Copy"}
          </Button>
          <Button variant="outline" size="sm" className="flex-1" onClick={download}>
            <DownloadIcon /> Download
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="flex-1"
            onClick={() => window.open(blobUrl, "_blank")}
          >
            <ExternalLinkIcon /> Open
          </Button>
        </div>
      </DrawerContent>
    </Drawer>
  )
}
