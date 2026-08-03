#!/usr/bin/env node
/**
 * Drought geometry pipeline.
 *
 * Downloads each zipped shapefile, and if it has changed since last time,
 * reprojects it to EPSG:4326 and converts it to a simplified, quantized
 * topojson committed under data/geo/.
 *
 * The raw zips are deliberately NOT committed. Zip content is already
 * compressed, so git can't delta it — every weekly download would add a full
 * new blob and the repo would balloon. The topojson is plain text, small, and
 * deltas well, so that's what gets mirrored.
 *
 * Requires: gdal-bin (ogr2ogr), and geo2topo / toposimplify / topoquantize.
 */
import { readFile, writeFile, mkdir, rm, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";

const SOURCES = [
  {
    name: "usdm",
    url: "https://droughtmonitor.unl.edu/data/shapefiles_m/USDM_current_M.zip",
    object: "usdm",                    // stable topojson object name
    out: "data/geo/usdm.topojson",
    simplify: 0.12,                    // toposimplify -P
    quantize: 1e5,                     // topoquantize
    minBytes: 100_000,
    // USDM filenames embed the valid date: USDM_20260728_M.shp
    dateFrom: /USDM_(\d{8})/
  },
  {
    name: "mdo",
    url: "https://ftp.cpc.ncep.noaa.gov/GIS/droughtlook/mdo_polygons_latest.zip",
    shp: "DO_Merge_Clip.shp",          // archive also holds territory layers
    object: "mdo",
    label: { field: "Target", mode: "month" },
    out: "data/geo/mdo.topojson",
    simplify: 0.12,
    quantize: 1e5,
    minBytes: 100_000
  },
  {
    name: "sdo",
    url: "https://ftp.cpc.ncep.noaa.gov/GIS/droughtlook/sdo_polygons_latest.zip",
    shp: "DO_Merge_Clip.shp",
    object: "sdo",
    // Target is the LAST day of the 3-month period, e.g. 10/31/2026
    label: { field: "Target", mode: "season", months: 3 },
    out: "data/geo/sdo.topojson",
    simplify: 0.12,
    quantize: 1e5,
    minBytes: 100_000
  }
];

const MANIFEST = "data/geo-manifest.json";
const FAIL_AFTER_DAYS = 3;

// Bump this whenever the conversion logic changes in a way that should force
// every source to reprocess even if upstream hasn't republished. The cache key
// below folds it in, so a code change invalidates stale output automatically.
const PIPELINE_VERSION = 2;

/** Recursively collects every .shp in a directory tree, with its size. */
async function findShapefiles(dir) {
  const found = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) {
      found.push(...await findShapefiles(full));
    } else if (item.name.toLowerCase().endsWith(".shp")) {
      found.push({ file: full, size: (await stat(full)).size });
    }
  }
  return found;
}

/**
 * Picks which shapefile to convert. These archives can hold several layers
 * (CONUS plus island territories), so taking whichever turned up first is how
 * you end up mapping the Virgin Islands. Prefer an explicitly configured name;
 * otherwise fall back to the largest, which is a decent proxy for CONUS.
 */
