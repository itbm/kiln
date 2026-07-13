import { useEffect, useMemo, useState } from "react"
import { Loader2Icon } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import type { PackageLicense } from "virtual:licenses"

export function LicensesDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const [packages, setPackages] = useState<PackageLicense[] | null>(null)

  // The list is generated at build time and lazy-loaded as its own chunk so
  // it costs nothing until someone actually opens the dialog.
  useEffect(() => {
    if (!open || packages) return
    void import("virtual:licenses").then((m) => setPackages(m.default))
  }, [open, packages])

  const groups = useMemo(() => {
    const by = new Map<string, PackageLicense[]>()
    for (const p of packages ?? []) {
      const list = by.get(p.license)
      if (list) list.push(p)
      else by.set(p.license, [p])
    }
    return [...by.entries()].sort(
      (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
    )
  }, [packages])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Open-source licences</DialogTitle>
          <DialogDescription className="text-[13px]">
            Kiln is licensed under Apache-2.0 and is built with{" "}
            {packages ? packages.length : "these"} open-source packages, listed
            with their licences below.
          </DialogDescription>
        </DialogHeader>
        {!packages ? (
          <div className="flex justify-center py-8">
            <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-4">
            {groups.map(([license, pkgs]) => (
              <section key={license}>
                <h3 className="mb-1.5 text-[13px] font-semibold">
                  {license}{" "}
                  <span className="font-normal text-muted-foreground">
                    · {pkgs.length} package{pkgs.length === 1 ? "" : "s"}
                  </span>
                </h3>
                <ul className="space-y-0.5">
                  {pkgs.map((p) => (
                    <li key={`${p.name}@${p.version}`} className="text-[12.5px]">
                      <a
                        href={`https://www.npmjs.com/package/${p.name}/v/${p.version}`}
                        target="_blank"
                        rel="noreferrer"
                        className="font-mono text-foreground/90 underline-offset-2 hover:text-primary hover:underline"
                      >
                        {p.name}
                      </a>{" "}
                      <span className="font-mono text-[11.5px] text-muted-foreground">
                        {p.version}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
