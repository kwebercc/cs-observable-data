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
// NCEI Climate at a Glance JSON
// ---------------------------------------------------------------------------

/**
 * CAG payloads are { description: {...}, data: { "<period>": {value, anomaly} } }.
 * Period keys are a 4-digit year, sometimes with a 2-digit month suffix, so we
 * take the year off the front and keep the raw key too.
 */
function parseCag(text) {
  const json = JSON.parse(text);
  if (!json.data || typeof json.data !== "object") {
    throw new Error("payload has no data object");
  }
  return Object.entries(json.data)
    .map(([period, v]) => ({
      period,
      year: Number(String(period).slice(0, 4)),
      value: v?.value === undefined ? null : Number(v.value),
      anomaly: v?.anomaly === undefined ? null : Number(v.anomaly)
    }))
    .filter(r => Number.isFinite(r.year))
    .sort((a, b) => a.year - b.year);
}

const sniffCag = min => buf => {
  try {
    return parseCag(buf.toString("utf8")).length >= min;
  } catch {
    return false;   // not JSON at all, or wrong shape
  }
};

const transformCag = buf =>
  toCsv(parseCag(buf.toString("utf8")), ["period", "year", "value", "anomaly"]);

// ---------------------------------------------------------------------------
// Climate Reanalyzer daily SST
// ---------------------------------------------------------------------------

// Payload is an array of series: [{ name: "2026", data: [366 daily values] }, ...]
// with extra entries for the climatological mean and sigma bands.
const sniffSst = buf => {
  try {
    const json = JSON.parse(buf.toString("utf8"));
    return Array.isArray(json) &&
      json.length >= 20 &&
      json.some(s => Array.isArray(s?.data) && s.data.length >= 365);
  } catch {
    return false;   // not JSON at all, or wrong shape
  }
};

// ---------------------------------------------------------------------------
// University of Colorado global mean sea level
// ---------------------------------------------------------------------------

// The release is baked into both the directory and the filename
// (.../2026_rel1/gmsl_2026rel1_seasons_rmvd.txt) and rolls over a few times a
// year, so the URL has to be discovered rather than hardcoded. The MIRRORED
// filename stays fixed, so notebooks never have to care.
const GMSL_TEMPLATE = (y, rel) =>
  `https://sealevel.colorado.edu/files/${y}_rel${rel}/gmsl_${y}rel${rel}_seasons_rmvd.txt`;

const GMSL_PROBE_TIMEOUT_MS = 10_000;   // short: this loop runs before anything else

/**
 * Finds the current CU release without an unbounded probe loop.
 *
 * The naive version walked ~16 candidates at a 20s timeout, which meant an
 * unreachable host could stall the whole job for five minutes before any other
 * source was touched. Instead: build a newest-first list, and if we already
 * know which release we used last time, stop the list there — we only ever
 * need to check whether something NEWER has appeared, then fall back to the
 * one we know works. That's typically 1-4 requests.
 */
async function resolveGmslUrl(entry) {
  const thisYear = new Date().getUTCFullYear();

  const candidates = [];
  for (let y = thisYear; y >= thisYear - 1; y--) {
    for (let rel = 3; rel >= 1; rel--) {
      candidates.push({ key: `${y}_rel${rel}`, url: GMSL_TEMPLATE(y, rel) });
    }
  }

  // Truncate at the known-good release: everything after it is older and
  // irrelevant, everything before it is a potential new release.
  if (entry.release) {
    const known = candidates.findIndex(c => c.key === entry.release);
    if (known >= 0) candidates.length = known + 1;
  }

  for (const candidate of candidates) {
    try {
      const res = await fetch(candidate.url, {
        signal: AbortSignal.timeout(GMSL_PROBE_TIMEOUT_MS)
      });
      if (res.ok) {
        if (entry.release !== candidate.key) {
          console.log(`gmsl: release ${entry.release ?? "(none)"} -> ${candidate.key}`);
        }
        entry.release = candidate.key;
        return candidate.url;
      }
    } catch {
      // Probe failed; try the next candidate.
    }
  }

  throw new Error(`no GMSL release found (probed ${candidates.length})`);
}

