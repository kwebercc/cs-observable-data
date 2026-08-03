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
// Shared helpers
// ---------------------------------------------------------------------------

const pad = n => String(n).padStart(2, "0");

/** Splits a GML text file into whitespace-delimited rows, skipping "#" comments. */
function gmlRows(text, columns) {
  return text.split(/\r?\n/).flatMap(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return [];

    const cols = trimmed.split(/\s+/);
    const row = {};
    columns.forEach((name, i) => {
      row[name] = cols[i] === undefined ? null : Number(cols[i]);
    });
    return [row];
  });
}

function toCsv(rows, fields) {
  return [
    fields.join(","),
    ...rows.map(r => fields.map(f => r[f]).join(","))
  ].join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// GML monthly means (CO2 Mauna Loa, CH4 global, N2O global)
// ---------------------------------------------------------------------------

const GML_GLOBAL = ["year", "month", "decimal", "average", "average_unc", "trend", "trend_unc"];
const GML_CO2_MLO = ["year", "month", "decimal", "average", "deseasonalized", "ndays", "stdev_days", "unc_month_mean"];

function parseGmlMonthly(text, columns) {
  return gmlRows(text, columns)
    .filter(r =>
      Number.isFinite(r.year) && Number.isFinite(r.month) &&
      r.year > 1900 && r.month >= 1 && r.month <= 12 &&
      r.average > 0                      // rejects missing-value sentinels
    )
    .map(r => ({ ...r, date: `${r.year}-${pad(r.month)}-01` }))
    .sort((a, b) => a.decimal - b.decimal);
}

// ---------------------------------------------------------------------------
// GML weekly CO2 (Mauna Loa)
// ---------------------------------------------------------------------------

// The file carries a few more trailing columns (1-yr-ago, 10-yr-ago, increase
// since 1800); naming the first six is enough, the rest are ignored.
const GML_CO2_WEEKLY = ["year", "month", "day", "decimal_date", "ppm", "n_days"];

const isMissingPpm = v => !Number.isFinite(v) || v < 0;   // NOAA flags gaps as -999.99

/**
 * Fills runs of missing weeks by interpolating between the last good value
 * before the gap and the first good value after it, and flags what it touched.
 * For a single missing week this is the midpoint of its two neighbours.
 */
function fillGaps(rows) {
  for (let i = 0; i < rows.length; i++) {
    if (!isMissingPpm(rows[i].ppm)) continue;

    let end = i;
    while (end + 1 < rows.length && isMissingPpm(rows[end + 1].ppm)) end++;

    const before = i > 0 ? rows[i - 1].ppm : null;
    const after = end + 1 < rows.length ? rows[end + 1].ppm : null;

    for (let j = i; j <= end; j++) {
      let fill;
      if (before !== null && after !== null) {
        const t = (j - i + 1) / (end - i + 2);
        fill = before + (after - before) * t;
      } else {
        fill = before ?? after ?? null;   // gap runs off one end of the series
      }
      rows[j].ppm = fill === null ? null : Math.round(fill * 100) / 100;
      rows[j].imputed = 1;
    }
    i = end;   // skip past the run we just filled
  }
  return rows;
}

function parseCo2Weekly(text) {
  const rows = gmlRows(text, GML_CO2_WEEKLY)
    .filter(r =>
      Number.isFinite(r.year) && Number.isFinite(r.month) && Number.isFinite(r.day) &&
      r.year > 1900
    )
    .map(r => ({ ...r, date: `${r.year}-${pad(r.month)}-${pad(r.day)}`, imputed: 0 }))
    .sort((a, b) => a.decimal_date - b.decimal_date);

  return fillGaps(rows);
}

// ---------------------------------------------------------------------------
// Validation by parsing: if we can't pull at least `min` clean rows out of the
// payload, it isn't the file we wanted. An HTML error page, a truncated
// response, and a swapped URL all fail this.
// ---------------------------------------------------------------------------

const sniffMonthly = (columns, min) =>
  buf => parseGmlMonthly(buf.toString("utf8"), columns).length >= min;

const sniffWeekly = min =>
  buf => parseCo2Weekly(buf.toString("utf8")).length >= min;

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
    // Three fields, not four — rejects ONI's text if the URL ever gets swapped.
    sniff: buf => /^\s*DJF\s+1950\s+-?\d+\.\d+\s*$/m.test(buf.toString("utf8").slice(0, 500))
  },
  {
    name: "co2",
    url: "https://gml.noaa.gov/webdata/ccgg/trends/co2/co2_mm_mlo.txt",
    file: "data/co2_mm_mlo.txt",
    derived: "data/co2.csv",
    minBytes: 5000,
    sniff: sniffMonthly(GML_CO2_MLO, 500),        // record starts 1958
    transform: buf => toCsv(
      parseGmlMonthly(buf.toString("utf8"), GML_CO2_MLO),
      [...GML_CO2_MLO, "date"]
    )
  },
  {
    name: "ch4",
    url: "https://gml.noaa.gov/webdata/ccgg/trends/ch4/ch4_mm_gl.txt",
    file: "data/ch4_mm_gl.txt",
    derived: "data/ch4.csv",
    minBytes: 5000,
    sniff: sniffMonthly(GML_GLOBAL, 300),         // record starts 1983
    transform: buf => toCsv(
      parseGmlMonthly(buf.toString("utf8"), GML_GLOBAL),
      [...GML_GLOBAL, "date"]
    )
  },
  {
    name: "n2o",
    url: "https://gml.noaa.gov/webdata/ccgg/trends/n2o/n2o_mm_gl.txt",
    file: "data/n2o_mm_gl.txt",
    derived: "data/n2o.csv",
    minBytes: 5000,
    sniff: sniffMonthly(GML_GLOBAL, 150),         // record starts 2001
    transform: buf => toCsv(
      parseGmlMonthly(buf.toString("utf8"), GML_GLOBAL),
      [...GML_GLOBAL, "date"]
    )
  },
  {
    name: "co2_weekly",
    url: "https://gml.noaa.gov/webdata/ccgg/trends/co2/co2_weekly_mlo.txt",
    file: "data/co2_weekly_mlo.txt",
    derived: "data/co2_weekly.csv",
    minBytes: 5000,
    sniff: sniffWeekly(1000),                     // record starts 1974
    transform: buf => toCsv(
      parseCo2Weekly(buf.toString("utf8")),
      [...GML_CO2_WEEKLY, "date", "imputed"]
    )
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