function pickShapefile(candidates, want, sourceName) {
  if (candidates.length === 0) return null;

  if (want) {
    const match = candidates.find(
      c => path.basename(c.file).toLowerCase() === want.toLowerCase()
    );
    if (!match) {
      throw new Error(
        `expected "${want}" but archive holds: ` +
        candidates.map(c => path.basename(c.file)).join(", ")
      );
    }
    return match;
  }

  const largest = [...candidates].sort((a, b) => b.size - a.size)[0];
  if (candidates.length > 1) {
    console.warn(
      `${sourceName}: ${candidates.length} shapefiles present, no "shp" ` +
      `configured — defaulting to the largest (${path.basename(largest.file)}). ` +
      `Set "shp" explicitly if that's wrong.`
    );
  }
  return largest;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

const MONTH_RE = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/;

function monthIndexFromName(name) {
  const stem = String(name).toLowerCase().slice(0, 3);
  if (!MONTH_RE.test(stem)) return -1;
  return MONTHS.findIndex(m => m.toLowerCase().startsWith(stem));
}

/**
 * These DBF fields are inconsistent across CPC products — "Aug 2026",
 * "October 31", "10/31/2026" and ISO dates all turn up. Parse them all, and
 * flag whether a year was actually present.
 * Returns { year, month, day, hadYear } or null.
 */
function parseFlexibleDate(text) {
  const t = String(text).trim().replace(/,/g, " ").replace(/\s+/g, " ");
  let m;

  // 10/31/2026
  if ((m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) {
    return { year: +m[3], month: +m[1], day: +m[2], hadYear: true };
  }
  // 2026-10-31
  if ((m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) {
    return { year: +m[1], month: +m[2], day: +m[3], hadYear: true };
  }
  // "October 31 2026" / "Oct 31" / "October 31"
  if ((m = t.match(/^([A-Za-z]+)\.? (\d{1,2})(?: (\d{4}))?$/))) {
    const idx = monthIndexFromName(m[1]);
    if (idx >= 0) {
      return { year: m[3] ? +m[3] : null, month: idx + 1, day: +m[2], hadYear: Boolean(m[3]) };
    }
  }
  // "Aug 2026" — month and year, no day
  if ((m = t.match(/^([A-Za-z]+)\.? (\d{4})$/))) {
    const idx = monthIndexFromName(m[1]);
    if (idx >= 0) return { year: +m[2], month: idx + 1, day: null, hadYear: true };
  }
  // "31 October 2026"
  if ((m = t.match(/^(\d{1,2}) ([A-Za-z]+)\.?(?: (\d{4}))?$/))) {
    const idx = monthIndexFromName(m[2]);
    if (idx >= 0) {
      return { year: m[3] ? +m[3] : null, month: idx + 1, day: +m[1], hadYear: Boolean(m[3]) };
    }
  }
  return null;
}

/**
 * Outlook targets are always near the issue date, so when the year is missing
 * we take whichever candidate year lands closest to now. That resolves a
 * December/January target correctly instead of assuming the current year.
 */
function inferYear(month, day, reference = new Date()) {
  const base = reference.getUTCFullYear();
  return [base - 1, base, base + 1]
    .map(y => ({ y, gap: Math.abs(Date.UTC(y, month - 1, day || 1) - reference.getTime()) }))
    .sort((a, b) => a.gap - b.gap)[0].y;
}

function resolved(text) {
  const d = parseFlexibleDate(text);
  if (!d) return null;
  return d.hadYear ? d : { ...d, year: inferYear(d.month, d.day) };
}

/** "Aug 2026" or "10/31/2026" -> "August 2026" */
function monthLabel(text) {
  const d = resolved(text);
  return d ? `${MONTHS[d.month - 1]} ${d.year}` : null;
}

/**
 * Turns the closing month of an n-month outlook into a span label.
 * "10/31/2026" with months=3 -> "August-October 2026"
 * Handles the year boundary: "1/31/2027" -> "November 2026-January 2027"
 */
function seasonLabel(text, months = 3) {
  const d = resolved(text);
  if (!d) return null;

  const endIdx = d.month - 1;
  const startAbsolute = d.year * 12 + endIdx - (months - 1);
  const startYear = Math.floor(startAbsolute / 12);
  const startIdx = startAbsolute % 12;

  return startYear === d.year
    ? `${MONTHS[startIdx]}-${MONTHS[endIdx]} ${d.year}`
    : `${MONTHS[startIdx]} ${startYear}-${MONTHS[endIdx]} ${d.year}`;
}

/**
 * Reads feature properties out of an existing topojson and derives a display
 * label. Runs on every pass, including cache hits, so tweaking label logic
 * never requires reprocessing geometry.
 */
async function applyLabel(entry, src) {
  if (!src.label || !existsSync(src.out)) return;

  try {
    const topo = JSON.parse(await readFile(src.out, "utf8"));
    const props = topo.objects?.[src.object]?.geometries?.[0]?.properties;

    if (!props || Object.keys(props).length === 0) {
      console.warn(`${src.name}: topojson carries no feature properties — cannot derive a label`);
      return;
    }

    entry.properties = props;   // full first-feature properties, for debugging

    // Match the configured field case-insensitively; shapefile DBF column
    // names get mangled by different toolchains.
    const key = Object.keys(props).find(
      k => k.toLowerCase() === src.label.field.toLowerCase()
    );
    if (!key) {
      console.warn(
        `${src.name}: no "${src.label.field}" property. Available: ${Object.keys(props).join(", ")}`
      );
      return;
    }

    delete entry.valid_label;   // clear any stale value before recomputing

    const raw = props[key];
    entry.valid_raw = raw;
    entry.valid_label = src.label.mode === "season"
      ? seasonLabel(raw, src.label.months ?? 3)
      : monthLabel(raw);

    if (!entry.valid_label) {
      console.warn(
        `${src.name}: could not parse ${key}="${raw}". ` +
        `Properties: ${JSON.stringify(props)}`
      );
    } else {
      console.log(`${src.name}: ${key}="${raw}" -> "${entry.valid_label}"`);
    }
  } catch (err) {
    console.warn(`${src.name}: could not derive label — ${err.message}`);
  }
}

await mkdir("data/geo", { recursive: true });

const manifest = existsSync(MANIFEST)
  ? JSON.parse(await readFile(MANIFEST, "utf8"))
  : {};

const now = new Date().toISOString();

for (const src of SOURCES) {
  const entry = (manifest[src.name] ??= {});
  entry.url = src.url;
  entry.last_checked = now;

  const work = await import("node:fs/promises")
    .then(fs => fs.mkdtemp(path.join(os.tmpdir(), `${src.name}-`)));

  try {
    const res = await fetch(src.url, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const buf = Buffer.from(await res.arrayBuffer());

    // --- Validation ---
    if (buf.length < src.minBytes) {
      throw new Error(`too small: ${buf.length} bytes`);
    }
    // "PK" — zip magic. Catches an HTML error page served with a 200.
    if (buf[0] !== 0x50 || buf[1] !== 0x4b) {
      throw new Error("not a zip archive");
    }

    // --- Change detection, via hash rather than a stored copy ---
    // The key covers the payload AND the settings that affect the output, so
    // renaming the target layer or changing simplification forces a rebuild
    // even when upstream hasn't republished the archive.
    const sourceHash = createHash("sha256").update(buf).digest("hex");
    const cacheKey = createHash("sha256")
      .update(sourceHash)
      .update(JSON.stringify({
        v: PIPELINE_VERSION,
        shp: src.shp ?? null,
        object: src.object,
        simplify: src.simplify,
        quantize: src.quantize
      }))
      .digest("hex");

    const unchanged = entry.cache_key === cacheKey && existsSync(src.out);
    if (unchanged) {
      entry.status = "ok";
      delete entry.error;
      delete entry.failing_since;
      console.log(`${src.name}: unchanged`);
      await applyLabel(entry, src);
      continue;
    }

    // --- Extract ---
    const zipPath = path.join(work, "src.zip");
    await writeFile(zipPath, buf);
    execFileSync("unzip", ["-o", "-q", zipPath, "-d", work]);

    const candidates = await findShapefiles(work);
    if (candidates.length === 0) throw new Error("no .shp found inside the archive");

    // Always log what was in the archive — this is how you notice upstream
    // adding or renaming a layer before it silently changes your map.
    console.log(
      `${src.name}: archive contains ` +
      candidates
        .map(c => `${path.basename(c.file)} (${(c.size / 1024).toFixed(0)} KB)`)
        .join(", ")
    );

    const picked = pickShapefile(candidates, src.shp, src.name);
    const shp = picked.file;
    entry.layer = path.basename(shp);
    console.log(`${src.name}: converting ${entry.layer}`);

    if (src.dateFrom) {
      const m = path.basename(shp).match(src.dateFrom);
      if (m) {
        entry.valid_date = `${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6, 8)}`;
        entry.valid_label =
          `${MONTHS[Number(m[1].slice(4, 6)) - 1]} ${Number(m[1].slice(6, 8))}, ${m[1].slice(0, 4)}`;
      }
    }

    // --- Reproject to lon/lat and convert ---
    // -t_srs is the important bit: without it a projected source yields
    // coordinates in the hundreds of thousands and a map that renders as a dot.
    const geojson = path.join(work, "out.geojson");
    execFileSync("ogr2ogr", [
      "-f", "GeoJSON",
      "-t_srs", "EPSG:4326",
      geojson,
      shp
    ]);

    // --- Simplify and quantize, same chain as the manual terminal steps ---
    execSync(
      `geo2topo ${src.object}="${geojson}" ` +
      `| toposimplify -P ${src.simplify} ` +
      `| topoquantize ${src.quantize} > "${src.out}"`,
      { shell: "/bin/bash", stdio: ["ignore", "ignore", "inherit"] }
    );

    const topo = JSON.parse(await readFile(src.out, "utf8"));
    const geometries = topo.objects?.[src.object]?.geometries;
    if (!Array.isArray(geometries) || geometries.length === 0) {
      throw new Error("conversion produced no geometries");
    }

    // topojson carries a bbox; recording it makes a wrong-layer pick obvious
    // at a glance — CONUS should span roughly -125..-66 lon, 24..50 lat.
    if (Array.isArray(topo.bbox)) {
      entry.bbox = topo.bbox.map(n => Math.round(n * 100) / 100);
    }

    const bytes = (await readFile(src.out)).length;
    entry.source_sha256 = sourceHash;   // upstream archive
    entry.cache_key = cacheKey;         // archive + settings
    delete entry.sha256;                // superseded by the two above
    entry.status = "ok";
    entry.last_changed = now;
    entry.features = geometries.length;
    entry.output_bytes = bytes;
    delete entry.error;
    delete entry.failing_since;

    console.log(
      `${src.name}: updated — ${geometries.length} features, ` +
      `${(bytes / 1024).toFixed(0)} KB topojson`
    );

    await applyLabel(entry, src);

  } catch (err) {
    // Leave the previous good topojson in place.
    entry.status = "failed";
    entry.error = String(err.message);
    entry.failing_since ??= now;
    const days = (Date.now() - new Date(entry.failing_since)) / 864e5;
    console.error(`${src.name}: FAILED — ${err.message} (failing ${days.toFixed(1)}d)`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

const alerting = Object.entries(manifest)
  .filter(([name, e]) =>
    !name.startsWith("_") && e.status === "failed" && e.failing_since &&
    (Date.now() - new Date(e.failing_since)) / 864e5 >= FAIL_AFTER_DAYS
  )
  .map(([name]) => name);

manifest._meta = {
  generated: now,
  fail_after_days: FAIL_AFTER_DAYS,
  failing: Object.entries(manifest)
    .filter(([n, e]) => !n.startsWith("_") && e.status === "failed")
    .map(([n]) => n),
  alerting,
  alert: alerting.length > 0
};

await writeFile(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