/** Converts a decimal year (1993.5) to an ISO date, honouring leap years. */
function decimalYearToDate(dy) {
  const y = Math.floor(dy);
  const start = Date.UTC(y, 0, 1);
  const end = Date.UTC(y + 1, 0, 1);
  return new Date(start + (dy - y) * (end - start)).toISOString().slice(0, 10);
}

/** Two columns after a single "#" header: decimal year, GMSL in mm. */
function parseGmsl(text) {
  return text.split(/\r?\n/).flatMap(line => {
    const t = line.trim();
    if (!t || t.startsWith("#")) return [];
    const [a, b] = t.split(/\s+/);
    const decimal_year = Number(a);
    const gmsl_mm = Number(b);
    if (!Number.isFinite(decimal_year) || !Number.isFinite(gmsl_mm)) return [];
    if (decimal_year < 1990 || decimal_year > 2100) return [];
    return [{ decimal_year, gmsl_mm, date: decimalYearToDate(decimal_year) }];
  }).sort((a, b) => a.decimal_year - b.decimal_year);
}

// ---------------------------------------------------------------------------
// JMA global ocean heat content
// ---------------------------------------------------------------------------

// Note the column-header row (" Year  A(0-700) ...") is NOT commented, so the
// year test below is what rejects it — a "#"-only filter would let it through.
const OHC_COLUMNS = ["year", "a_0_700", "a_700_2000", "a_0_2000", "e_0_2000"];

function parseOhc(text) {
  return text.split(/\r?\n/).flatMap(line => {
    const t = line.trim();
    if (!t || t.startsWith("#")) return [];
    const cols = t.split(/\s+/);
    if (!/^\d{4}$/.test(cols[0])) return [];   // drops the header row

    const row = {};
    OHC_COLUMNS.forEach((name, i) => { row[name] = Number(cols[i]); });
    if (!Number.isFinite(row.a_0_2000)) return [];
    return [row];
  }).sort((a, b) => a.year - b.year);
}

// ---------------------------------------------------------------------------
// NSIDC Sea Ice Index v4 — daily extent
// ---------------------------------------------------------------------------

// The raw CSV's trailing "Source Data" column holds a bracketed list that can
// itself contain commas, which breaks naive CSV parsers. The derived file
// drops it and adds a proper date, so d3.csv works without special handling.
const SEAICE_COLUMNS = ["year", "month", "day", "extent", "missing", "date"];

function parseSeaIce(text) {
  return text.split(/\r?\n/).flatMap(line => {
    const cols = line.split(",").map(c => c.trim());
    const [year, month, day, extent, missing] = cols.map(Number);
    // Skips both header rows: the names row and the units row.
    if (![year, month, day].every(Number.isFinite)) return [];
    if (year < 1970 || month < 1 || month > 12 || day < 1 || day > 31) return [];
    if (!Number.isFinite(extent) || extent <= 0) return [];

    return [{
      year, month, day, extent,
      missing: Number.isFinite(missing) ? missing : "",
      date: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
    }];
  }).sort((a, b) => a.date.localeCompare(b.date));
}

const SST_BASE = "https://climatereanalyzer.org/clim/sst_daily/json_2clim";

// Basin codes as they appear in the filenames, paired with a short id.
const SST_BASINS = [
  { id: "world",   code: "world2"  },   // World (60S-60N)
  { id: "natlan",  code: "natlan"  },   // North Atlantic
  { id: "natlsp",  code: "natlsp"  },   // Subpolar North Atlantic
  { id: "atlhmdr", code: "atlhmdr" },   // Atlantic Hurricane MDR
  { id: "gom",     code: "gom"     },   // Gulf of Maine
  { id: "gomex",   code: "gomex"   },   // Gulf of Mexico
  { id: "nino34",  code: "nino3.4" }    // Nino 3.4
];

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
//
// Optional fields:
//   derived      — path for a parsed CSV written alongside the raw mirror
//   transform    — buf => string, produces that CSV
//   minAgeHours  — skip the fetch if we checked more recently than this
//   variants     — expand one entry into many (see expandSources below)
// ---------------------------------------------------------------------------

