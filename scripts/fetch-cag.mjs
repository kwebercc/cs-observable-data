#!/usr/bin/env node
/**
 * NCEI Climate at a Glance time-series mirror.
 *
 * CAG's selectors are all fixed dropdowns, so the space is large but finite.
 * This enumerates every reachable combination, mirrors the JSON under
 * data/cag/, and writes a per-family summary to data/cag-manifest.json.
 *
 * Filenames deliberately EXCLUDE the year range, so notebook paths never
 * change when the record rolls over into a new year.
 *
 * Runs separately from fetch-data.mjs because CAG updates monthly — there's
 * no reason to make the daily job carry thousands of requests.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const BASE = "https://www.ncei.noaa.gov/access/monitoring/climate-at-a-glance";
const OUT_DIR = "data/cag";
const MANIFEST = "data/cag-manifest.json";

const CONCURRENCY = 4;      // parallel requests; keep modest, it's a gov server
const THROTTLE_MS = 120;    // spacing per worker
const FAIL_AFTER_DAYS = 3;

// ---------------------------------------------------------------------------
// Option lists — these mirror the notebook dropdowns
// ---------------------------------------------------------------------------

const REGIONS = [
  "globe", "nhem", "shem", "africa", "asia", "europe", "northAmerica",
  "oceania", "southAmerica", "atlanticMdr", "caribbeanIslands",
  "eastNPacific", "gulfOfAmerica", "hawaiianRegion", "arctic", "antarctic"
];

const SURFACES = ["land", "ocean", "land_ocean"];

const STATE_CODES = [
  1, 50, 2, 3, 4, 5, 6, 7, 8, 9, 51, 10, 11, 12, 13, 14, 15, 16, 17, 18,
  19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36,
  37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48
];

const MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

// If the Month dropdown DOES affect an Annual chart (i.e. "12-month period
// ending in <month>"), change this to MONTHS. That doubles the file count for
// the US families but is otherwise a drop-in change.
const ANNUAL_END_MONTHS = [12];

/** (totalMonths, endMonth) pairs for the US notebooks: monthly + annual. */
const US_SLICES = [
  ...MONTHS.map(m => ({ months: 1, end: m })),
  ...ANNUAL_END_MONTHS.map(m => ({ months: 12, end: m }))
];

/** Global notebook adds seasonal (3-month) periods. */
const GLOBAL_SLICES = [
  ...MONTHS.map(m => ({ months: 1, end: m })),
  ...MONTHS.map(m => ({ months: 3, end: m })),
  ...ANNUAL_END_MONTHS.map(m => ({ months: 12, end: m }))
];

// ---------------------------------------------------------------------------
// Families. Each yields { file, url } pairs given a resolved end year.
// ---------------------------------------------------------------------------

const FAMILIES = [
  {
    name: "global_anomalies",
    startYear: 1850,
    probe: y => `${BASE}/global/time-series/globe/land_ocean/tavg/1/1/1850-${y}/data.json`,
    combos: y => REGIONS.flatMap(region =>
      SURFACES.flatMap(surface =>
        GLOBAL_SLICES.map(s => ({
          file: `${OUT_DIR}/global/${region}_${surface}_tavg_${s.months}_${s.end}.json`,
          url: `${BASE}/global/time-series/${region}/${surface}/tavg/${s.months}/${s.end}/1850-${y}/data.json`
        }))
      )
    )
  },
  {
    name: "us_temperature",
    startYear: 1900,
    probe: y => `${BASE}/national/time-series/110/tavg/1/1/1900-${y}/data.json`,
    combos: y => ["tmin", "tavg", "tmax"].flatMap(variable =>
      US_SLICES.flatMap(s => [
        // National (CONUS) uses code 110 on the /national/ endpoint.
        {
          file: `${OUT_DIR}/us-temp/110_${variable}_${s.months}_${s.end}.json`,
          url: `${BASE}/national/time-series/110/${variable}/${s.months}/${s.end}/1900-${y}/data.json`
        },
        ...STATE_CODES.map(code => ({
          file: `${OUT_DIR}/us-temp/${code}_${variable}_${s.months}_${s.end}.json`,
          url: `${BASE}/statewide/time-series/${code}/${variable}/${s.months}/${s.end}/1900-${y}/data.json`
        }))
      ])
    )
  },
  {
    name: "us_precipitation",
    startYear: 1900,
    probe: y => `${BASE}/national/time-series/110/pcp/1/1/1900-${y}/data.json`,
    combos: y => US_SLICES.flatMap(s => [
      {
        file: `${OUT_DIR}/us-pcp/110_${s.months}_${s.end}.json`,
        url: `${BASE}/national/time-series/110/pcp/${s.months}/${s.end}/1900-${y}/data.json`
      },
      ...STATE_CODES.map(code => ({
        file: `${OUT_DIR}/us-pcp/${code}_${s.months}_${s.end}.json`,
        url: `${BASE}/statewide/time-series/${code}/pcp/${s.months}/${s.end}/1900-${y}/data.json`
      }))
    ])
  },
  {
    name: "us_degree_days",
    startYear: 1895,
    probe: y => `${BASE}/national/time-series/110/cdd/1/1/1895-${y}/data.json`,
    combos: y => ["cdd", "hdd"].flatMap(param =>
      US_SLICES.flatMap(s => [
        {
          file: `${OUT_DIR}/us-dd/110_${param}_${s.months}_${s.end}.json`,
          url: `${BASE}/national/time-series/110/${param}/${s.months}/${s.end}/1895-${y}/data.json`
        },
        ...STATE_CODES.map(code => ({
          file: `${OUT_DIR}/us-dd/${code}_${param}_${s.months}_${s.end}.json`,
          url: `${BASE}/statewide/time-series/${code}/${param}/${s.months}/${s.end}/1895-${y}/data.json`
        }))
      ])
    )
  }
];

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Confirms a CAG payload really is one, and has a plausible number of rows. */
function validCag(text, minRows = 50) {
  const json = JSON.parse(text);
  if (!json.data || typeof json.data !== "object") {
    throw new Error("payload has no data object");
  }
  const years = Object.keys(json.data).filter(k => /^\d{4}/.test(k));
  if (years.length < minRows) {
    throw new Error(`only ${years.length} periods in payload`);
  }
  return years.length;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchText(url, attempts = 3) {
  let lastError;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(45_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      lastError = err;
      if (i < attempts) await sleep(500 * i);   // brief backoff
    }
  }
  throw lastError;
}

