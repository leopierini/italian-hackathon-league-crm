import type { PoolClient } from "pg";
import { assocTypes } from "./model.js";
import { renewalStages, ticketStages } from "./normalize.js";

type Prop = { objectType: string; name: string; label: string; type: string; fieldType: string; unique?: boolean };

const activityTypes = ["notes", "calls", "emails", "meetings"];
const legacyTypes = ["companies", "contacts", "deals", "line_items", "tickets", ...activityTypes];

// Brambilla properties (appendix of the client's requests): created or updated by the migration.
const brambilla: Prop[] = [
  ...legacyTypes.map((objectType) => ({ objectType, name: "id_legacy", label: "Sinergia ID", type: "string", fieldType: "text" })),
  { objectType: "deals", name: "commerciale", label: "Commerciale", type: "string", fieldType: "text" },
  { objectType: "tickets", name: "assegnatario", label: "Assegnatario", type: "string", fieldType: "text" },
  ...activityTypes.map((objectType) => ({ objectType, name: "autore", label: "Autore", type: "string", fieldType: "text" })),
  { objectType: "companies", name: "partita_iva", label: "Partita IVA", type: "string", fieldType: "text", unique: true },
  { objectType: "companies", name: "fatturato_2025", label: "Fatturato 2025", type: "number", fieldType: "number" },
  { objectType: "companies", name: "classe_cliente", label: "Classe cliente", type: "string", fieldType: "text" },
];

// Standard properties the migration writes; added only if the account does not have them yet.
const standard: Prop[] = [
  { objectType: "companies", name: "hs_additional_domains", label: "Additional domains", type: "string", fieldType: "text" },
  { objectType: "contacts", name: "hs_additional_emails", label: "Additional email addresses", type: "string", fieldType: "text" },
  { objectType: "deals", name: "deal_currency_code", label: "Currency", type: "enumeration", fieldType: "select" },
  { objectType: "tickets", name: "createdate", label: "Create date", type: "datetime", fieldType: "date" },
  { objectType: "tickets", name: "closed_date", label: "Close date", type: "datetime", fieldType: "date" },
  { objectType: "products", name: "hs_sku", label: "SKU", type: "string", fieldType: "text" },
  { objectType: "line_items", name: "name", label: "Name", type: "string", fieldType: "text" },
  { objectType: "line_items", name: "hs_discount_percentage", label: "Discount percentage", type: "number", fieldType: "number" },
  { objectType: "line_items", name: "hs_product_id", label: "Product ID", type: "string", fieldType: "text" },
  { objectType: "line_items", name: "amount", label: "Net price", type: "number", fieldType: "number" },
  ...activityTypes.map((objectType) => ({ objectType, name: "hs_timestamp", label: "Activity date", type: "datetime", fieldType: "date" })),
  { objectType: "emails", name: "hs_email_text", label: "Email body", type: "string", fieldType: "textarea" },
  { objectType: "meetings", name: "hs_meeting_body", label: "Meeting description", type: "string", fieldType: "textarea" },
  { objectType: "tasks", name: "hs_timestamp", label: "Due date", type: "datetime", fieldType: "date" },
];

const renewalProbability = [0.2, 0.6, 1, 0];

export const renewalsPipelineId = "Rinnovi";
export const supportPipelineId = "Assistenza";

export async function createBrambillaSchema(client: PoolClient): Promise<void> {
  for (const [props, overwrite] of [[brambilla, true], [standard, false]] as const) {
    for (const p of props) {
      await client.query(
        `INSERT INTO property_definitions (object_type, name, label, type, field_type, has_unique_value, options)
         VALUES ($1, $2, $3, $4, $5, $6, '[]'::jsonb)
         ON CONFLICT (object_type, name) DO ${overwrite
           ? "UPDATE SET label = EXCLUDED.label, type = EXCLUDED.type, field_type = EXCLUDED.field_type, has_unique_value = EXCLUDED.has_unique_value"
           : "NOTHING"}`,
        [p.objectType, p.name, p.label, p.type, p.fieldType, p.unique ?? false],
      );
    }
  }

  const plural: Record<string, string> = {
    contact: "contacts", company: "companies", deal: "deals", ticket: "tickets", line_item: "line_items",
    product: "products", note: "notes", call: "calls", email: "emails", meeting: "meetings", task: "tasks",
  };
  for (const [pair, [forward, backward]] of Object.entries(assocTypes)) {
    const [from, to] = Object.keys(plural).filter((k) => pair.startsWith(`${k}_`) || pair.endsWith(`_${k}`))
      .sort((a, b) => pair.indexOf(a) - pair.indexOf(b)).map((k) => plural[k]!);
    for (const [a, b, typeId] of [[from, to, forward], [to, from, backward]] as const) {
      await client.query(
        `INSERT INTO association_types (from_object_type, to_object_type, type_id, label) VALUES ($1, $2, $3, '')
         ON CONFLICT DO NOTHING`, [a, b, String(typeId)]);
    }
  }

  const renewals = renewalStages.map((label, displayOrder) => ({
    id: label, label, displayOrder,
    probability: renewalProbability[displayOrder], closed: displayOrder >= 2,
    metadata: { probability: String(renewalProbability[displayOrder]), isClosed: String(displayOrder >= 2) },
  }));
  const support = ticketStages.map((label, displayOrder) => ({
    id: label, label, displayOrder, closed: label === "Chiuso",
    metadata: { ticketState: label === "Chiuso" ? "CLOSED" : "OPEN", isClosed: String(label === "Chiuso") },
  }));
  for (const [objectType, id, stages] of [["deals", renewalsPipelineId, renewals], ["tickets", supportPipelineId, support]] as const) {
    await client.query(
      `INSERT INTO pipelines (object_type, pipeline_id, label, stages) VALUES ($1, $2, $2, $3::jsonb)
       ON CONFLICT (object_type, pipeline_id) DO UPDATE SET label = EXCLUDED.label, stages = EXCLUDED.stages`,
      [objectType, id, JSON.stringify(stages)],
    );
  }
}
