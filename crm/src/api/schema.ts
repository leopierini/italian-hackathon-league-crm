// Object types, default properties and property groups of a fresh account (2026-09 docs).

export const objectTypes = [
  "contacts", "companies", "deals", "tickets", "products", "line_items",
  "notes", "calls", "emails", "meetings", "tasks",
] as const;
export type ObjectType = typeof objectTypes[number];

export const objectTypeIds: Record<ObjectType, string> = {
  contacts: "0-1", companies: "0-2", deals: "0-3", tickets: "0-5", products: "0-7", line_items: "0-8",
  notes: "0-46", calls: "0-48", emails: "0-49", meetings: "0-47", tasks: "0-27",
};

const aliases: Record<string, ObjectType> = {};
for (const type of objectTypes) {
  aliases[type] = type;
  aliases[type.replace(/s$/, "")] = type;
  aliases[objectTypeIds[type]] = type;
}
Object.assign(aliases, { company: "companies", line_item: "line_items", lineitem: "line_items", lineitems: "line_items" });

// "contacts", "contact", "CONTACT", "0-1" -> "contacts". Undefined when unknown.
export function resolveObjectType(raw: string | undefined): ObjectType | undefined {
  return raw ? aliases[raw.toLowerCase()] : undefined;
}

// Singular name used in association type names ("contact_to_company").
export const singular = (type: ObjectType) => (type === "companies" ? "company" : type.replace(/s$/, ""));

// System properties computed from columns, never stored in `properties`.
export const lastModifiedName = (type: ObjectType) => (type === "contacts" ? "lastmodifieddate" : "hs_lastmodifieddate");
export const readOnlyProperties = new Set(["hs_object_id", "lastmodifieddate", "hs_lastmodifieddate", "hs_createdate"]);

// Properties returned when the request does not name any (as in the docs).
export const defaultReturned: Record<ObjectType, string[]> = {
  contacts: ["createdate", "email", "firstname", "hs_object_id", "lastmodifieddate", "lastname"],
  companies: ["createdate", "domain", "hs_lastmodifieddate", "hs_object_id", "name"],
  deals: ["amount", "closedate", "createdate", "dealname", "dealstage", "hs_lastmodifieddate", "hs_object_id", "pipeline"],
  tickets: ["content", "createdate", "hs_lastmodifieddate", "hs_object_id", "hs_pipeline", "hs_pipeline_stage", "hs_ticket_category", "hs_ticket_priority", "subject"],
  products: ["createdate", "description", "hs_lastmodifieddate", "hs_object_id", "name", "price"],
  line_items: ["amount", "createdate", "description", "discount", "hs_lastmodifieddate", "hs_object_id", "hs_product_id", "name", "price", "quantity"],
  notes: ["hs_createdate", "hs_lastmodifieddate", "hs_object_id"],
  calls: ["hs_createdate", "hs_lastmodifieddate", "hs_object_id"],
  emails: ["hs_createdate", "hs_lastmodifieddate", "hs_object_id"],
  meetings: ["hs_createdate", "hs_lastmodifieddate", "hs_object_id"],
  tasks: ["hs_createdate", "hs_lastmodifieddate", "hs_object_id"],
};

// Free-text `query` of the search endpoint looks in these properties.
export const queryProperties: Record<ObjectType, string[]> = {
  contacts: ["firstname", "lastname", "email", "phone", "mobilephone", "company", "hs_additional_emails"],
  companies: ["name", "domain", "website", "phone", "hs_additional_domains"],
  deals: ["dealname"],
  tickets: ["subject", "content"],
  products: ["name", "description", "hs_sku"],
  line_items: ["name", "description", "hs_sku"],
  notes: ["hs_note_body"],
  calls: ["hs_call_title", "hs_call_body"],
  emails: ["hs_email_subject", "hs_email_text"],
  meetings: ["hs_meeting_title", "hs_meeting_body"],
  tasks: ["hs_task_subject", "hs_task_body"],
};

