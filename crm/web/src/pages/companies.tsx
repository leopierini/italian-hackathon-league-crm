import { useState } from "react"
import { Link, useSearchParams } from "react-router"
import { Search } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ClassBadge, Empty, ErrorState, LegacyId, Loading, PageHeader, Pager } from "@/components/common"
import { useApi } from "@/lib/api"
import { eur, int } from "@/lib/format"
import { cn } from "@/lib/utils"

type Company = { id: string; name?: string; domain?: string; city?: string; state?: string; partita_iva?: string; id_legacy?: string; fatturato_2025?: string; classe_cliente?: string }
type Result = { total: number; page: number; pageSize: number; classes: Record<string, number>; results: Company[] }

export function useListParams() {
  const [params, setParams] = useSearchParams()
  const set = (patch: Record<string, string | number | null>) => {
    const next = new URLSearchParams(params)
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === "" || (k === "page" && v === 1)) next.delete(k)
      else next.set(k, String(v))
    }
    if (!("page" in patch)) next.delete("page")
    setParams(next, { replace: true })
  }
  return { params, set, page: Number(params.get("page") ?? 1) || 1 }
}

export function SearchBox({ value, onSearch, placeholder }: { value: string; onSearch: (q: string) => void; placeholder: string }) {
  const [draft, setDraft] = useState(value)
  return (
    <form
      role="search"
      onSubmit={(e) => {
        e.preventDefault()
        onSearch(draft.trim())
      }}
      className="relative w-full sm:w-72"
    >
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
      <Input value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={() => draft.trim() !== value && onSearch(draft.trim())} placeholder={placeholder} aria-label={placeholder} className="pl-8" />
    </form>
  )
}

export function FilterChips({ options, value, onChange, label }: { options: Array<{ value: string; label: string; count?: number }>; value: string; onChange: (v: string) => void; label: string }) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1">
      {options.map((o) => (
        <button
          key={o.value}
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-xs transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
            value === o.value && "border-foreground bg-foreground text-background hover:bg-foreground/90",
          )}
        >
          {o.label}
          {o.count !== undefined ? <span className={cn("tabular", value === o.value ? "text-background/70" : "text-muted-foreground")}>{int(o.count)}</span> : null}
        </button>
      ))}
    </div>
  )
}

export function CompaniesPage() {
  const { params, set, page } = useListParams()
  const q = params.get("q") ?? ""
  const cls = params.get("cls") ?? ""
  const { data, error, loading, reload } = useApi<Result>(`/ui-api/companies?q=${encodeURIComponent(q)}&cls=${cls}&page=${page}`)
  const c = data?.classes ?? {}
  const all = Object.values(c).reduce((a, b) => a + b, 0)
  return (
    <>
      <PageHeader
        title="Companies"
        description={data ? `${int(data.total)} companies, ranked by 2025 revenue` : "Customers and prospects imported from Sinergia"}
        actions={<SearchBox key={q} value={q} onSearch={(v) => set({ q: v })} placeholder="Name, domain, city, VAT or Sinergia code" />}
      />
      <div className="border-b px-4 py-2 md:px-6">
        <FilterChips
          label="Customer class"
          value={cls}
          onChange={(v) => set({ cls: v })}
          options={[
            { value: "", label: "All", count: all },
            { value: "A", label: "Class A", count: c.A ?? 0 },
            { value: "B", label: "Class B", count: c.B ?? 0 },
            { value: "C", label: "Class C", count: c.C ?? 0 },
            { value: "none", label: "No class", count: c.none ?? 0 },
          ]}
        />
      </div>
      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : loading && !data ? (
        <Loading text="Loading companies and their 2025 revenue" />
      ) : data && data.results.length === 0 ? (
        <Empty title="No company matches this search">Try a shorter name, a domain like brambilla.it, or clear the class filter.</Empty>
      ) : data ? (
        <div className={cn(loading && "opacity-60")}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4 md:pl-6">Company</TableHead>
                <TableHead className="hidden md:table-cell">City</TableHead>
                <TableHead className="hidden lg:table-cell">VAT number</TableHead>
                <TableHead className="text-right">2025 revenue</TableHead>
                <TableHead className="pr-4 text-center md:pr-6">Class</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.results.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="max-w-[16rem] pl-4 md:pl-6">
                    <Link to={`/companies/${r.id}`} className="block truncate font-medium hover:underline focus-visible:underline">
                      {r.name || "Unnamed company"}
                    </Link>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="truncate">{r.domain ?? "No website"}</span>
                      <LegacyId value={r.id_legacy} className="hidden sm:inline-flex" />
                    </div>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    {r.city ?? "—"} {r.state ? <span className="text-muted-foreground">({r.state})</span> : null}
                  </TableCell>
                  <TableCell className="tabular hidden font-mono text-xs lg:table-cell">{r.partita_iva ?? "—"}</TableCell>
                  <TableCell className="tabular text-right">{eur(r.fatturato_2025 ?? 0)}</TableCell>
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