/**
 * CAG bakes the year range into the URL, and it's unclear whether a
 * not-yet-complete year is clamped or rejected. Rather than assume, probe:
 * try the current year, fall back a year, then one more. Whatever answers
 * is used for the whole family.
 */
async function resolveEndYear(family) {
  const thisYear = new Date().getUTCFullYear();
  for (const y of [thisYear, thisYear - 1, thisYear - 2]) {
    try {
      const text = await fetchText(family.probe(y), 2);
      validCag(text);
      return y;
    } catch {
      // try the next candidate
    }
  }
  throw new Error("could not resolve a working end year");
}

/** Simple worker pool — keeps a fixed number of requests in flight. */
async function runPool(items, worker, concurrency) {
  let cursor = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await worker(items[index], index);
      await sleep(THROTTLE_MS);
    }
  });
  await Promise.all(workers);
}

// ---------------------------------------------------------------------------

await mkdir(OUT_DIR, { recursive: true });

const manifest = existsSync(MANIFEST)
  ? JSON.parse(await readFile(MANIFEST, "utf8"))
  : {};

const now = new Date().toISOString();

for (const family of FAMILIES) {
  const entry = (manifest[family.name] ??= {});
  entry.last_run = now;

  try {
    const endYear = await resolveEndYear(family);
    entry.end_year = endYear;
    entry.year_range = `${family.startYear}-${endYear}`;

    const combos = family.combos(endYear);
    console.log(`${family.name}: ${combos.length} combinations, range ${entry.year_range}`);

    // Directories up front, so the pool isn't racing to create them.
    const dirs = new Set(combos.map(c => path.dirname(c.file)));
    for (const dir of dirs) await mkdir(dir, { recursive: true });

    let ok = 0, changed = 0;
    const failures = [];

    await runPool(combos, async combo => {
      try {
        const text = await fetchText(combo.url);
        validCag(text);

        // Compare before writing so unchanged files stay out of the diff.
        const previous = existsSync(combo.file)
          ? await readFile(combo.file, "utf8")
          : null;
        if (text !== previous) {
          await writeFile(combo.file, text);
          changed++;
        }
        ok++;
      } catch (err) {
        // Record and move on — one dead combination shouldn't sink the family.
        failures.push({ file: path.basename(combo.file), error: String(err.message) });
      }
    }, CONCURRENCY);

    entry.expected = combos.length;
    entry.ok = ok;
    entry.changed = changed;
    entry.failed = failures.length;
    // Cap the stored list; a systemic outage would otherwise bloat the manifest.
    entry.failures = failures.slice(0, 25);
    entry.status = failures.length === 0 ? "ok" : "partial";

    if (failures.length === 0) {
      delete entry.failing_since;
    } else {
      entry.failing_since ??= now;
    }

    console.log(
      `${family.name}: ${ok}/${combos.length} ok, ${changed} changed, ${failures.length} failed`
    );

  } catch (err) {
    entry.status = "failed";
    entry.error = String(err.message);
    entry.failing_since ??= now;
    console.error(`${family.name}: FAILED — ${err.message}`);
  }
}

// A handful of missing combinations is normal (not every selector pairing
// exists upstream). Only escalate on a whole family failing, or on a partial
// that has persisted past the grace period.
const alerting = Object.entries(manifest)
  .filter(([name, e]) => {
    if (name.startsWith("_")) return false;
    if (e.status === "failed") return true;
    if (e.status !== "partial" || !e.failing_since) return false;
    const days = (Date.now() - new Date(e.failing_since)) / 864e5;
    return days >= FAIL_AFTER_DAYS && e.failed > e.expected * 0.05;
  })
  .map(([name]) => name);

manifest._meta = {
  generated: now,
  fail_after_days: FAIL_AFTER_DAYS,
  alerting,
  alert: alerting.length > 0
};

await writeFile(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
console.log(alerting.length ? `ALERTING: ${alerting.join(", ")}` : "All families healthy.");