export type PropertySeed = {
  objectType: ObjectType; name: string; label: string; type: string; fieldType: string;
  groupName: string; options: Array<{ label: string; value: string; displayOrder: number; hidden: boolean }>;
};

const fieldTypes: Record<string, [string, string]> = {
  s: ["string", "text"], t: ["string", "textarea"], p: ["string", "phonenumber"], n: ["number", "number"],
  d: ["datetime", "date"], D: ["date", "date"], e: ["enumeration", "select"], b: ["bool", "booleancheckbox"],
};

const optionLists: Record<string, string[]> = {
  lifecyclestage: ["subscriber", "lead", "marketingqualifiedlead", "salesqualifiedlead", "opportunity", "customer", "evangelist", "other"],
  hs_lead_status: ["NEW", "OPEN", "IN_PROGRESS", "OPEN_DEAL", "UNQUALIFIED", "ATTEMPTED_TO_CONTACT", "CONNECTED", "BAD_TIMING"],
  hs_ticket_priority: ["LOW", "MEDIUM", "HIGH", "URGENT"],
  hs_ticket_category: ["PRODUCT_ISSUE", "BILLING_ISSUE", "FEATURE_REQUEST", "GENERAL_INQUIRY"],
  hs_task_status: ["NOT_STARTED", "IN_PROGRESS", "WAITING", "COMPLETED", "DEFERRED"],
  hs_task_priority: ["NONE", "LOW", "MEDIUM", "HIGH"],
  hs_task_type: ["CALL", "EMAIL", "LINKED_IN", "MEETING", "LINKED_IN_CONNECT", "LINKED_IN_MESSAGE", "TODO"],
  deal_currency_code: ["EUR", "USD", "GBP"],
  dealtype: ["newbusiness", "existingbusiness"],
  hs_priority: ["low", "medium", "high"],
  hs_call_direction: ["INBOUND", "OUTBOUND"],
  hs_call_status: ["BUSY", "CALLING_CRM_USER", "CANCELED", "COMPLETED", "CONNECTING", "FAILED", "IN_PROGRESS", "NO_ANSWER", "QUEUED", "RINGING"],
  hs_email_direction: ["EMAIL", "INCOMING_EMAIL", "FORWARDED_EMAIL"],
  hs_email_status: ["BOUNCED", "FAILED", "SCHEDULED", "SENDING", "SENT"],
  hs_meeting_outcome: ["SCHEDULED", "COMPLETED", "RESCHEDULED", "NO_SHOW", "CANCELED"],
  type: ["PROSPECT", "PARTNER", "RESELLER", "VENDOR", "OTHER"],
  industry: [],
};

const groups: Record<ObjectType, string> = {
  contacts: "contactinformation", companies: "companyinformation", deals: "dealinformation",
  tickets: "ticketinformation", products: "productinformation", line_items: "lineiteminformation",
  notes: "engagement", calls: "call", emails: "email", meetings: "meeting", tasks: "task",
};

export const defaultGroups: Array<{ objectType: ObjectType; name: string; label: string }> = objectTypes.map((objectType) => ({
  objectType, name: groups[objectType],
  label: { contacts: "Contact information", companies: "Company information", deals: "Deal information",
    tickets: "Ticket information", products: "Product information", line_items: "Line item information",
    notes: "Note information", calls: "Call information", emails: "Email information",
    meetings: "Meeting information", tasks: "Task information" }[objectType],
}));