const CAG_BASE = "https://www.ncei.noaa.gov/access/monitoring/climate-at-a-glance";

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
  },

  // --- NCEI Climate at a Glance -------------------------------------------
  // CAG updates monthly, so there's no reason to poll it every day.
  {
    name: "global_hottest_years",
    url: `${CAG_BASE}/global/haywood/globe/tavg/land_ocean/12/data.json`,
    file: "data/global_hottest_years.json",
    derived: "data/global_hottest_years.csv",
    minBytes: 1000,
    minAgeHours: 20,
    sniff: sniffCag(100),                         // record starts 1850
    transform: transformCag
  },
  {
    name: "us_hottest_years",
    url: `${CAG_BASE}/national/haywood/110/tavg/12/data.json`,
    file: "data/us_hottest_years.json",
    derived: "data/us_hottest_years.csv",
    minBytes: 1000,
    minAgeHours: 20,
    sniff: sniffCag(100),                         // record starts 1895
    transform: transformCag
  }

  ,
  {
    name: "gmsl",
    resolveUrl: resolveGmslUrl,          // release-versioned; discovered each run
    file: "data/gmsl.txt",
    derived: "data/gmsl.csv",
    minBytes: 5000,
    minAgeHours: 20,                     // CU updates roughly every two months
    sniff: buf => parseGmsl(buf.toString("utf8")).length >= 500,
    transform: buf => toCsv(parseGmsl(buf.toString("utf8")),
                            ["decimal_year", "gmsl_mm", "date"])
  },
  {
    name: "ohc",
    url: "https://www.data.jma.go.jp/kaiyou/data/english/ohc/ohc_global_1955.txt",
    file: "data/ohc_global_1955.txt",
    derived: "data/ohc.csv",
    minBytes: 1000,
    minAgeHours: 20,                     // JMA revises roughly annually
    sniff: buf => parseOhc(buf.toString("utf8")).length >= 50,
    transform: buf => toCsv(parseOhc(buf.toString("utf8")), OHC_COLUMNS)
  },
  {
    name: "seaice_arctic",
    url: "https://noaadata.apps.nsidc.org/NOAA/G02135/north/daily/data/N_seaice_extent_daily_v4.0.csv",
    timeoutMs: 90_000,                   // ~2 MB, and NSIDC can be slow
    file: "data/N_seaice_extent_daily_v4.0.csv",
    derived: "data/seaice_arctic.csv",
    minBytes: 200_000,
    sniff: buf => parseSeaIce(buf.toString("utf8")).length >= 10_000,
    transform: buf => toCsv(parseSeaIce(buf.toString("utf8")), SEAICE_COLUMNS)
  },

  // --- Climate Reanalyzer daily SST ---------------------------------------
  // Filenames match the source exactly, so switching a notebook over is just
  // a change of base URL. Updates daily, so no minAgeHours throttle.
  {
    name: "sst",
    variants: SST_BASINS,
    url: v => `${SST_BASE}/oisst2.1_${v.code}_sst_day.json`,
    file: v => `data/sst/oisst2.1_${v.code}_sst_day.json`,
    minBytes: 20000,
    throttleMs: 500,
    sniff: sniffSst
  }

  // --- Example of the variants pattern, for dynamic CAG selections ---------
  // Uncomment and fill in the codes you actually need. Each variant becomes
  // its own mirrored file, named "<source>_<id>".
  //
  // {
  //   name: "cag_state_tavg",
  //   variants: [
  //     { id: "ct", code: "6" },
  //     { id: "ny", code: "30" },
  //     { id: "ca", code: "4" }
  //   ],
  //   url: v => `${CAG_BASE}/statewide/haywood/${v.code}/tavg/12/data.json`,
  //   file: v => `data/cag/state-${v.id}-tavg.json`,
  //   derived: v => `data/cag/state-${v.id}-tavg.csv`,
  //   minBytes: 1000,
  //   minAgeHours: 20,
  //   throttleMs: 500,
  //   sniff: sniffCag(100),
  //   transform: transformCag
  // }
];

