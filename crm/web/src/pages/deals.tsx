import { useState } from "react"
import { Link } from "react-router"
import { toast } from "sonner"
import { Building2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { ErrorState, LegacyId, Loading, PageHeader } from "@/components/common"
import { SignInDialog } from "@/components/sign-in-dialog"
import { FilterChips, SearchBox, useListParams } from "@/pages/companies"
import { ApiFailure, api, getToken, useApi } from "@/lib/api"
import { date, eurCompact, int, money, pipelineLabel, stageLabel } from "@/lib/format"
import { cn } from "@/lib/utils"

type Person = { email: string; name: string } | null
type Deal = { id: string; dealname?: string; amount?: string; deal_currency_code?: string; closedate?: string; dealstage?: string; pipeline?: string; id_legacy?: string; owner: Person; company: { id: string; name: string | null } | null }
type Stage = { id: string; label: string; closed: boolean; probability: number | null; total: number; amountEur: number; deals: Deal[] }
type Board = { pipeline: { id: string; label: string }; owners: Array<{ email: string; name: string }>; stages: Stage[] }

function DealCard({ deal, stages, pipeline, onMove, moving }: { deal: Deal; stages: Stage[]; pipeline: string; onMove: (deal: Deal, stage: string) => void; moving: boolean }) {
  return (
    <li
      draggable={!moving}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", deal.id)
        e.dataTransfer.effectAllowed = "move"
      }}
      className={cn("rounded-md border bg-card p-2.5 text-sm shadow-xs", moving ? "opacity-50" : "cursor-grab active:cursor-grabbing")}
    >
      <div className="line-clamp-2 font-medium">{deal.dealname ?? "Untitled deal"}</div>
      {deal.company ? (
        <Link to={`/companies/${deal.company.id}`} className="mt-0.5 flex items-center gap-1 truncate text-xs text-muted-foreground hover:text-foreground hover:underline">
          <Building2 className="size-3 shrink-0" aria-hidden />
          <span className="truncate">{deal.company.name}</span>
        </Link>
      ) : (
        <div className="mt-0.5 text-xs text-muted-foreground">No company</div>
      )}
      <div className="mt-2 flex items-baseline justify-between gap-2">
        <span className="tabular font-semibold">{money(deal.amount, deal.deal_currency_code)}</span>
        <span className="tabular text-xs text-muted-foreground">{date(deal.closedate)}</span>
      </div>
      <div className="mt-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="truncate">{deal.owner?.name ?? "No owner"}</span>
        <LegacyId value={deal.id_legacy} />
      </div>
      <label className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="sr-only sm:not-sr-only">Move to</span>
        <select
          value={deal.dealstage}
          disabled={moving}
          onChange={(e) => onMove(deal, e.target.value)}
          aria-label={`Move ${deal.dealname ?? "deal"} to another stage`}
          className="h-6 min-w-0 flex-1 rounded border bg-background px-1 text-xs text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          {stages.map((s) => (
            <option key={s.id} value={s.id}>
              {stageLabel(pipeline, s.id)}
            </option>
          ))}
        </select>
      </label>
    </li>
  )
}