const common = "createdate:d hs_lastmodifieddate:d hs_object_id:n hubspot_owner_id:e";
const activity = "hs_createdate:d hs_lastmodifieddate:d hs_object_id:n hubspot_owner_id:e hs_timestamp:d hs_attachment_ids:s";
const specs: Record<ObjectType, string> = {
  contacts: `firstname lastname email phone:p mobilephone:p company website jobtitle lifecyclestage:e hs_lead_status:e
    address city state zip country fax industry annualrevenue numemployees salutation date_of_birth message:t
    hs_additional_emails hs_email_domain associatedcompanyid:n num_associated_deals:n notes_last_updated:d closedate:d
    twitterhandle hs_language createdate:d lastmodifieddate:d hs_object_id:n hubspot_owner_id:e`,
  companies: `name domain website phone:p address address2 city state zip country industry:e description:t
    numberofemployees:n annualrevenue:n type:e lifecyclestage:e hs_lead_status:e hs_additional_domains founded_year
    timezone linkedin_company_page facebook_company_page twitterhandle about_us:t is_public:b total_revenue:n
    num_associated_contacts:n num_associated_deals:n closedate:d notes_last_updated:d ${common}`,
  deals: `dealname amount:n dealstage:e pipeline:e closedate:d dealtype:e description:t deal_currency_code:e hs_priority:e
    hs_deal_stage_probability:n amount_in_home_currency:n hs_forecast_amount:n hs_forecast_probability:n hs_next_step:t
    hs_is_closed:b hs_is_closed_won:b num_associated_contacts:n notes_last_updated:d ${common}`,
  tickets: `subject content:t hs_pipeline:e hs_pipeline_stage:e hs_ticket_priority:e hs_ticket_category:e source_type:e
    closed_date:d hs_resolution:e time_to_close:n ${common}`,
  products: `name description:t price:n hs_sku hs_cost_of_goods_sold:n hs_recurring_billing_period recurringbillingfrequency:e
    hs_product_type:e hs_url tax:n ${common}`,
  line_items: `name description:t quantity:n price:n amount:n discount:n hs_discount_percentage:n hs_product_id hs_sku
    hs_line_item_currency_code:e recurringbillingfrequency:e hs_recurring_billing_period hs_cost_of_goods_sold:n
    hs_position_on_quote:n hs_total_discount:n tax:n ${common}`,
  notes: `hs_note_body:t ${activity}`,
  calls: `hs_call_body:t hs_call_title hs_call_direction:e hs_call_disposition hs_call_duration:n hs_call_status:e
    hs_call_from_number hs_call_to_number hs_call_recording_url ${activity}`,
  emails: `hs_email_subject hs_email_text:t hs_email_html:t hs_email_direction:e hs_email_status:e hs_email_headers:t
    hs_email_sender_email hs_email_to_email ${activity}`,
  meetings: `hs_meeting_title hs_meeting_body:t hs_internal_meeting_notes:t hs_meeting_start_time:d hs_meeting_end_time:d
    hs_meeting_location hs_meeting_outcome:e hs_meeting_external_url ${activity}`,
  tasks: `hs_task_subject hs_task_body:t hs_task_status:e hs_task_priority:e hs_task_type:e hs_task_completion_date:d
    hs_queue_membership_ids ${activity}`,
};

const special: Record<string, string> = {
  hs_object_id: "Record ID", createdate: "Create date", hs_createdate: "Create date",
  lastmodifieddate: "Last modified date", hs_lastmodifieddate: "Last modified date",
  hubspot_owner_id: "Owner", dealname: "Deal name", dealstage: "Deal stage", closedate: "Close date",
  hs_pipeline_stage: "Ticket status", hs_timestamp: "Activity date", firstname: "First name", lastname: "Last name",
  lifecyclestage: "Lifecycle stage", hs_ticket_priority: "Priority", subject: "Ticket name", content: "Ticket description",
  domain: "Company domain name", hs_additional_domains: "Additional domains", hs_sku: "SKU",
  hs_discount_percentage: "Discount percentage", deal_currency_code: "Currency", closed_date: "Close date",
};

const labelOf = (name: string) => special[name]
  ?? name.replace(/^hs_/, "").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

export const defaultPropertySeeds: PropertySeed[] = objectTypes.flatMap((objectType) =>
  specs[objectType].split(/\s+/).filter(Boolean).map((spec) => {
    const [name, code = "s"] = spec.split(":") as [string, string?];
    const [type, fieldType] = fieldTypes[code]!;
    const values = optionLists[name] ?? [];
    return {
      objectType, name, label: labelOf(name), type, fieldType, groupName: groups[objectType],
      options: values.map((value, displayOrder) => ({ label: value, value, displayOrder, hidden: false })),
    };
  }));