/** Turns any entry carrying `variants` into one concrete source per variant. */
function expandSources(sources) {
  return sources.flatMap(src => {
    if (!src.variants) return [src];
    return src.variants.map(v => ({
      ...src,
      variants: undefined,
      name: `${src.name}_${v.id}`,
      url: src.url(v),
      file: src.file(v),
      derived: src.derived ? src.derived(v) : undefined
    }));
  });
}

// ---------------------------------------------------------------------------

const MANIFEST = "data/manifest.json";
const MAX_SHRINK = 0.5;   // reject a file that's less than half its old size
const FAIL_AFTER_DAYS = 3; // days a source must be failing before the run goes red

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Ensure data/ exists even if every source fails, so the manifest write below
// can't die with ENOENT. No-op once the folder is there.
await mkdir("data", { recursive: true });

const manifest = existsSync(MANIFEST)
  ? JSON.parse(await readFile(MANIFEST, "utf8"))
  : {};

const now = new Date().toISOString();

for (const src of expandSources(SOURCES)) {
  const entry = (manifest[src.name] ??= {});

  // Throttle sources that update slower than we run.
  if (src.minAgeHours && entry.last_checked && entry.status === "ok") {
    const ageHours = (Date.now() - new Date(entry.last_checked)) / 3.6e6;
    if (ageHours < src.minAgeHours) {
      console.log(`${src.name}: skipped (checked ${ageHours.toFixed(1)}h ago)`);
      continue;
    }
  }

  entry.last_checked = now;
  const startedAt = Date.now();

  try {
    if (src.throttleMs) await sleep(src.throttleMs);

    // Sources whose URL changes between releases resolve it at runtime.
    const url = src.resolveUrl ? await src.resolveUrl(entry) : src.url;
    entry.url = url;

    const res = await fetch(url, { signal: AbortSignal.timeout(src.timeoutMs ?? 45_000) });
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

    entry.status = "ok";
    delete entry.error;
    delete entry.failing_since;

    // Derived output gets its own error boundary: a bad transform shouldn't
    // invalidate a mirror that fetched and validated fine.
    if (src.transform && (changed || !existsSync(src.derived))) {
      try {
        const csv = src.transform(buf);
        await writeFile(src.derived, csv);
        entry.rows = csv.trimEnd().split("\n").length - 1;
        delete entry.derived_error;
      } catch (err) {
        entry.derived_error = String(err.message);
        console.error(`${src.name}: transform failed — ${err.message}`);
      }
    }

    entry.seconds = Math.round((Date.now() - startedAt) / 100) / 10;
    console.log(
      `${src.name}: ${changed ? "updated" : "unchanged"} ` +
      `(${buf.length} bytes, ${entry.seconds}s)`
    );

  } catch (err) {
    // Note what failed, but leave the existing good file untouched.
    entry.status = "failed";
    entry.error = String(err.message);
    entry.failing_since ??= now;   // first failure of this streak

    entry.seconds = Math.round((Date.now() - startedAt) / 100) / 10;
    const days = (Date.now() - new Date(entry.failing_since)) / 864e5;
    console.error(
      `${src.name}: FAILED after ${entry.seconds}s — ${err.message} ` +
      `(failing ${days.toFixed(1)}d)`
    );
  }
}

// Only escalate to a red run once a source has been failing for a while.
// A one-day upstream outage is normal; a three-day one probably needs a look.
const alerting = Object.entries(manifest)
  .filter(([name, e]) =>
    !name.startsWith("_") &&
    e.status === "failed" &&
    e.failing_since &&
    (Date.now() - new Date(e.failing_since)) / 864e5 >= FAIL_AFTER_DAYS
  )
  .map(([name]) => name);

const failingNow = Object.entries(manifest)
  .filter(([name, e]) => !name.startsWith("_") && e.status === "failed")
  .map(([name]) => name);

manifest._meta = {
  generated: now,
  fail_after_days: FAIL_AFTER_DAYS,
  failing: failingNow,
  alerting,
  alert: alerting.length > 0
};

if (failingNow.length) {
  console.log(`Currently failing: ${failingNow.join(", ")}`);
}
if (alerting.length) {
  console.log(`Past the ${FAIL_AFTER_DAYS}-day grace period: ${alerting.join(", ")}`);
}

await writeFile(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