export function DealsPage() {
  const { params, set } = useListParams()
  const pipeline = params.get("pipeline") === "Rinnovi" ? "Rinnovi" : "default"
  const q = params.get("q") ?? ""
  const owner = params.get("owner") ?? ""
  const { data, error, loading, reload } = useApi<Board>(`/ui-api/board?pipeline=${pipeline}&q=${encodeURIComponent(q)}&owner=${encodeURIComponent(owner)}`)
  const [moving, setMoving] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const [signInOpen, setSignInOpen] = useState(false)
  const [pendingMove, setPendingMove] = useState<{ deal: Deal; stage: string } | null>(null)

  async function move(deal: Deal, stage: string) {
    if (!data || stage === deal.dealstage) return
    if (!getToken()) {
      setPendingMove({ deal, stage })
      setSignInOpen(true)
      return
    }
    setMoving(deal.id)
    const label = stageLabel(pipeline, stage)
    try {
      await api(`/crm/objects/2026-09/deals/${deal.id}`, { method: "PATCH", body: JSON.stringify({ properties: { dealstage: stage } }) })
      const effects = await api<{ results: Array<{ type: string; subject: string; due: string | null }> }>(`/ui-api/deals/${deal.id}/automations`)
      const ticket = stage === "closedwon" ? effects.results.find((r) => r.type === "tickets") : undefined
      const task = stage === "closedlost" ? effects.results.find((r) => r.type === "tasks") : undefined
      toast.success(`"${deal.dealname}" moved to ${label}`, {
        description: ticket
          ? `Support ticket "${ticket.subject}" is open in the Support pipeline.`
          : task
            ? `Follow-up task "${task.subject}" is due ${date(task.due)}.`
            : undefined,
      })
      reload()
    } catch (e) {
      if (e instanceof ApiFailure && e.status === 401) {
        setPendingMove({ deal, stage })
        setSignInOpen(true)
        return
      }
      toast.error(`Could not move "${deal.dealname}" to ${label}`, { description: `${(e as Error).message} The deal stays where it was.` })
    } finally {
      setMoving(null)
    }
  }

  const findDeal = (id: string) => data?.stages.flatMap((s) => s.deals).find((d) => d.id === id)

  return (
    <div className="flex min-h-svh flex-col md:h-svh">
      <PageHeader
        title="Deals"
        description="Drag a card to another stage, or use its stage menu. Moving a deal to Won opens a support ticket; moving it to Lost creates a follow-up task due in six months."
        actions={<SearchBox key={q} value={q} onSearch={(v) => set({ q: v })} placeholder="Deal title or Sinergia code" />}
      />
      <div className="flex flex-wrap items-center gap-3 border-b px-4 py-2 md:px-6">
        <FilterChips
          label="Pipeline"
          value={pipeline}
          onChange={(v) => set({ pipeline: v === "default" ? null : v })}
          options={[
            { value: "default", label: "Sales" },
            { value: "Rinnovi", label: "Renewals" },
          ]}
        />
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          Owner
          <select
            value={owner}
            onChange={(e) => set({ owner: e.target.value })}
            className="h-7 max-w-[12rem] rounded-md border bg-background px-2 text-xs text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <option value="">Everyone</option>
            {data?.owners.map((o) => (
              <option key={o.email} value={o.email}>
                {o.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="border-b px-4 py-2 text-xs text-muted-foreground md:px-6">
        The board shows up to 30 deals per stage; stage totals include every match. Search or filter by owner to find a specific deal.
      </p>
      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : !data ? (
        <Loading text={`Loading the ${pipelineLabel(pipeline)} pipeline by stage`} />
      ) : (
        <div className={cn("flex min-h-0 flex-1 gap-3 overflow-x-auto px-4 py-4 md:px-6", loading && "opacity-70")}>
          {data.stages.map((s) => (
            <section
              key={s.id}
              aria-label={`${stageLabel(pipeline, s.id)}: ${int(s.total)} deals`}
              onDragOver={(e) => {
                e.preventDefault()
                setOver(s.id)
              }}
              onDragLeave={() => setOver((o) => (o === s.id ? null : o))}
              onDrop={(e) => {
                e.preventDefault()
                setOver(null)
                const deal = findDeal(e.dataTransfer.getData("text/plain"))
                if (deal) move(deal, s.id)
              }}
              className={cn("flex w-64 shrink-0 flex-col rounded-lg border bg-muted/40 md:min-h-0", over === s.id && "border-foreground bg-muted")}
            >
              <header className="border-b px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-sm font-semibold">{stageLabel(pipeline, s.id)}</h2>
                  {s.closed ? <Badge variant="outline">Closed</Badge> : s.probability !== null ? <span className="tabular text-xs text-muted-foreground">{Math.round(s.probability * 100)}%</span> : null}
                </div>
                <div className="tabular mt-0.5 flex justify-between text-xs text-muted-foreground">
                  <span>{int(s.total)} deals</span>
                  <span title="Total in euro at the fixed rates">{eurCompact(s.amountEur)}</span>
                </div>
              </header>
              <ul className="flex flex-col gap-2 overflow-y-auto p-2">
                {s.deals.length === 0 ? <li className="px-1 py-4 text-center text-xs text-muted-foreground">No deals here. Drop a card to move it.</li> : null}
                {s.deals.map((d) => (
                  <DealCard key={d.id} deal={d} stages={data.stages} pipeline={pipeline} onMove={move} moving={moving === d.id} />
                ))}
                {s.total > s.deals.length ? (
                  <li className="px-1 py-2 text-center text-xs text-muted-foreground">
                    Latest {s.deals.length} of {int(s.total)}. Search or filter by owner to narrow.
                  </li>
                ) : null}
              </ul>
            </section>
          ))}
        </div>
      )}
      <SignInDialog
        open={signInOpen}
        onOpenChange={(open) => {
          setSignInOpen(open)
          if (!open) setPendingMove(null)
        }}
        onSuccess={() => {
          const action = pendingMove
          setPendingMove(null)
          if (action) void move(action.deal, action.stage)
        }}
      />
    </div>
  )
}
