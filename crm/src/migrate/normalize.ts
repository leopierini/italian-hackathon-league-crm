// Pure functions that turn Sinergia's hand-written values into CRM values.

const truthy = new Set(["s", "si", "sì", "sí", "1", "y", "yes", "true", "x", "vero"]);

export function isYes(value: string | undefined): boolean {
  return truthy.has((value ?? "").trim().toLowerCase());
}

export const isDeleted = isYes;

export function foldText(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

// ---- dates ---------------------------------------------------------------------------------

export type LocalDateTime = { y: number; m: number; d: number; h: number; mi: number; s: number; hasTime: boolean };

function valid(dt: LocalDateTime): LocalDateTime | null {
  if (dt.m < 1 || dt.m > 12 || dt.d < 1 || dt.d > 31 || dt.y < 1900 || dt.y > 2100) return null;
  return dt;
}

// Day first. Accepts dd/mm/yyyy, d/m/yyyy, dd-mm-yyyy, dd.mm.yy(yy), yyyy-mm-dd, optional time,
// and Excel serial days (e.g. 45116).
export function parseLocalDate(raw: string | undefined): LocalDateTime | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(value);
  if (match) {
    return valid({ y: +match[1]!, m: +match[2]!, d: +match[3]!, h: +(match[4] ?? 0), mi: +(match[5] ?? 0), s: +(match[6] ?? 0), hasTime: match[4] !== undefined });
  }
  match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})(?:[ T]+(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?)?$/.exec(value);
  if (match) {
    let y = +match[3]!;
    if (match[3]!.length === 2) y += y >= 70 ? 1900 : 2000;
    return valid({ y, m: +match[2]!, d: +match[1]!, h: +(match[4] ?? 0), mi: +(match[5] ?? 0), s: +(match[6] ?? 0), hasTime: match[4] !== undefined });
  }
  match = /^(\d{5})(?:[.,]\d+)?$/.exec(value);
  if (match) {
    const serial = +match[1]!;
    if (serial < 20000 || serial > 80000) return null;
    const date = new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000);
    return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate(), h: 0, mi: 0, s: 0, hasTime: false };
  }
  return null;
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

// Date-only values (close dates) are stored as midnight UTC of that calendar day.
export function toIsoDate(dt: LocalDateTime | null): string | null {
  if (!dt) return null;
  return `${pad(dt.y, 4)}-${pad(dt.m)}-${pad(dt.d)}T00:00:00.000Z`;
}

function lastSundayUtc(year: number, month: number): number {
  const last = new Date(Date.UTC(year, month + 1, 0));
  return last.getUTCDate() - last.getUTCDay();
}

// Europe/Rome wall-clock time to a UTC instant (CET +1, CEST +2 from the last Sunday of March
// 01:00 UTC to the last Sunday of October 01:00 UTC).
export function romeToIso(dt: LocalDateTime | null): string | null {
  if (!dt) return null;
  const asUtc = Date.UTC(dt.y, dt.m - 1, dt.d, dt.h, dt.mi, dt.s);
  const dstStart = Date.UTC(dt.y, 2, lastSundayUtc(dt.y, 2), 1);
  const dstEnd = Date.UTC(dt.y, 9, lastSundayUtc(dt.y, 9), 1);
  const guess = asUtc - 3_600_000;
  const offset = guess >= dstStart && guess < dstEnd ? 7_200_000 : 3_600_000;
  return new Date(asUtc - offset).toISOString();
}

// ---- numbers and money ---------------------------------------------------------------------

