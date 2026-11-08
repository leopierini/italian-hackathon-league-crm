import type { CsvRow } from "./csv.js";
import {
  activityType, dealStage, emailDomain, foldText, isDeleted, lifecycleStage, money, normalizeDomain, normalizeEmail,
  normalizeSku, parseAmount, parseCurrency, parseDiscount, parseLocalDate, parseNumber, parseQuantity, romeToIso, round2,
  ticketPriority, ticketStage, toIsoDate, type ActivityType, type LocalDateTime,
} from "./normalize.js";
import { renewalsPipelineId, supportPipelineId } from "./schema.js";
import type { UserDirectory } from "./users.js";

export type Props = Record<string, string | number | null>;
export type Obj = { id: number; type: string; props: Props };

// HubSpot-defined association type ids (default, unlabeled), both directions.
export const assocTypes = {
  contact_company: [279, 280], deal_company: [341, 342], deal_contact: [3, 4],
  ticket_contact: [16, 15], ticket_company: [339, 340], ticket_deal: [28, 27],
  line_item_deal: [20, 19], line_item_product: [10001, 10002],
  note_contact: [202, 201], note_deal: [214, 213], call_contact: [194, 193], call_deal: [206, 205],
  email_contact: [198, 197], email_deal: [210, 209], meeting_contact: [200, 199], meeting_deal: [212, 211],
  task_deal: [216, 215],
} as const;

export class Model {
  readonly objects: Obj[] = [];
  readonly assocs: Array<[string, number, string, number, number]> = [];
  readonly stats: Record<string, number> = {};
  private readonly linked = new Set<string>();
  private nextId = 1;

  // Empty values are not stored: an unset property reads back as null, as in HubSpot.
  add(type: string, props: Props): Obj {
    for (const key of Object.keys(props)) if (props[key] === "" || props[key] === null) delete props[key];
    const obj = { id: this.nextId++, type, props };
    this.objects.push(obj);
    return obj;
  }

  link(from: Obj, to: Obj, [forward, backward]: readonly [number, number]): void {
    const key = `${from.id}:${to.id}:${forward}`;
    if (this.linked.has(key)) return;
    this.linked.add(key);
    this.assocs.push([from.type, from.id, to.type, to.id, forward]);
    this.assocs.push([to.type, to.id, from.type, from.id, backward]);
  }

  count(type: string): number {
    return this.objects.reduce((n, obj) => n + (obj.type === type ? 1 : 0), 0);
  }
}

// Sort key for "most recently modified": ultima_modifica, then position in the file.
export function modifiedKey(value: string | undefined, index: number): number {
  const dt = parseLocalDate(value);
  const time = dt ? Date.UTC(dt.y, dt.m - 1, dt.d, dt.h, dt.mi, dt.s) : 0;
  return time * 1_000_000 + index;
}

class UnionFind {
  private readonly parent: number[];
  constructor(size: number) { this.parent = Array.from({ length: size }, (_, i) => i); }
  find(x: number): number {
    while (this.parent[x] !== x) { this.parent[x] = this.parent[this.parent[x]!]!; x = this.parent[x]!; }
    return x;
  }
  union(a: number, b: number): void { this.parent[this.find(a)] = this.find(b); }
}

// Groups rows that share any key (rows are already filtered). Each group is sorted newest first.
export function groupDuplicates<T>(rows: T[], keysOf: (row: T) => string[], key: (row: T) => number): T[][] {
  const uf = new UnionFind(rows.length);
  const first = new Map<string, number>();
  rows.forEach((row, index) => {
    for (const k of keysOf(row)) {
      if (!k) continue;
      const seen = first.get(k);
      if (seen === undefined) first.set(k, index); else uf.union(index, seen);
    }
  });
  const groups = new Map<number, T[]>();
  rows.forEach((row, index) => {
    const root = uf.find(index);
    const group = groups.get(root);
    if (group) group.push(row); else groups.set(root, [row]);
  });
  return [...groups.values()].map((group) => group.sort((a, b) => key(b) - key(a)));
}

