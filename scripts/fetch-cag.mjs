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

const CONCURRENCY = 3;      // parallel requests; keep modest, it's a gov server
const THROTTLE_MS = 120;    // spacing per worker
const TIMEOUT_MS = 60_000;  // NCEI occasionally stalls; be patient
const MIN_ROWS = 20;        // absolute floor — Hawaii's record starts 1991
const MAX_SWEEPS = 3;       // extra passes over transient failures
const MAX_COOLDOWN_MS = 30_000;
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

// CAG's degree days come from nClimDiv, which is CONUS-only — Alaska (50) and
// Hawaii (51) 404 for cdd/hdd. Skip them rather than logging 52 failures.
const NO_DEGREE_DAYS = [50, 51];
const DD_STATE_CODES = STATE_CODES.filter(c => !NO_DEGREE_DAYS.includes(c));

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

// endMonth = 0 is a special case on the global endpoint: instead of one month
// sampled across years, it returns EVERY period of the given length as a
// continuous series (e.g. 1/0 is every monthly anomaly since 1850).
//
// Confirmed for monthly (1/0). The 3 and 12 variants are plausible but
// unverified — if either doesn't exist upstream it'll appear as a 404 in
// cag-manifest.json's failures list, and can be trimmed from here.
const ALL_PERIOD_TOTALS = [1, 3, 12];

/** Global notebook adds seasonal (3-month) periods, plus the endMonth=0 series. */
const GLOBAL_SLICES = [
  ...MONTHS.map(m => ({ months: 1, end: m })),
  ...MONTHS.map(m => ({ months: 3, end: m })),
  ...ANNUAL_END_MONTHS.map(m => ({ months: 12, end: m })),
  ...ALL_PERIOD_TOTALS.map(months => ({ months, end: 0 }))
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
        ...DD_STATE_CODES.map(code => ({
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

/**
 * Counts the period keys in a CAG payload. Returns null if it isn't parseable
 * as one, so it can be used on a previously-stored file without throwing.
 */
function countPeriods(text) {
  try {
    const json = JSON.parse(text);
    if (!json.data || typeof json.data !== "object") return null;
    return Object.keys(json.data).filter(k => /^\d{4}/.test(k)).length;
  } catch {
    return null;
  }
}

/**
 * Validates a CAG payload. The absolute floor is deliberately low, because
 * record lengths vary a lot by geography — Hawaii's statewide series starts
 * in 1991, so 35 periods is complete, not truncated. Truncation is caught by
 * comparing against the previous copy instead, which self-calibrates per file.
 */
function validCag(text, previous = null) {
  const json = JSON.parse(text);
  if (!json.data || typeof json.data !== "object") {
    throw new Error("payload has no data object");
  }

  const rows = Object.keys(json.data).filter(k => /^\d{4}/.test(k)).length;
  if (rows < MIN_ROWS) {
    throw new Error(`only ${rows} periods in payload`);
  }

  if (previous) {
    const before = countPeriods(previous);
    // Allow a drop of one: CAG sometimes withdraws a provisional final period.
    if (before !== null && rows < before - 1) {
      throw new Error(`period count dropped ${before} -> ${rows}`);
    }
  }

  return rows;
}

/** Errors worth another attempt later, versus a combination that doesn't exist. */
const isTransient = message =>
  /timeout|abort|ECONN|EAI_AGAIN|socket|fetch failed|HTTP 5\d\d|HTTP 429/i.test(message);

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Shared backpressure. A stalled server takes out every concurrent worker at
 * once, and the worst response is for all of them to immediately retry. So a
 * timeout sets a cooldown that ALL workers observe, escalating while the
 * stalling continues and clearing on the first success.
 */
let cooldownUntil = 0;
let consecutiveStalls = 0;

async function respectCooldown() {
  const wait = cooldownUntil - Date.now();
  if (wait > 0) await sleep(wait);
}

function noteStall() {
  consecutiveStalls++;
  const pause = Math.min(MAX_COOLDOWN_MS, 2_000 * consecutiveStalls);
  cooldownUntil = Math.max(cooldownUntil, Date.now() + pause);
  if (consecutiveStalls === 1 || consecutiveStalls % 10 === 0) {
    console.log(`  backing off ${(pause / 1000).toFixed(0)}s after ${consecutiveStalls} stall(s)`);
  }
}

async function fetchText(url, attempts = 4) {
  let lastError;
  for (let i = 1; i <= attempts; i++) {
    try {
      await respectCooldown();
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      consecutiveStalls = 0;   // server is healthy again
      return text;
    } catch (err) {
      lastError = err;
      if (isTransient(String(err.message))) noteStall();
      if (i < attempts) await sleep(750 * i);   // linear backoff
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
      validCag(text);   // shape only; no previous copy to compare against
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
    let failures = [];

    const attempt = async combo => {
      // Read the previous copy first: it both seeds the shrink check and lets
      // us skip the write when nothing changed.
      const previous = existsSync(combo.file)
        ? await readFile(combo.file, "utf8")
        : null;

      const text = await fetchText(combo.url);
      validCag(text, previous);

      if (text !== previous) {
        await writeFile(combo.file, text);
        changed++;
      }
      ok++;
    };

    await runPool(combos, async combo => {
      try {
        await attempt(combo);
      } catch (err) {
        // Record and move on — one bad combination shouldn't sink the family.
        failures.push({ combo, error: String(err.message) });
      }
    }, CONCURRENCY);

    // Sweep transient failures repeatedly, serially, with a growing pause
    // between passes. Real 404s are left alone — retrying those is pointless.
    for (let sweep = 1; sweep <= MAX_SWEEPS; sweep++) {
      const retryable = failures.filter(f => isTransient(f.error));
      if (retryable.length === 0) break;

      const pause = 5_000 * sweep;
      console.log(
        `${family.name}: sweep ${sweep}/${MAX_SWEEPS} — ` +
        `${retryable.length} transient failure(s), pausing ${pause / 1000}s first`
      );
      await sleep(pause);

      const stillFailing = [];
      for (const f of retryable) {
        try {
          await attempt(f.combo);
        } catch (err) {
          stillFailing.push({ combo: f.combo, error: String(err.message) });
        }
        await sleep(600);
      }

      const recovered = retryable.length - stillFailing.length;
      console.log(`${family.name}: sweep ${sweep} recovered ${recovered}`);
      failures = failures.filter(f => !isTransient(f.error)).concat(stillFailing);
    }

    entry.expected = combos.length;
    entry.ok = ok;
    entry.changed = changed;
    entry.failed = failures.length;
    // Cap the stored list; a systemic outage would otherwise bloat the manifest.
    entry.failures = failures
      .slice(0, 25)
      .map(f => ({ file: path.basename(f.combo.file), error: f.error }));
    entry.transient_failed = failures.filter(f => isTransient(f.error)).length;
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
