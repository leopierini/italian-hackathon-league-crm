export type CsvRow = Record<string, string>;

// RFC 4180 parser with a configurable separator. Quoted fields may contain the separator,
// newlines and doubled quotes. Every value is trimmed; CRLF inside values becomes LF.
export function parseCsv(text: string, separator = ";"): CsvRow[] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let inQuotes = false;
  const sep = separator.charCodeAt(0);
  const special = new RegExp(`[${separator.replace(/[\\\]^-]/g, "\\$&")}\\r\\n"]`, "g");
  const length = text.length;
  let i = 0;

  const endRecord = () => {
    record.push(field); field = "";
    if (record.length > 1 || record[0] !== "") records.push(record);
    record = [];
  };

  while (i < length) {
    if (inQuotes) {
      const next = text.indexOf('"', i);
      if (next === -1) { field += text.slice(i); i = length; continue; }
      field += text.slice(i, next);
      if (text.charCodeAt(next + 1) === 34) { field += '"'; i = next + 2; continue; }
      inQuotes = false; i = next + 1; continue;
    }
    special.lastIndex = i;
    const match = special.exec(text);
    const end = match ? match.index : length;
    if (end > i) { field += text.slice(i, end); i = end; continue; }
    const code = text.charCodeAt(i);
    if (code === 34) {
      if (field.trim() === "") { field = ""; inQuotes = true; } else { field += '"'; }
      i += 1;
    } else if (code === sep) {
      record.push(field); field = ""; i += 1;
    } else {
      endRecord();
      i += code === 13 && text.charCodeAt(i + 1) === 10 ? 2 : 1;
    }
  }
  if (field !== "" || record.length > 0) endRecord();

  const header = (records.shift() ?? []).map((name) => name.trim().toLowerCase());
  return records.map((values) => {
    const row: CsvRow = {};
    for (let c = 0; c < header.length; c += 1) {
      const raw = values[c] ?? "";
      row[header[c]!] = raw.includes("\r") ? raw.replace(/\r\n?/g, "\n").trim() : raw.trim();
    }
    return row;
  });
}