// Latest non-empty value of a field across a newest-first group.
export function latest<T>(group: T[], pick: (row: T) => string | undefined): string {
  for (const row of group) {
    const value = pick(row);
    if (value) return value;
  }
  return "";
}

// ---- R1 companies + R7 VAT -------------------------------------------------------------------

export function extractVat(note: string | undefined): string {
  const text = note ?? "";
  const pattern = /(?:partita\s*i\.?\s*v\.?\s*a\.?|p\.?\s*i\.?\s*v\.?\s*a\.?|\bp\.?\s*i\.?(?=[\s:.]))\s*[:.]?\s*(?:it)?\s*([0-9](?:[ .]?[0-9]){10})(?![0-9])/gi;
  for (const match of text.matchAll(pattern)) {
    const digits = match[1]!.replace(/\D/g, "");
    if (digits.length === 11) return digits;
  }
  return "";
}

type CompanyRow = { row: CsvRow; key: number; domain: string; vat: string };

export function buildCompanies(rows: CsvRow[], model: Model): Map<string, Obj> {
  const live: CompanyRow[] = [];
  rows.forEach((row, index) => {
    if (isDeleted(row.cancellato) || !row.id_azienda) return;
    live.push({ row, key: modifiedKey(row.ultima_modifica, index), domain: normalizeDomain(row.sito_web), vat: extractVat(row.note) });
  });
  const byLegacyId = new Map<string, Obj>();
  for (const group of groupDuplicates(live, (c) => [c.domain && `d:${c.domain}`, c.vat && `v:${c.vat}`], (c) => c.key)) {
    const domains = [...new Set(group.map((c) => c.domain).filter(Boolean))];
    const props: Props = {
      name: latest(group, (c) => c.row.ragione_sociale),
      domain: domains[0] ?? "",
      city: latest(group, (c) => c.row.citta),
      state: latest(group, (c) => c.row.provincia?.toUpperCase()),
      id_legacy: group[0]!.row.id_azienda!,
    };
    if (domains.length > 1) props.hs_additional_domains = domains.slice(1).join(";");
    const vat = latest(group, (c) => c.vat);
    if (vat) props.partita_iva = vat;
    const company = model.add("companies", props);
    for (const c of group) byLegacyId.set(c.row.id_azienda!, company);
  }
  return byLegacyId;
}

// ---- R2 contacts + R12 on import ----------------------------------------------------------------

// The email column can hold one address, several ("a@x.it / b@y.it", "a e b"), or garbage
// ("n.d.", "x(at)y.it", "x @y.it", "x@gmail"). Only syntactically valid addresses count.
export function emailsIn(raw: string | undefined): string[] {
  const parts = (raw ?? "").split(/\s*(?:[;,/|]|\s+e\s+|\s+o\s+)\s*/);
  if (parts.length === 1) {
    const email = normalizeEmail(raw);
    return email ? [email] : [];
  }
  const emails = parts.map((part) => normalizeEmail(part)).filter(Boolean);
  return [...new Set(emails)];
}

type ContactRow = { row: CsvRow; key: number; emails: string[]; phone: string; company?: Obj };

