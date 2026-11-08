const eurFmt = new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR", minimumFractionDigits: 2, maximumFractionDigits: 2 })
const eurShort = new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR", notation: "compact", maximumFractionDigits: 1 })
const intFmt = new Intl.NumberFormat("en-IE")

export const eur = (v: unknown) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? "—" : eurFmt.format(Number(v)))
export const eurCompact = (v: unknown) => (!Number.isFinite(Number(v)) ? "—" : eurShort.format(Number(v)))
export const int = (v: unknown) => intFmt.format(Number(v ?? 0))

export function money(amount: unknown, currency?: string) {
  if (amount === null || amount === undefined || amount === "" || !Number.isFinite(Number(amount))) return "—"
  const code = (currency || "EUR").toUpperCase()
  try {
    return new Intl.NumberFormat("en-IE", { style: "currency", currency: code, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(amount))
  } catch {
    return `${eurFmt.format(Number(amount))}`
  }
}

export function date(v: unknown) {
  const ms = Date.parse(String(v ?? ""))
  if (!Number.isFinite(ms)) return "—"
  return new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Europe/Rome" })
}

export function dateTime(v: unknown) {
  const ms = Date.parse(String(v ?? ""))
  if (!Number.isFinite(ms)) return "—"
  return new Date(ms).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Rome" })
}

export function plural(n: number, one: string, many = `${one}s`) {
  return `${int(n)} ${n === 1 ? one : many}`
}

// UI labels stay in English; these keys remain the CRM's stored pipeline stage values.
export const salesStageLabels: Record<string, string> = {
  appointmentscheduled: "Contact",
  qualifiedtobuy: "Qualification",
  presentationscheduled: "Presentation",
  decisionmakerboughtin: "Decision",
  contractsent: "Contract",
  closedwon: "Won",
  closedlost: "Lost",
}

const renewalStageLabels: Record<string, string> = {
  "Da rinnovare": "Due for renewal",
  "In trattativa": "In negotiation",
  Rinnovato: "Renewed",
  "Non rinnovato": "Not renewed",
}

export function stageLabel(pipeline: string | undefined, stage: string | undefined) {
  if (!stage) return "—"
  if ((pipeline ?? "default") === "default") return salesStageLabels[stage] ?? stage
  if (pipeline === "Rinnovi") return renewalStageLabels[stage] ?? stage
  if (pipeline === "Assistenza") return ticketStageLabel(stage)
  return stage
}

const ticketStageLabels: Record<string, string> = {
  aperto: "Open",
  "in lavorazione": "In progress",
  "in attesa del cliente": "Waiting for customer",
  chiuso: "Closed",
}

export function ticketStageLabel(stage?: string) {
  if (!stage) return "—"
  const normalized = stage.trim().toLocaleLowerCase("it-IT")
  return ticketStageLabels[normalized] ?? stage
}

export function pipelineLabel(p?: string) {
  if (!p || p === "default") return "Sales"
  if (p === "Rinnovi") return "Renewals"
  if (p === "Assistenza") return "Support"
  return p
}

export const lifecycleLabels: Record<string, string> = { lead: "Lead", opportunity: "Prospect", customer: "Customer", other: "Former customer" }
