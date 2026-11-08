import { Link } from "react-router"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ClassBadge, Empty, ErrorState, LegacyId, Loading, PageHeader, Pager } from "@/components/common"
import { FilterChips, SearchBox, useListParams } from "@/pages/companies"
import { useApi } from "@/lib/api"
import { date, eur, int } from "@/lib/format"
import { cn } from "@/lib/utils"

type Row = { id: string; name?: string; city?: string; state?: string; domain?: string; id_legacy?: string; classe_cliente?: string; fatturato_2025?: string; wonDeals: number; wonValueEur: number | null; lastWon: string | null; lastActivity: string | null; rep: { email: string; name: string } | null }
type Result = { list: { id: string; name: string; processingType: string; size: number } | null; total: number; page: number; pageSize: number; sort: string; results: Row[] }

export function DormantPage() {
  const { params, set, page } = useListParams()
  const q = params.get("q") ?? ""
  const sort = params.get("sort") ?? "recent"
  const { data, error, loading, reload } = useApi<Result>(`/ui-api/dormant?q=${encodeURIComponent(q)}&sort=${sort}&page=${page}`)
  return (
    <>
      <PageHeader
        title="Dormant customers"
        description={
          <>
            List <span className="font-medium text-foreground">Dormant customers</span>
            {data?.list ? ` · ${int(data.list.size)} companies` : ""}: customers with at least one won deal, in any year, and no call, email, meeting or note in 2025 on their contacts or deals.
          </>
        }
        actions={<SearchBox key={q} value={q} onSearch={(v) => set({ q: v })} placeholder="Name, city, VAT or Sinergia code" />}
      />
      <div className="border-b px-4 py-2 md:px-6">
        <FilterChips
          label="Sort by"
          value={sort}
          onChange={(v) => set({ sort: v === "recent" ? null : v })}
          options={[
            { value: "recent", label: "Most recent win" },
            { value: "value", label: "Lifetime won value" },
            { value: "name", label: "Name" },
          ]}
        />
      </div>
      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : loading && !data ? (
        <Loading text="Finding customers with no activity in 2025" />
      ) : data && !data.list ? (
        <Empty title="The Dormant customers list does not exist yet">Run the migration from Sinergia: it builds the list.</Empty>
      ) : data && data.results.length === 0 ? (
        <Empty title="No dormant customer matches this search">Clear the search to see the whole list.</Empty>
      ) : data ? (
        <div className={cn(loading && "opacity-60")}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4 md:pl-6">Company</TableHead>
                <TableHead className="hidden lg:table-cell">Sales rep</TableHead>
                <TableHead className="text-right">Won deals</TableHead>
                <TableHead className="hidden text-right sm:table-cell">Lifetime won</TableHead>
                <TableHead className="hidden md:table-cell">Last win</TableHead>
                <TableHead className="hidden md:table-cell">Last activity</TableHead>
                <TableHead className="pr-4 text-center md:pr-6">Class</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.results.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="max-w-[16rem] pl-4 md:pl-6">
                    <Link to={`/companies/${r.id}`} className="block truncate font-medium hover:underline">
                      {r.name || "Unnamed company"}
                    </Link>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="truncate">
                        {r.city ?? "—"}
                        {r.state ? ` (${r.state})` : ""}
                      </span>
                      <LegacyId value={r.id_legacy} className="hidden sm:inline-flex" />
                    </div>
                    <div className="tabular text-xs text-muted-foreground md:hidden">
                      Last activity: {r.lastActivity ? date(r.lastActivity) : "Never"}
                    </div>
                  </TableCell>
                  <TableCell className="hidden lg:table-cell">{r.rep?.name ?? "—"}</TableCell>
                  <TableCell className="tabular text-right">{int(r.wonDeals)}</TableCell>
                  <TableCell className="tabular hidden text-right sm:table-cell">{eur(r.wonValueEur)}</TableCell>
                  <TableCell className="tabular hidden md:table-cell">{date(r.lastWon)}</TableCell>
                  <TableCell className="tabular hidden md:table-cell">{r.lastActivity ? date(r.lastActivity) : <span className="text-muted-foreground">Never</span>}</TableCell>
                  <TableCell className="pr-4 text-center md:pr-6">
                    <ClassBadge value={r.classe_cliente} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={(p) => set({ page: p })} />
        </div>
      ) : null}
    </>
  )
}
