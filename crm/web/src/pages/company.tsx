import { Link, useParams } from "react-router"
import { ArrowLeft, CalendarClock, Globe, Mail, MapPin, Phone, Users } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ClassBadge, Empty, ErrorState, LegacyId, Loading, PriorityBadge, TicketStageBadge } from "@/components/common"
import { useApi } from "@/lib/api"
import { date, dateTime, eur, int, lifecycleLabels, money, pipelineLabel, plural, stageLabel } from "@/lib/format"

type P = Record<string, string | undefined>
type Person = { email: string; name: string } | null
type Activity = { id: string; type: string; timestamp: string | null; idLegacy: string | null; text: string; author: Person; via: { kind: string; id: string; name: string | null } | null }
type Detail = {
  company: P & { id: string }
  reps: Array<{ email: string; name: string; deals: number }>
  revenueDeals: Array<{ id: string; dealname?: string; closedate?: string; amount?: string; currency: string; amountEur: number }>
  contacts: Array<P & { id: string }>
  deals: Array<P & { id: string; owner: Person }>
  tickets: Array<P & { id: string; assignee: Person }>
  activityStats: { total: number; in2025: number; last: string | null }
  activities: Activity[]
}

const activityLabel: Record<string, string> = { notes: "Note", calls: "Call", emails: "Email", meetings: "Meeting", tasks: "Task" }
const classRule: Record<string, string> = { A: "€100,000 or more", B: "€20,000 to €99,999.99", C: "Above zero, under €20,000" }

function Fact({ icon: Icon, children, label }: { icon: typeof Globe; children: React.ReactNode; label: string }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-sm">
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-label={label} />
      <span className="truncate">{children}</span>
    </div>
  )
}

