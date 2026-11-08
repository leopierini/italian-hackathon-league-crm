import { Link } from "react-router"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Empty, ErrorState, LegacyId, Loading, PageHeader, Pager } from "@/components/common"
import { SearchBox, useListParams } from "@/pages/companies"
import { useApi } from "@/lib/api"
import { int, lifecycleLabels } from "@/lib/format"
import { cn } from "@/lib/utils"

type Contact = { id: string; firstname?: string; lastname?: string; email?: string; phone?: string; lifecyclestage?: string; id_legacy?: string; company: { id: string; name: string | null } | null }
type Result = { total: number; page: number; pageSize: number; results: Contact[] }

export function ContactsPage() {
  const { params, set, page } = useListParams()
  const q = params.get("q") ?? ""
  const { data, error, loading, reload } = useApi<Result>(`/ui-api/contacts?q=${encodeURIComponent(q)}&page=${page}`)
  return (
    <>
      <PageHeader
        title="Contacts"
        description={data ? `${int(data.total)} people at customer and prospect companies` : "People at customer and prospect companies"}
        actions={<SearchBox key={q} value={q} onSearch={(v) => set({ q: v })} placeholder="Name, email, phone or Sinergia code" />}
      />
      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : loading && !data ? (
        <Loading text="Loading contacts" />
      ) : data && data.results.length === 0 ? (
        <Empty title="No contact matches this search">Search by last name, or by the email domain of the company.</Empty>
      ) : data ? (
        <div className={cn(loading && "opacity-60")}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4 md:pl-6">Name</TableHead>
                <TableHead className="hidden sm:table-cell">Email</TableHead>
                <TableHead className="hidden lg:table-cell">Phone</TableHead>
                <TableHead>Company</TableHead>
                <TableHead className="hidden pr-4 md:table-cell md:pr-6">Stage</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.results.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="pl-4 md:pl-6">
                    <div className="font-medium">{[c.firstname, c.lastname].filter(Boolean).join(" ") || "—"}</div>
                    <LegacyId value={c.id_legacy} />
                  </TableCell>
                  <TableCell className="hidden max-w-[14rem] truncate sm:table-cell">{c.email ?? <span className="text-muted-foreground">No email</span>}</TableCell>
                  <TableCell className="hidden lg:table-cell">{c.phone ?? "—"}</TableCell>
                  <TableCell className="max-w-[12rem] truncate">
                    {c.company ? (
                      <Link to={`/companies/${c.company.id}`} className="hover:underline">
                        {c.company.name}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="hidden pr-4 md:table-cell md:pr-6">{c.lifecyclestage ? lifecycleLabels[c.lifecyclestage] ?? c.lifecyclestage : "—"}</TableCell>
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
