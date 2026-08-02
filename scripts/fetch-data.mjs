#!/usr/bin/env node
/**
 * Fetches each source, validates it, and writes it into data/ only if it
 * passes. Records outcomes in data/manifest.json either way.
 *
 * Always exits 0 — the workflow commits the manifest first, then checks it
 * and fails the run afterward, so a failure is still recorded in git.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

await mkdir("data", { recursive: true });

const SOURCES = [
  {
    name: "oni",
    url: "https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt",
    file: "data/oni.txt",
    minBytes: 5000,
    // The record always starts at DJF 1950 — a cheap shape check.
    sniff: buf => /\bDJF\s+1950\b/.test(buf.toString("utf8").slice(0, 500))
  },
  {
    name: "roni",
    url: "https://www.cpc.ncep.noaa.gov/data/indices/RONI.ascii.txt",
    file: "data/roni.txt",
    minBytes: 5000,
    sniff: buf => /\bDJF\s+1950\b/.test(buf.toString("utf8").slice(0, 500))
  }
];

const MANIFEST = "data/manifest.json";
const MAX_SHRINK = 0.5;   // reject a file that's less than half its old size

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

    if (existsSync(src.file)) {
      const old = await readFile(src.file);
      // Records only grow. A sudden shrink means truncation upstream.
      if (buf.length < old.length * MAX_SHRINK) {
        throw new Error(`suspicious shrink: ${old.length} -> ${buf.length} bytes`);
      }
      if (buf.equals(old)) {
        entry.status = "ok";
        delete entry.error;
        console.log(`${src.name}: unchanged`);
        continue;
      }
    }

    await mkdir(path.dirname(src.file), { recursive: true });
    await writeFile(src.file, buf);

    entry.status = "ok";
    entry.last_changed = now;
    entry.bytes = buf.length;
    delete entry.error;
    console.log(`${src.name}: updated (${buf.length} bytes)`);

  } catch (err) {
    // Note what failed, but leave the existing good file untouched.
    entry.status = "failed";
    entry.error = String(err.message);
    console.error(`${src.name}: FAILED — ${err.message}`);
  }
}

await writeFile(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