export function CompanyPage() {
  const { id } = useParams()
  const { data, error, loading, reload } = useApi<Detail>(`/ui-api/companies/${id}`)
  if (error) return <ErrorState message={error} onRetry={reload} />
  if (loading || !data) return <Loading text="Loading the company with its contacts, deals and history" />
  const c = data.company
  const revenue = Number(c.fatturato_2025 ?? 0)
  const openDeals = data.deals.filter((d) => !["closedwon", "closedlost", "Rinnovato", "Non rinnovato"].includes(d.dealstage ?? ""))
  const openTickets = data.tickets.filter((t) => t.hs_pipeline_stage !== "Chiuso")
  return (
    <div className="pb-10">
      <div className="border-b px-4 pt-3 pb-5 md:px-6">
        <Link to="/companies" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3.5" aria-hidden />
          Companies
        </Link>
        <div className="mt-2 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight">{c.name || "Unnamed company"}</h1>
              <LegacyId value={c.id_legacy} />
            </div>
            <div className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
              <Fact icon={Globe} label="Domain">
                {c.domain ? (
                  <a href={`https://${c.domain}`} target="_blank" rel="noreferrer" className="hover:underline">
                    {c.domain}
                  </a>
                ) : (
                  <span className="text-muted-foreground">No website</span>
                )}
              </Fact>
              <Fact icon={MapPin} label="City">
                {c.city ?? "—"} {c.state ? `(${c.state})` : ""}
              </Fact>
              <div className="flex items-center gap-1.5 text-sm">
                <span className="text-muted-foreground">VAT</span>
                {c.partita_iva ? <span className="tabular font-mono text-[13px]">{c.partita_iva}</span> : <span className="text-muted-foreground">Not on file</span>}
              </div>
              <Fact icon={Users} label="Sales reps">
                {data.reps.length ? data.reps.map((r) => r.name).join(", ") : <span className="text-muted-foreground">No rep on its deals</span>}
              </Fact>
            </div>
          </div>
          <div className="flex shrink-0 items-stretch gap-3">
            <div className="rounded-lg border px-4 py-3">
              <div className="text-xs text-muted-foreground">2025 revenue</div>
              <div className="tabular mt-1 text-3xl font-semibold tracking-tight">{eur(revenue)}</div>
              <div className="mt-1 text-xs text-muted-foreground">
                {data.revenueDeals.length ? `${plural(data.revenueDeals.length, "won deal")} closed in 2025` : "No won deal closed in 2025"}
              </div>
            </div>
            <div className="flex flex-col items-center justify-center rounded-lg border px-4 py-3">
              <div className="text-xs text-muted-foreground">Class</div>
              <div className="mt-1">
                <ClassBadge value={c.classe_cliente} size="lg" />
              </div>
              <div className="mt-1 max-w-[9rem] text-center text-[11px] text-muted-foreground">{c.classe_cliente ? classRule[c.classe_cliente] : "Zero or negative revenue"}</div>
            </div>
          </div>
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          {[
            ["Contacts", int(data.contacts.length)],
            ["Open deals", int(openDeals.length)],
            ["Open tickets", int(openTickets.length)],
            ["Last activity", data.activityStats.last ? date(data.activityStats.last) : "None"],
          ].map(([k, v]) => (
            <div key={k}>
              <dt className="text-xs text-muted-foreground">{k}</dt>
              <dd className="tabular font-medium">{v}</dd>
            </div>
          ))}
        </dl>
      </div>

      <Tabs defaultValue="activity" className="px-4 pt-4 md:px-6">
        <TabsList className="max-w-full overflow-x-auto">
          <TabsTrigger value="activity">History {int(data.activityStats.total)}</TabsTrigger>
          <TabsTrigger value="contacts">Contacts {int(data.contacts.length)}</TabsTrigger>
          <TabsTrigger value="deals">Deals {int(data.deals.length)}</TabsTrigger>
          <TabsTrigger value="tickets">Tickets {int(data.tickets.length)}</TabsTrigger>
          <TabsTrigger value="revenue">Revenue</TabsTrigger>
        </TabsList>

        <TabsContent value="activity" className="mt-3">
          {data.activities.length === 0 ? (
            <Empty title="No activity yet">Calls, emails, meetings and notes logged on this company's contacts and deals appear here.</Empty>
          ) : (
            <>
              <p className="mb-3 text-xs text-muted-foreground">
                Notes, calls, emails and meetings on this company's contacts and deals · {int(data.activityStats.in2025)} in 2025
                {data.activityStats.total > data.activities.length ? ` · latest ${data.activities.length} of ${int(data.activityStats.total)}` : ""}
              </p>
              <ol className="relative flex flex-col border-l pl-4">
                {data.activities.map((a) => (
                  <li key={`${a.type}-${a.id}`} className="relative pb-4">
                    <span aria-hidden className="absolute top-1.5 -left-[21px] size-2.5 rounded-full border-2 border-background bg-foreground/70" />
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                      <Badge variant="outline">{activityLabel[a.type] ?? a.type}</Badge>
                      <span className="tabular">{dateTime(a.timestamp)}</span>
                      {a.author ? <span>by {a.author.name}</span> : null}
                      {a.via?.name ? <span>· {a.via.kind === "deals" ? "deal" : "with"} {a.via.name}</span> : null}
                      <LegacyId value={a.idLegacy} />
                    </div>
                    <p className="mt-1 text-sm whitespace-pre-line">{a.text || <span className="text-muted-foreground">No text</span>}</p>
                  </li>
                ))}
              </ol>
            </>
          )}
        </TabsContent>

        <TabsContent value="contacts" className="mt-3">
          {data.contacts.length === 0 ? (
            <Empty title="No contacts at this company">Contacts are linked by the migration and by their email domain when created.</Empty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead className="hidden md:table-cell">Phone</TableHead>
                  <TableHead className="hidden sm:table-cell">Stage</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.contacts.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>
                      <div className="font-medium">{[p.firstname, p.lastname].filter(Boolean).join(" ") || "—"}</div>
                      <LegacyId value={p.id_legacy} />
                    </TableCell>
                    <TableCell className="max-w-[12rem] truncate">
                      {p.email ? (
                        <a href={`mailto:${p.email}`} className="inline-flex items-center gap-1 hover:underline">
                          <Mail className="size-3.5 text-muted-foreground" aria-hidden />
                          {p.email}
                        </a>
                      ) : (
                        <span className="text-muted-foreground">No email</span>
                      )}
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      {p.phone ? (
                        <span className="inline-flex items-center gap-1">
                          <Phone className="size-3.5 text-muted-foreground" aria-hidden />
                          {p.phone}
                        </span>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">{p.lifecyclestage ? lifecycleLabels[p.lifecyclestage] ?? p.lifecyclestage : "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </TabsContent>

        <TabsContent value="deals" className="mt-3">
          {data.deals.length === 0 ? (
            <Empty title="No deals with this company">Create one from the deals board or ask the assistant.</Empty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Deal</TableHead>
                  <TableHead>Stage</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead className="hidden md:table-cell">Close date</TableHead>
                  <TableHead className="hidden lg:table-cell">Owner</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.deals.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell className="max-w-[18rem]">
                      <div className="truncate font-medium">{d.dealname ?? "Untitled deal"}</div>
                      <LegacyId value={d.id_legacy} />
                    </TableCell>
                    <TableCell>
                      <div>{stageLabel(d.pipeline, d.dealstage)}</div>
                      <div className="text-xs text-muted-foreground">{pipelineLabel(d.pipeline)}</div>
                    </TableCell>
                    <TableCell className="tabular text-right">{money(d.amount, d.deal_currency_code)}</TableCell>
                    <TableCell className="tabular hidden md:table-cell">{date(d.closedate)}</TableCell>
                    <TableCell className="hidden lg:table-cell">{d.owner?.name ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </TabsContent>

        <TabsContent value="tickets" className="mt-3">
          {data.tickets.length === 0 ? (
            <Empty title="No support tickets">Tickets opened for this company appear here.</Empty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Subject</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Priority</TableHead>
                  <TableHead className="hidden md:table-cell">Opened</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.tickets.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="max-w-[18rem]">
                      <div className="truncate font-medium">{t.subject ?? "No subject"}</div>
                      <LegacyId value={t.id_legacy} />
                    </TableCell>
                    <TableCell>
                      <TicketStageBadge value={t.hs_pipeline_stage} />
                    </TableCell>
                    <TableCell>
                      <PriorityBadge value={t.hs_ticket_priority} />
                    </TableCell>
                    <TableCell className="tabular hidden md:table-cell">{date(t.createdate)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </TabsContent>

        <TabsContent value="revenue" className="mt-3">
          <p className="mb-3 max-w-2xl text-sm text-muted-foreground">
            <CalendarClock className="mr-1 inline size-4 align-text-bottom" aria-hidden />
            Deals marked Won in Sales or Renewed in Renewals and closed in 2025, shown in euro at the fixed rates USD 0.92 and GBP 1.17. Negative amounts are reversals and subtract.
          </p>
          {data.revenueDeals.length === 0 ? (
            <Empty title="No revenue in 2025">This company has no won deal closed in 2025, so its class is empty.</Empty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Deal</TableHead>
                  <TableHead className="hidden sm:table-cell">Closed</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead className="text-right">In euro</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.revenueDeals.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell className="max-w-[18rem] truncate">{d.dealname ?? "Untitled deal"}</TableCell>
                    <TableCell className="tabular hidden sm:table-cell">{date(d.closedate)}</TableCell>
                    <TableCell className="tabular text-right">{money(d.amount, d.currency)}</TableCell>
                    <TableCell className="tabular text-right">{eur(d.amountEur)}</TableCell>
                  </TableRow>
                ))}
                <TableRow>
                  <TableCell className="font-medium">Total, rounded to the cent</TableCell>
                  <TableCell className="hidden sm:table-cell" />
                  <TableCell />
                  <TableCell className="tabular text-right font-semibold">{eur(revenue)}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}
