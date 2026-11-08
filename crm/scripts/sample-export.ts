// Builds sample/sample-export.zip from the synthetic CSVs in sample/sinergia-export/.
// The files are re-encoded to Windows-1252, as the real Sinergia export is, so the migration
// reads them exactly like the original. All data in the sample is invented.
// Run: npx tsx scripts/sample-export.ts
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";
import iconv from "iconv-lite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "sample");
const source = join(root, "sinergia-export");
const files: Record<string, Uint8Array> = {};
for (const name of readdirSync(source).filter((file) => file.endsWith(".csv"))) {
  const text = readFileSync(join(source, name), "utf8").replace(/\r?\n/g, "\r\n");
  files[`sinergia-export/${name}`] = new Uint8Array(iconv.encode(text, "win1252"));
}
const out = join(root, "sample-export.zip");
writeFileSync(out, zipSync(files));
console.log(`wrote ${out} (${Object.keys(files).length} files)`);
