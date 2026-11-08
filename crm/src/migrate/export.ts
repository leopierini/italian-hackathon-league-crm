import { unzipSync } from "fflate";
import iconv from "iconv-lite";
import { parseCsv, type CsvRow } from "./csv.js";

export const exportFiles = [
  "utenti", "aziende", "contatti", "opportunita", "storico_fasi",
  "listino", "righe_offerta", "ticket", "attivita",
] as const;
export type ExportFile = typeof exportFiles[number];
export type ExportData = Record<ExportFile, CsvRow[]>;

// First column of each file's header, used when an archive names a file differently.
const signatures: Array<[ExportFile, (header: string) => boolean]> = [
  ["utenti", (h) => h.startsWith("id_utente;")],
  ["aziende", (h) => h.startsWith("id_azienda;")],
  ["contatti", (h) => h.startsWith("id_contatto;")],
  ["storico_fasi", (h) => h.startsWith("id_opportunita;") && h.includes("fase_nuova")],
  ["opportunita", (h) => h.startsWith("id_opportunita;")],
  ["listino", (h) => h.startsWith("codice_articolo;")],
  ["righe_offerta", (h) => h.startsWith("id_riga;")],
  ["ticket", (h) => h.startsWith("id_ticket;")],
  ["attivita", (h) => h.startsWith("id_attivita;")],
];

export async function downloadExport(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Export download failed: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

function decode(bytes: Uint8Array): string {
  // Sinergia writes Windows-1252; fall back to UTF-8 only when the bytes are valid UTF-8 with
  // multi-byte sequences (a re-saved file), since cp1252 accepts any byte sequence.
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return utf8.decode(bytes);
  return iconv.decode(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), "win1252");
}

const cp1252Encoder = (value: string) => iconv.encode(value, "win1252");
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

// Some rows were saved as UTF-8 inside the cp1252 file ("MosÃ¨" for "Mosè"). Re-encode such
// values to bytes and read them as UTF-8; keep the value when that does not decode cleanly.
export function fixMojibake(original: string): string {
  // "à" is C3 A0 in UTF-8; A0 is a no-break space in cp1252 and trimming removed it at the end.
  const value = original.endsWith("\u00c3") ? `${original}\u00a0` : original;
  if (!/[\u00c3\u00c2\u00e2][\u0080-\u00bf\u0152\u0153\u0160\u0161\u0178\u017d\u017e\u0192\u02c6\u02dc\u2013-\u203a\u20ac\u2122]/.test(value)) return original;
  try {
    const repaired = strictUtf8.decode(cp1252Encoder(value));
    return repaired.includes("\ufffd") ? original : repaired.trim();
  } catch {
    return original;
  }
}

function repairRows(rows: CsvRow[]): number {
  let repaired = 0;
  for (const row of rows) {
    for (const key in row) {
      const value = row[key]!;
      if (value.length && /[ÃÂâ]/.test(value)) {
        const fixed = fixMojibake(value);
        if (fixed !== value) { row[key] = fixed; repaired += 1; }
      }
    }
  }
  return repaired;
}

export const repairedValues: Partial<Record<ExportFile, number>> = {};

export function readExport(zipBytes: Uint8Array): ExportData {
  const entries = unzipSync(zipBytes, {
    filter: (file) => /\.csv$/i.test(file.name) && !file.name.startsWith("__MACOSX/"),
  });
  const data = Object.fromEntries(exportFiles.map((name) => [name, [] as CsvRow[]])) as ExportData;
  const found = new Set<ExportFile>();
  for (const [path, bytes] of Object.entries(entries)) {
    const text = decode(bytes);
    const base = path.split("/").pop()!.replace(/\.csv$/i, "").toLowerCase();
    const header = text.slice(0, 300).replace(/^﻿/, "").split(/\r?\n/)[0]!.toLowerCase().replace(/\s+/g, "");
    const name = (exportFiles as readonly string[]).includes(base)
      ? base as ExportFile
      : signatures.find(([, test]) => test(header))?.[0];
    if (!name || found.has(name)) continue;
    found.add(name);
    data[name] = parseCsv(text);
    repairedValues[name] = repairRows(data[name]);
  }
  const missing = exportFiles.filter((name) => !found.has(name));
  if (missing.length) throw new Error(`Export is missing files: ${missing.join(", ")}`);
  return data;
}
