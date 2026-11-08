import type { ReactNode } from "react"
import { AlertCircle, ChevronLeft, ChevronRight, Loader2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { int, ticketStageLabel } from "@/lib/format"

// The Sinergia code every imported record keeps, so the migration can be checked against its source.
export function LegacyId({ value, className }: { value?: string | null; className?: string }) {
  if (!value) return null
  return (
    <span
      title="Code in Sinergia, the previous system"
      className={cn("inline-flex items-center gap-1 rounded border border-dashed px-1.5 py-0 font-mono text-[11px] leading-5 text-muted-foreground", className)}
    >
      <span className="text-muted-foreground/70">SIN</span>
      {value}
    </span>
  )
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 border-b px-4 py-4 sm:flex-row sm:items-end sm:justify-between md:px-6">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  )
}

export function Loading({ text }: { text: string }) {
  return (
    <div role="status" className="flex items-center gap-2 px-4 py-10 text-sm text-muted-foreground md:px-6">
      <Loader2 className="size-4 animate-spin" aria-hidden />
      {text}
    </div>
  )
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="m-4 flex flex-col items-start gap-3 rounded-lg border border-destructive/30 p-4 text-sm md:m-6">
      <div className="flex items-center gap-2 font-medium text-destructive">
        <AlertCircle className="size-4" aria-hidden />
        Could not load this page
      </div>
      <p className="text-muted-foreground">{message} Check your connection, then try again.</p>
      {onRetry ? (
        <Button size="sm" variant="outline" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  )
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="px-4 py-12 text-center text-sm md:px-6">
      <p className="font-medium">{title}</p>
      {children ? <div className="mt-1 text-muted-foreground">{children}</div> : null}
    </div>
  )
}

export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(Math.ceil(total / pageSize), 1)
  const from = total ? (page - 1) * pageSize + 1 : 0
  const to = Math.min(page * pageSize, total)
  return (
    <div className="flex items-center justify-between gap-2 border-t px-4 py-3 text-sm md:px-6">
      <span className="tabular text-muted-foreground">
        {int(from)}–{int(to)} of {int(total)}
      </span>
      <div className="flex items-center gap-1">
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page">
          <ChevronLeft className="size-4" aria-hidden />
          Previous
        </Button>
        <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Next page">
          Next
          <ChevronRight className="size-4" aria-hidden />
        </Button>
      </div>
    </div>
  )
}

const priorityStyle: Record<string, { label: string; variant: "destructive" | "default" | "secondary" | "outline" }> = {
  URGENT: { label: "Urgent", variant: "destructive" },
  HIGH: { label: "High", variant: "default" },
  MEDIUM: { label: "Medium", variant: "secondary" },
  LOW: { label: "Low", variant: "outline" },
}

export function PriorityBadge({ value }: { value?: string }) {
  if (!value) return <span className="text-xs text-muted-foreground">No priority</span>
  const s = priorityStyle[value] ?? { label: value, variant: "outline" as const }
  return <Badge variant={s.variant}>{s.label}</Badge>
}

export function TicketStageBadge({ value }: { value?: string }) {
  if (!value) return <span className="text-muted-foreground">—</span>
  const closed = value === "Chiuso" || value === "4"
  return (
    <Badge variant="outline" className={cn("gap-1.5", closed && "text-muted-foreground")}>
      <span aria-hidden className={cn("size-1.5 rounded-full", closed ? "bg-muted-foreground/50" : value === "Aperto" ? "bg-foreground" : "bg-foreground/60")} />
      {ticketStageLabel(value)}
    </Badge>
  )
}

export function ClassBadge({ value, size = "sm" }: { value?: string; size?: "sm" | "lg" }) {
  if (!value)
    return size === "lg" ? <span className="text-3xl font-semibold text-muted-foreground">—</span> : <span className="text-muted-foreground">—</span>
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center rounded-md border font-semibold",
        size === "lg" ? "size-12 text-2xl" : "size-6 text-xs",
        value === "A" && "border-foreground bg-foreground text-background",
      )}
      title={`Customer class ${value}`}
    >
      {value}
    </span>
  )
}
