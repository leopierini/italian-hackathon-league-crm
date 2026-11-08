// R8 (2025 revenue and customer class) and R9 (dormant customers). Pure functions over property
// bags, so the API and the assistant can reuse them on records read from the database.
import type { Model, Obj } from "./model.js";
import { renewalsPipelineId } from "./schema.js";

type Props = Record<string, unknown>;

export const revenueYear = 2025;
export const dormantListName = "Clienti dormienti";

// Fixed rates of Brambilla's management control, in hundredths of a euro per unit.
const rateHundredths: Record<string, number> = { EUR: 100, USD: 92, GBP: 117 };

// Won = Vinta in the sales pipeline or Rinnovato in Rinnovi.
export function isWonDeal(props: Props): boolean {
  const pipeline = String(props.pipeline ?? "default");
  const stage = String(props.dealstage ?? "");
  return (pipeline === "default" && stage === "closedwon") || (pipeline === renewalsPipelineId && stage === "Rinnovato");
}

// Calendar year in Europe/Rome. Year boundaries fall in winter time (UTC+1).
export function romeYear(iso: unknown): number | null {
  const ms = Date.parse(String(iso ?? ""));
  return Number.isFinite(ms) ? new Date(ms + 3_600_000).getUTCFullYear() : null;
}

// Close dates are calendar days stored as midnight UTC: the year is the UTC year.
function closeYear(iso: unknown): number | null {
  const ms = Date.parse(String(iso ?? ""));
  return Number.isFinite(ms) ? new Date(ms).getUTCFullYear() : null;
}

// Won deals closed in `year`, converted to euro and summed exactly (integer arithmetic in
// 1/10,000 euro), then the total rounded to the cent. Storni are won deals with a negative
// amount, so they subtract. Returns cents.
export function revenueCents(deals: Props[], year = revenueYear): number {
  let total = 0;
  for (const deal of deals) {
    if (!isWonDeal(deal) || closeYear(deal.closedate) !== year) continue;
    const amount = Number(deal.amount);
    if (deal.amount === undefined || deal.amount === null || deal.amount === "" || !Number.isFinite(amount)) continue;
    const rate = rateHundredths[String(deal.deal_currency_code ?? "EUR").toUpperCase()] ?? 100;
    total += Math.round(amount * 100) * rate;
  }
  return Math.sign(total) * Math.round(Math.abs(total) / 100);
}

export function customerClass(cents: number): string {
  if (cents >= 10_000_000) return "A";
  if (cents >= 2_000_000) return "B";
  if (cents > 0) return "C";
  return "";
}

export const centsToString = (cents: number): string => String(cents / 100);

// Applies R8 to every company and returns the R9 members (company object ids).
export function applyRevenueAndDormant(model: Model): number[] {
  const byId = new Map<number, Obj>();
  for (const obj of model.objects) byId.set(obj.id, obj);
  const dealsOf = new Map<number, Obj[]>();
  const companiesOfContact = new Map<number, number[]>();
  const companiesOfDeal = new Map<number, number[]>();
  const push = <K, V>(map: Map<K, V[]>, key: K, value: V) => {
    const list = map.get(key);
    if (list) list.push(value); else map.set(key, [value]);
  };
  for (const [fromType, fromId, toType, toId] of model.assocs) {
    if (fromType === "companies" && toType === "deals") push(dealsOf, fromId, byId.get(toId)!);
    else if (fromType === "contacts" && toType === "companies") push(companiesOfContact, fromId, toId);
    else if (fromType === "deals" && toType === "companies") push(companiesOfDeal, fromId, toId);
  }

  // Companies with activity in the revenue year, through their contacts or their deals.
  const active = new Set<number>();
  const activityTypes = new Set(["notes", "calls", "emails", "meetings"]);
  for (const [fromType, fromId, toType, toId] of model.assocs) {
    if (!activityTypes.has(fromType) || romeYear(byId.get(fromId)!.props.hs_timestamp) !== revenueYear) continue;
    const companies = toType === "contacts" ? companiesOfContact.get(toId) : toType === "deals" ? companiesOfDeal.get(toId) : undefined;
    for (const company of companies ?? []) active.add(company);
  }

  const dormant: number[] = [];
  const stats = { A: 0, B: 0, C: 0, none: 0, negative: 0 };
  for (const company of model.objects) {
    if (company.type !== "companies") continue;
    const deals = (dealsOf.get(company.id) ?? []).map((deal) => deal.props);
    const cents = revenueCents(deals);
    company.props.fatturato_2025 = centsToString(cents);
    const cls = customerClass(cents);
    if (cls) company.props.classe_cliente = cls;
    stats[(cls || "none") as keyof typeof stats] += 1;
    if (cents < 0) stats.negative += 1;
    if (deals.some(isWonDeal) && !active.has(company.id)) dormant.push(company.id);
  }
  model.stats.classA = stats.A;
  model.stats.classB = stats.B;
  model.stats.classC = stats.C;
  model.stats.classNone = stats.none;
  model.stats.revenueNegative = stats.negative;
  model.stats.dormant = dormant.length;
  return dormant;
}