// Parses numbers written as 488210,35 / 116.903,80 / 24,376.08 / 1027956.14 / (5.131,24) /
// 4,086.16- . The last separator followed by 1-2 digits is the decimal one; groups of exactly
// three digits after a single separator are thousands.
export function parseNumber(raw: string | undefined): number | null {
  let value = (raw ?? "").trim();
  if (!value) return null;
  let negative = false;
  if (/^\(.*\)$/.test(value)) { negative = true; value = value.slice(1, -1); }
  if (/^-|-$|^[^0-9]*-/.test(value)) negative = true;
  const digits = value.replace(/[^0-9.,]/g, "");
  if (!/[0-9]/.test(digits)) return null;
  const lastSep = Math.max(digits.lastIndexOf(","), digits.lastIndexOf("."));
  let number: number;
  if (lastSep === -1) {
    number = Number(digits);
  } else {
    const sepChar = digits[lastSep]!;
    const mixed = digits.includes(sepChar === "," ? "." : ",");
    const repeated = digits.split(sepChar).length > 2;
    const intPart = digits.slice(0, lastSep).replace(/[.,]/g, "");
    const fracPart = digits.slice(lastSep + 1);
    const thousands = !mixed && (repeated || (fracPart.length === 3 && intPart.length > 0));
    number = thousands ? Number(intPart + fracPart) : Number(`${intPart || "0"}.${fracPart || "0"}`);
  }
  if (!Number.isFinite(number)) return null;
  return negative ? -number : number;
}

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON * Math.sign(value)) * 100) / 100;
}

export type Currency = "EUR" | "USD" | "GBP";

export function parseCurrency(...sources: Array<string | undefined>): Currency | null {
  for (const source of sources) {
    const value = (source ?? "").trim().toLowerCase();
    if (!value) continue;
    if (value.includes("usd") || value.includes("$") || value.includes("dollar")) return "USD";
    if (value.includes("gbp") || value.includes("£") || value.includes("sterlin") || value.includes("pound")) return "GBP";
    if (value.includes("eur") || value.includes("€")) return "EUR";
  }
  return null;
}

export const eurRate: Record<Currency, number> = { EUR: 1, USD: 0.92, GBP: 1.17 };

// ---- identity values -----------------------------------------------------------------------

