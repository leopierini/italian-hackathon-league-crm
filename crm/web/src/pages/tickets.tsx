import { Link } from "react-router"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Empty, ErrorState, LegacyId, Loading, PageHeader, Pager, PriorityBadge, TicketStageBadge } from "@/components/common"
import { FilterChips, SearchBox, useListParams } from "@/pages/companies"
import { useApi } from "@/lib/api"
import { date, int, pipelineLabel, ticketStageLabel } from "@/lib/format"
import { cn } from "@/lib/utils"

type Ticket = { id: string; subject?: string; content?: string; hs_pipeline_stage?: string; hs_ticket_priority?: string; createdate?: string; closed_date?: string; id_legacy?: string; assignee: { email: string; name: string } | null; company: { id: string; name: string | null } | null }
type Result = { total: number; page: number; pageSize: number; stages: Array<{ id: string; label: string; closed: boolean; count: number }>; priorities: Record<string, number>; results: Ticket[] }

export function TicketsPage() {
  const { params, set, page } = useListParams()
  const q = params.get("q") ?? ""
  const stage = params.get("stage") ?? ""
  const priority = params.get("priority") ?? ""
  const { data, error, loading, reload } = useApi<Result>(`/ui-api/tickets?q=${encodeURIComponent(q)}&stage=${encodeURIComponent(stage)}&priority=${priority}&page=${page}`)
  const p = data?.priorities ?? {}
  const stageTotal = (data?.stages ?? []).reduce((a, s) => a + s.count, 0)
  const priorityTotal = Object.values(p).reduce((a, b) => a + b, 0)
  return (
    <>
      <PageHeader
        title="Tickets"
        description={data ? `${int(data.total)} support tickets in the ${pipelineLabel("Assistenza")} pipeline, newest first` : "Support tickets in the Support pipeline"}
        actions={<SearchBox key={q} value={q} onSearch={(v) => set({ q: v })} placeholder="Subject, description or Sinergia code" />}
      />
      <div className="flex flex-col gap-2 border-b px-4 py-2 md:px-6">
        <FilterChips
          label="Status"
          value={stage}
          onChange={(v) => set({ stage: v })}
          options={[{ value: "", label: "Any status", count: stageTotal }, ...(data?.stages ?? []).map((s) => ({ value: s.id, label: ticketStageLabel(s.label), count: s.count }))]}
        />
        <FilterChips
          label="Priority"
          value={priority}
          onChange={(v) => set({ priority: v })}
          options={[
            { value: "", label: "Any priority", count: priorityTotal },
            { value: "URGENT", label: "Urgent", count: p.URGENT ?? 0 },
            { value: "HIGH", label: "High", count: p.HIGH ?? 0 },
            { value: "MEDIUM", label: "Medium", count: p.MEDIUM ?? 0 },
            { value: "LOW", label: "Low", count: p.LOW ?? 0 },
            { value: "none", label: "No priority", count: p.none ?? 0 },
          ]}
        />
      </div>
      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : loading && !data ? (
        <Loading text="Loading support tickets with status and priority" />
      ) : data && data.results.length === 0 ? (
        <Empty title="No ticket matches these filters">Choose Any status and Any priority, or clear the search.</Empty>
      ) : data ? (
        <div className={cn(loading && "opacity-60")}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4 md:pl-6">Ticket</TableHead>
                <TableHead className="hidden md:table-cell">Status</TableHead>
                <TableHead className="hidden md:table-cell">Priority</TableHead>
                <TableHead className="hidden md:table-cell">Assignee</TableHead>
                <TableHead className="hidden pr-4 md:pr-6 lg:table-cell">Opened</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.results.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="max-w-none pl-4 md:max-w-[22rem] md:pl-6">
                    <div className="line-clamp-2 break-words whitespace-normal font-medium" title={t.subject}>
                      {t.subject ?? "No subject"}
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      {t.company ? (
                        <Link to={`/companies/${t.company.id}`} className="truncate hover:text-foreground hover:underline">
                          {t.company.name}
                        </Link>
                      ) : (
                        <span className="truncate">{t.content?.split("\n").at(-1) ?? "No company"}</span>
                      )}
                      <LegacyId value={t.id_legacy} className="hidden sm:inline-flex" />
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 md:hidden">
                      <TicketStageBadge value={t.hs_pipeline_stage} />
                      <PriorityBadge value={t.hs_ticket_priority} />
                    </div>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    <TicketStageBadge value={t.hs_pipeline_stage} />
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    <PriorityBadge value={t.hs_ticket_priority} />
                  </TableCell>
                  <TableCell className="hidden md:table-cell">{t.assignee?.name ?? <span className="text-muted-foreground">Unassigned</span>}</TableCell>
                  <TableCell className="tabular hidden pr-4 md:pr-6 lg:table-cell">
                    {date(t.createdate)}
                    {t.closed_date ? <div className="text-xs text-muted-foreground">Closed {date(t.closed_date)}</div> : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={(n) => set({ page: n })} />
        </div>
      ) : null}
    </>
  )
}
