#!/usr/bin/env node
/**
 * Fetches each source, validates it, and writes it into data/ only if it
 * passes. Sources with a `transform` also get a parsed CSV written alongside
 * the raw mirror. Records outcomes in data/manifest.json either way.
 *
 * Always exits 0 — the workflow commits the manifest first, then checks it
 * and fails the run afterward, so a failure is still recorded in git.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// GML monthly-mean parsing
// ---------------------------------------------------------------------------

// Column layouts differ between the global trace-gas files and Mauna Loa CO2.
const GML_GLOBAL = ["year", "month", "decimal", "average", "average_unc", "trend", "trend_unc"];
const GML_CO2_MLO = ["year", "month", "decimal", "average", "deseasonalized", "ndays", "stdev_days", "unc_month_mean"];

/**
 * Parses a GML monthly-mean text file into row objects.
 * Skips the leading "#" comment block, blank lines, and rows carrying GML's
 * negative missing-value sentinels (-9.99 / -99.99).
 */
function parseGml(text, columns) {
  return text.split(/\r?\n/).flatMap(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return [];

    const cols = trimmed.split(/\s+/);
    const row = {};
    columns.forEach((name, i) => {
      row[name] = cols[i] === undefined ? null : Number(cols[i]);
    });

    if (!Number.isFinite(row.year) || !Number.isFinite(row.month)) return [];
    if (row.year < 1900 || row.month < 1 || row.month > 12) return [];
    if (!(row.average > 0)) return [];   // catches missing-value sentinels

    row.date = `${row.year}-${String(row.month).padStart(2, "0")}-01`;
    return [row];
  }).sort((a, b) => a.decimal - b.decimal);
}

function toCsv(rows, columns) {
  const fields = [...columns, "date"];
  return [
    fields.join(","),
    ...rows.map(r => fields.map(f => r[f]).join(","))
  ].join("\n") + "\n";
}

/**
 * Validation by parsing: if we can't pull at least `min` clean rows out of the
 * payload, it isn't the file we wanted. Stronger than a regex — an HTML error
 * page, a truncated response, and a swapped URL all fail this.
 */
const gmlSniff = (columns, min = 50) =>
  buf => parseGml(buf.toString("utf8"), columns).length >= min;

const gmlTransform = columns =>
  buf => toCsv(parseGml(buf.toString("utf8"), columns), columns);

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

const SOURCES = [
  {
    name: "oni",
    url: "https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt",
    file: "data/oni.txt",
    minBytes: 5000,
    sniff: buf => /\bDJF\s+1950\b/.test(buf.toString("utf8").slice(0, 500))
  },
  {
    name: "roni",
    url: "https://www.cpc.ncep.noaa.gov/data/indices/RONI.ascii.txt",
    file: "data/roni.txt",
    minBytes: 5000,
    // Three fields, not four — this would reject ONI's text if the URL got swapped.
    sniff: buf => /^\s*DJF\s+1950\s+-?\d+\.\d+\s*$/m.test(buf.toString("utf8").slice(0, 500))
  },
  {
    name: "co2",
    url: "https://gml.noaa.gov/webdata/ccgg/trends/co2/co2_mm_mlo.txt",
    file: "data/co2_mm_mlo.txt",
    derived: "data/co2.csv",
    minBytes: 5000,
    sniff: gmlSniff(GML_CO2_MLO, 500),      // record starts 1958
    transform: gmlTransform(GML_CO2_MLO)
  },
  {
    name: "ch4",
    url: "https://gml.noaa.gov/webdata/ccgg/trends/ch4/ch4_mm_gl.txt",
    file: "data/ch4_mm_gl.txt",
    derived: "data/ch4.csv",
    minBytes: 5000,
    sniff: gmlSniff(GML_GLOBAL, 300),       // record starts 1983
    transform: gmlTransform(GML_GLOBAL)
  },
  {
    name: "n2o",
    url: "https://gml.noaa.gov/webdata/ccgg/trends/n2o/n2o_mm_gl.txt",
    file: "data/n2o_mm_gl.txt",
    derived: "data/n2o.csv",
    minBytes: 5000,
    sniff: gmlSniff(GML_GLOBAL, 150),       // record starts 2001
    transform: gmlTransform(GML_GLOBAL)
  }
];

// ---------------------------------------------------------------------------

const MANIFEST = "data/manifest.json";
const MAX_SHRINK = 0.5;   // reject a file that's less than half its old size

// Ensure data/ exists even if every source fails, so the manifest write below
// can't die with ENOENT. No-op once the folder is there.
await mkdir("data", { recursive: true });

const manifest = existsSync(MANIFEST)
  ? JSON.parse(await readFile(MANIFEST, "utf8"))
  : {};

const now = new Date().toISOString();

for (const src of SOURCES) {
  const entry = (manifest[src.name] ??= {});
  entry.url = src.url;
  entry.last_checked = now;

  try {
    const res = await fetch(src.url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const buf = Buffer.from(await res.arrayBuffer());

    // --- Validation gauntlet ---
    if (buf.length < src.minBytes) {
      throw new Error(`too small: ${buf.length} bytes`);
    }
    if (!src.sniff(buf)) {
      throw new Error("content did not match expected shape");
    }

    let changed = true;
    if (existsSync(src.file)) {
      const old = await readFile(src.file);
      // Records only grow. A sudden shrink means truncation upstream.
      if (buf.length < old.length * MAX_SHRINK) {
        throw new Error(`suspicious shrink: ${old.length} -> ${buf.length} bytes`);
      }
      changed = !buf.equals(old);
    }

    await mkdir(path.dirname(src.file), { recursive: true });

    if (changed) {
      await writeFile(src.file, buf);
      entry.last_changed = now;
      entry.bytes = buf.length;
    }

    // Regenerate derived output when the raw changed, or if it's missing
    // (first run after adding a transform to an already-mirrored source).
    if (src.transform && (changed || !existsSync(src.derived))) {
      const csv = src.transform(buf);
      await writeFile(src.derived, csv);
      entry.rows = csv.trimEnd().split("\n").length - 1;
    }

    entry.status = "ok";
    delete entry.error;
    console.log(`${src.name}: ${changed ? "updated" : "unchanged"} (${buf.length} bytes)`);

  } catch (err) {
    // Note what failed, but leave the existing good file untouched.
    entry.status = "failed";
    entry.error = String(err.message);
    console.error(`${src.name}: FAILED — ${err.message}`);
  }
}

await writeFile(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