export function buildContacts(rows: CsvRow[], companies: Map<string, Obj>, model: Model): Map<string, Obj> {
  const live: ContactRow[] = [];
  let swapped = 0;
  rows.forEach((row, index) => {
    if (isDeleted(row.cancellato) || !row.id_contatto) return;
    let emails = emailsIn(row.email);
    let phone = row.telefono ?? "";
    // Some rows have email and phone in each other's column.
    if (!emails.length && emailsIn(row.telefono).length && !/[a-z]/i.test(row.email ?? "")) {
      emails = emailsIn(row.telefono);
      phone = row.email ?? "";
      swapped += 1;
    }
    live.push({ row, key: modifiedKey(row.ultima_modifica, index), emails, phone, company: companies.get(row.id_azienda ?? "") });
  });
  const personKey = (c: ContactRow) => {
    if (c.emails.length) return c.emails.map((email) => `e:${email}`);
    const name = foldText(`${c.row.nome ?? ""}|${c.row.cognome ?? ""}`).replace(/\s+/g, " ");
    const company = c.company ? `#${c.company.id}` : c.row.id_azienda;
    return company ? [`n:${name}|${company}`] : [];
  };

  const domainOwner = new Map<string, Obj>();
  for (const company of model.objects) {
    if (company.type !== "companies") continue;
    for (const domain of [company.props.domain, ...String(company.props.hs_additional_domains ?? "").split(";")]) {
      if (domain) domainOwner.set(String(domain), company);
    }
  }

  const byLegacyId = new Map<string, Obj>();
  let autoAssociated = 0;
  for (const group of groupDuplicates(live, personKey, (c) => c.key)) {
    const emails = [...new Set(group.flatMap((c) => c.emails))];
    const props: Props = {
      firstname: latest(group, (c) => c.row.nome),
      lastname: latest(group, (c) => c.row.cognome),
      email: emails[0] ?? "",
      phone: latest(group, (c) => c.phone),
      lifecyclestage: latest(group, (c) => lifecycleStage(c.row.tipo)),
      id_legacy: group[0]!.row.id_contatto!,
    };
    if (emails.length > 1) props.hs_additional_emails = emails.slice(1).join(";");
    const contact = model.add("contacts", props);
    let company = group.find((c) => c.company)?.company;
    if (!company) {
      for (const email of emails) {
        company = domainOwner.get(emailDomain(email));
        if (company) { autoAssociated += 1; break; }
      }
    }
    if (company) model.link(contact, company, assocTypes.contact_company);
    for (const c of group) byLegacyId.set(c.row.id_contatto!, contact);
  }
  model.stats.contactsSwapped = swapped;
  model.stats.contactsAutoAssociated = autoAssociated;
  return byLegacyId;
}

// ---- R4 products --------------------------------------------------------------------------------

export type Product = { obj: Obj; price: number | null; name: string };

export function buildProducts(rows: CsvRow[], model: Model): Map<string, Product> {
  const live: Array<{ row: CsvRow; key: number; sku: string }> = [];
  rows.forEach((row, index) => {
    const sku = normalizeSku(row.codice_articolo);
    if (isDeleted(row.cancellato) || !sku) return;
    live.push({ row, key: modifiedKey(row.ultima_modifica, index), sku });
  });
  const bySku = new Map<string, Product>();
  for (const group of groupDuplicates(live, (p) => [p.sku], (p) => p.key)) {
    const price = parseNumber(latest(group, (p) => p.row.prezzo_listino));
    const name = latest(group, (p) => p.row.descrizione);
    const obj = model.add("products", { hs_sku: group[0]!.sku, name, price: price === null ? null : money(price) });
    bySku.set(group[0]!.sku, { obj, price, name });
  }
  return bySku;
}

// ---- R3 deals + R4 line items -------------------------------------------------------------------

const sameStage = (a: ReturnType<typeof dealStage>, b: ReturnType<typeof dealStage>) =>
  !!a && !!b && a.pipeline === b.pipeline && a.stage === b.stage;
const closedStages = new Set(["closedwon", "closedlost", "Rinnovato", "Non rinnovato"]);
const dtKey = (dt: LocalDateTime) => Date.UTC(dt.y, dt.m - 1, dt.d, dt.h, dt.mi, dt.s);