export function normalizeDomain(raw: string | undefined): string {
  let value = (raw ?? "").trim().toLowerCase();
  if (!value) return "";
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/^\/\//, "");
  value = value.split(/[/?#\s]/)[0]!;
  value = value.replace(/^[^@]*@/, "").replace(/:\d+$/, "").replace(/\.+$/, "");
  value = value.replace(/^www\d*\./, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(value) ? value : "";
}

const emailPattern = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/;

export function normalizeEmail(raw: string | undefined): string {
  const value = (raw ?? "").trim().toLowerCase();
  if (!emailPattern.test(value) || value.includes("..")) return "";
  return value;
}

export function emailDomain(email: string): string {
  const at = email.lastIndexOf("@");
  return at === -1 ? "" : email.slice(at + 1);
}

// ---- enumerations --------------------------------------------------------------------------

export function lifecycleStage(raw: string | undefined): string {
  const value = foldText((raw ?? "").trim()).replace(/[^a-z]/g, "");
  if (!value) return "";
  if (value.startsWith("ex") || value.includes("excliente") || value.includes("perso")) return "other";
  if (value.startsWith("lead")) return "lead";
  if (value.startsWith("prospect") || value.includes("potenziale")) return "opportunity";
  if (value.startsWith("client")) return "customer";
  return "";
}

export const salesStages = [
  "appointmentscheduled", "qualifiedtobuy", "presentationscheduled", "decisionmakerboughtin",
  "contractsent", "closedwon", "closedlost",
] as const;
const salesNames = ["contatto", "qualifica", "presentazione", "decisione", "contratto", "vinta", "persa"];

export const renewalStages = ["Da rinnovare", "In trattativa", "Rinnovato", "Non rinnovato"] as const;
const renewalNames = ["darinnovare", "intrattativa", "rinnovato", "nonrinnovato"];

export type DealStage = { pipeline: "sales" | "renewals"; stage: string };

export function dealStage(raw: string | undefined): DealStage | null {
  const value = foldText((raw ?? "").trim());
  const renewalCode = /^r\s*([1-4])\b/.exec(value);
  if (renewalCode) return { pipeline: "renewals", stage: renewalStages[+renewalCode[1]! - 1]! };
  const code = /^0?([1-7])\b/.exec(value);
  if (code) return { pipeline: "sales", stage: salesStages[+code[1]! - 1]! };
  const letters = value.replace(/[^a-z]/g, "");
  const renewalIndex = renewalNames.findIndex((name) => letters.endsWith(name));
  // "nonrinnovato" ends with "rinnovato": check the longer names first.
  if (letters.endsWith("nonrinnovato")) return { pipeline: "renewals", stage: "Non rinnovato" };
  if (renewalIndex !== -1) return { pipeline: "renewals", stage: renewalStages[renewalIndex]! };
  const salesIndex = salesNames.findIndex((name) => letters.includes(name));
  if (salesIndex !== -1) return { pipeline: "sales", stage: salesStages[salesIndex]! };
  return null;
}

export const ticketStages = ["Aperto", "In lavorazione", "In attesa del cliente", "Chiuso"] as const;

export function ticketStage(raw: string | undefined): string | null {
  const value = foldText((raw ?? "").trim()).replace(/[^a-z]/g, "");
  if (!value) return null;
  if (value.includes("attesa")) return "In attesa del cliente";
  if (value.includes("lavorazione") || value.includes("corso")) return "In lavorazione";
  if (value.includes("chius") || value.includes("risolt")) return "Chiuso";
  if (value.includes("apert") || value.includes("nuov")) return "Aperto";
  return null;
}

export function ticketPriority(raw: string | undefined): string {
  const value = foldText((raw ?? "").trim()).replace(/[^a-z]/g, "");
  if (!value) return "";
  if (value.startsWith("urgent")) return "URGENT";
  if (value.startsWith("alt") || value === "high") return "HIGH";
  if (value.startsWith("med") || value.startsWith("normal")) return "MEDIUM";
  if (value.startsWith("bass") || value === "low") return "LOW";
  return "";
}

export type ActivityType = "notes" | "calls" | "emails" | "meetings";

export function activityType(raw: string | undefined): ActivityType | null {
  const value = foldText((raw ?? "").trim()).replace(/[^a-z]/g, "");
  if (!value) return null;
  if (value.startsWith("not") || value.startsWith("appunt")) return "notes";
  if (value.startsWith("chiam") || value.startsWith("telef") || value.startsWith("tel")) return "calls";
  if (value.includes("mail")) return "emails";
  if (value.startsWith("meet") || value.startsWith("riun") || value.startsWith("incontr") || value.startsWith("visit")) return "meetings";
  return null;
}

export function normalizeSku(raw: string | undefined): string {
  const digits = (raw ?? "").trim().toUpperCase().replace(/^BF/, "").replace(/[^0-9]/g, "");
  if (!digits) return "";
  return `BF-${digits.padStart(5, "0")}`;
}

// Quantity text like "1 pz", "5 conf", "20,00".
export function parseQuantity(raw: string | undefined): number | null {
  const match = /-?\d[\d.,]*/.exec((raw ?? "").trim());
  return match ? parseNumber(match[0]) : null;
}

// Deal amounts: "€24,376.08", "EUR 223.370,86", "206,5k", "152.5 mila", "1,4 Mln",
// "€ 1,641.59 al mese" (monthly: renewals are annual, so x12).
export function parseAmount(raw: string | undefined): { value: number; monthly: boolean } | null {
  const text = (raw ?? "").trim();
  const base = parseNumber(text.replace(/\b(?:mln|milion[ei]|mila|k)\b|(?<=\d)\s*(?:mln|mila|k)/gi, " "));
  if (base === null) return null;
  const lower = text.toLowerCase();
  let value = base;
  if (/\d\s*(?:mln|milion[ei])\b/.test(lower)) value *= 1_000_000;
  else if (/\d\s*(?:mila|k)\b/.test(lower)) value *= 1_000;
  const monthly = /\/\s*mese|al\s+mese|mensil/.test(lower);
  if (monthly) value *= 12;
  return { value: round2(value), monthly };
}

// Discounts: "15,0", "10%", "25 %", "0,25" (a fraction: 25%), empty -> 0.
export function parseDiscount(raw: string | undefined): number {
  const text = (raw ?? "").trim();
  const value = parseNumber(text);
  if (value === null) return 0;
  if (!text.includes("%") && value > 0 && value < 1) return round2(value * 100);
  return value;
}

export function money(value: number): string {
  return String(round2(value));
}
