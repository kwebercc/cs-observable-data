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
    out: "data/geo/sdo.topojson",
    simplify: 0.12,
    quantize: 1e5,
    minBytes: 100_000
  }
];

const MANIFEST = "data/geo-manifest.json";
const FAIL_AFTER_DAYS = 3;

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
    const hash = createHash("sha256").update(buf).digest("hex");
    const unchanged = entry.sha256 === hash && existsSync(src.out);
    if (unchanged) {
      entry.status = "ok";
      delete entry.error;
      delete entry.failing_since;
      console.log(`${src.name}: unchanged`);
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
    entry.sha256 = hash;
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