export function buildDeals(
  data: { opportunita: CsvRow[]; storico_fasi: CsvRow[]; righe_offerta: CsvRow[] },
  companies: Map<string, Obj>, contacts: Map<string, Obj>, products: Map<string, Product>,
  users: UserDirectory, model: Model,
): Map<string, Obj> {
  const history = new Map<string, Array<{ at: LocalDateTime; stage: ReturnType<typeof dealStage> }>>();
  for (const row of data.storico_fasi) {
    const at = parseLocalDate(row.data_cambio);
    if (!at) continue;
    const list = history.get(row.id_opportunita ?? "") ?? [];
    list.push({ at, stage: dealStage(row.fase_nuova) });
    history.set(row.id_opportunita ?? "", list);
  }
  const lines = new Map<string, CsvRow[]>();
  for (const row of data.righe_offerta) {
    const list = lines.get(row.id_opportunita ?? "") ?? [];
    list.push(row);
    lines.set(row.id_opportunita ?? "", list);
  }

  const byLegacyId = new Map<string, Obj>();
  const stats = { closedateFromHistory: 0, monthly: 0, fromLines: 0, linesWithoutProduct: 0, linePriceFromProduct: 0 };
  for (const row of data.opportunita) {
    const legacyId = row.id_opportunita ?? "";
    if (isDeleted(row.cancellato) || !legacyId) continue;
    const events = (history.get(legacyId) ?? []).sort((a, b) => dtKey(a.at) - dtKey(b.at));
    let stage = dealStage(row.fase) ?? events.at(-1)?.stage ?? null;
    const renewal = stage?.pipeline === "renewals" || /rinnov/i.test(row.pipeline ?? "");
    if (!stage || (stage.pipeline === "renewals") !== renewal) {
      stage = renewal ? { pipeline: "renewals", stage: "Da rinnovare" } : { pipeline: "sales", stage: "appointmentscheduled" };
    }

    let closedate = toIsoDate(parseLocalDate(row.data_chiusura));
    if (!closedate && closedStages.has(stage.stage)) {
      const entered = [...events].reverse().find((e) => sameStage(e.stage, stage));
      if (entered) { closedate = toIsoDate({ ...entered.at, h: 0, mi: 0, s: 0, hasTime: false }); stats.closedateFromHistory += 1; }
    }

    const deal = model.add("deals", {
      dealname: row.titolo ?? "",
      pipeline: renewal ? renewalsPipelineId : "default",
      dealstage: stage.stage,
      closedate,
      commerciale: users.ownerEmail(row.id_commerciale),
      id_legacy: legacyId,
    });
    byLegacyId.set(legacyId, deal);

    const dealLines = lines.get(legacyId) ?? [];
    if (dealLines.length) {
      let total = 0;
      for (const line of dealLines) {
        const product = products.get(normalizeSku(line.codice_articolo));
        if (!product) stats.linesWithoutProduct += 1;
        const quantity = parseQuantity(line.quantita) ?? 1;
        let price = parseNumber(line.prezzo_unitario);
        if (price === null && product?.price != null) { price = product.price; stats.linePriceFromProduct += 1; }
        const discount = parseDiscount(line.sconto);
        const lineTotal = round2(quantity * (price ?? 0) * (1 - discount / 100));
        total += lineTotal;
        const item = model.add("line_items", {
          name: line.descrizione || product?.name || "",
          quantity: String(quantity),
          price: price === null ? null : money(price),
          hs_discount_percentage: String(discount),
          amount: money(lineTotal),
          hs_sku: product?.obj.props.hs_sku as string ?? normalizeSku(line.codice_articolo),
          hs_product_id: product ? String(product.obj.id) : null,
          id_legacy: line.id_riga ?? "",
        });
        model.link(item, deal, assocTypes.line_item_deal);
        if (product) model.link(item, product.obj, assocTypes.line_item_product);
      }
      deal.props.amount = money(total);
      deal.props.deal_currency_code = "EUR";
      stats.fromLines += 1;
    } else {
      const amount = parseAmount(row.importo);
      if (amount) {
        deal.props.amount = money(amount.value);
        deal.props.deal_currency_code = parseCurrency(row.valuta, row.importo) ?? "EUR";
        if (amount.monthly) stats.monthly += 1;
      }
    }

    const company = companies.get(row.id_azienda ?? "");
    if (company) model.link(deal, company, assocTypes.deal_company);
    for (const ref of (row.contatti ?? "").split(/[;,\s]+/)) {
      const contact = contacts.get(ref.trim());
      if (contact) model.link(deal, contact, assocTypes.deal_contact);
    }
  }
  Object.assign(model.stats, stats);
  return byLegacyId;
}

