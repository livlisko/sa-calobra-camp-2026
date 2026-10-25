import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");
const siteDir = path.join(repoRoot, "site");

async function collectFiles(directory, relativeDirectory = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const relativePath = path.join(relativeDirectory, entry.name);
      return entry.isDirectory()
        ? collectFiles(path.join(directory, entry.name), relativePath)
        : [relativePath];
    }),
  );
  return files.flat().sort();
}

const files = await collectFiles(siteDir);
const rootSnapshotNames = files.filter(
  (file) => path.dirname(file) === "." && /^snapshot\.[a-f0-9]{64}\.json$/.test(file),
);

test("root shell redirects accessibly to the relief atlas", async () => {
  const html = await readFile(path.join(siteDir, "index.html"), "utf8");
  assert.equal(rootSnapshotNames.length, 0);
  assert.match(html, /http-equiv="refresh" content="0; url=\.\/map\/"/);
  assert.match(html, /window\.location\.replace\(new URL\("\.\/map\/", window\.location\.href\)\)/);
  assert.match(html, /<a href="\.\/map\/">Mallorca relief atlas<\/a>/);
});

test("root shell contains no removed analysis runtime or report title", async () => {
  const html = await readFile(path.join(siteDir, "index.html"), "utf8");
  for (const removed of [
    "data-app",
    "camp_peer_summary",
    "data-app-sites-project",
    "Sa Calobra camp: where you stood",
  ]) {
    assert.equal(html.includes(removed), false, removed);
  }
});

test("public tree includes the relief atlas and its reviewed map snapshot", () => {
  assert.equal(files.includes("index.html"), true);
  assert.equal(files.includes(path.join("map", "index.html")), true);
  assert.equal(files.includes(path.join("map", "data", "mallorca-map.snapshot.json")), true);
});

test("public bundle omits local and activity identifiers", async () => {
  const textFiles = files.filter((file) => !/\.(?:webp|png|jpe?g|gif|woff2?)$/i.test(file));
  const parts = await Promise.all(
    textFiles.map((file) => readFile(path.join(siteDir, file), "utf8")),
  );
  const text = parts.join("\n");
  for (const forbidden of [
    "/Users/",
    "data-app-local-thread",
    "data-app-sites-project",
    "appgprj_",
  ]) {
    assert.equal(text.includes(forbidden), false, forbidden);
  }
  assert.doesNotMatch(text, /\b\d{11}_ACTIVITY(?: 2)?\.fit\b/);
  assert.doesNotMatch(text, /strava\.com\/activities\/\d+/);
});

test("map source contains no links back to the removed analysis", async () => {
  const source = await Promise.all([
    "map-app/index.html",
    "map-app/src/main.ts",
    "map-app/src/map.css",
  ].map((file) => readFile(path.join(repoRoot, file), "utf8")));
  const text = source.join("\n");
  assert.doesNotMatch(text, /Week analysis|week analysis|main report|back-link/);
  assert.match(text, /Reload the relief atlas/);
});