// ---- R5 tickets ---------------------------------------------------------------------------------

export function buildTickets(
  rows: CsvRow[], companies: Map<string, Obj>, contacts: Map<string, Obj>, users: UserDirectory, model: Model,
  createdAt: Map<number, string>,
): void {
  let swappedDates = 0;
  for (const row of rows) {
    if (isDeleted(row.cancellato) || !row.id_ticket) continue;
    let opened = romeToIso(parseLocalDate(row.aperto_il));
    let closed = romeToIso(parseLocalDate(row.chiuso_il));
    // Some rows have the two dates in each other's column (closed before opened).
    if (opened && closed && closed < opened) { [opened, closed] = [closed, opened]; swappedDates += 1; }
    const ticket = model.add("tickets", {
      subject: row.oggetto ?? "",
      content: row.descrizione ?? "",
      hs_pipeline: supportPipelineId,
      hs_pipeline_stage: ticketStage(row.stato) ?? "Aperto",
      hs_ticket_priority: ticketPriority(row.priorita),
      createdate: opened,
      closed_date: closed,
      assegnatario: users.ownerEmail(row.id_utente),
      id_legacy: row.id_ticket,
    });
    if (opened) createdAt.set(ticket.id, opened);
    const contact = contacts.get(row.id_contatto ?? "");
    if (contact) model.link(ticket, contact, assocTypes.ticket_contact);
    const company = companies.get(row.id_azienda ?? "");
    if (company) model.link(ticket, company, assocTypes.ticket_company);
  }
  model.stats.ticketDatesSwapped = swappedDates;
}

// ---- R6 activities ------------------------------------------------------------------------------

const activityBody: Record<ActivityType, string> = {
  notes: "hs_note_body", calls: "hs_call_body", emails: "hs_email_text", meetings: "hs_meeting_body",
};
const activityLinks: Record<ActivityType, [readonly [number, number], readonly [number, number]]> = {
  notes: [assocTypes.note_contact, assocTypes.note_deal],
  calls: [assocTypes.call_contact, assocTypes.call_deal],
  emails: [assocTypes.email_contact, assocTypes.email_deal],
  meetings: [assocTypes.meeting_contact, assocTypes.meeting_deal],
};

export function buildActivities(
  rows: CsvRow[], contacts: Map<string, Obj>, deals: Map<string, Obj>, users: UserDirectory, model: Model,
): void {
  // Sinergia recorded some activities twice: same type, time, text, contact, deal and author under
  // two ids. They are one activity; with no modification date, the later row in the file wins.
  const live = new Map<string, { row: CsvRow; type: ActivityType }>();
  let duplicates = 0;
  for (const row of rows) {
    const type = activityType(row.tipo);
    if (isDeleted(row.cancellato) || !row.id_attivita || !type) continue;
    const key = [type, row.data, row.testo, row.id_contatto, row.id_opportunita, row.id_utente].join("\u0000");
    if (live.delete(key)) duplicates += 1;
    live.set(key, { row, type });
  }
  for (const { row, type } of live.values()) {
    const activity = model.add(type, {
      hs_timestamp: romeToIso(parseLocalDate(row.data)),
      [activityBody[type]]: row.testo ?? "",
      autore: users.authorEmail(row.id_utente),
      id_legacy: row.id_attivita!,
    });
    const [toContact, toDeal] = activityLinks[type];
    const contact = contacts.get(row.id_contatto ?? "");
    if (contact) model.link(activity, contact, toContact);
    const deal = deals.get(row.id_opportunita ?? "");
    if (deal) model.link(activity, deal, toDeal);
  }
  model.stats.activityDuplicates = duplicates;
}
