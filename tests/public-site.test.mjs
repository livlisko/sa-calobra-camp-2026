import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");
const siteDir = path.join(repoRoot, "site");
const files = await readdir(siteDir);
const snapshotNames = files.filter((file) => /^snapshot\.[a-f0-9]{64}\.json$/.test(file));

test("site contains one hash-bound snapshot", async () => {
  assert.equal(snapshotNames.length, 1);
  const bytes = await readFile(path.join(siteDir, snapshotNames[0]));
  const hash = createHash("sha256").update(bytes).digest("hex");
  assert.equal(snapshotNames[0], `snapshot.${hash}.json`);
});

test("public bundle omits local and activity identifiers", async () => {
  const parts = await Promise.all(files.map((file) => readFile(path.join(siteDir, file), "utf8")));
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

test("report is complete and uses corrected ride identities", async () => {
  const payload = JSON.parse(await readFile(path.join(siteDir, snapshotNames[0]), "utf8"));
  assert.equal(payload.buildStatus, "complete");
  assert.deepEqual(
    payload.queries.ride_summary.rows.slice(0, 2).map((row) => row.stage),
    ["Santa Magdalena reroute", "Betlem & Sant Salvador"],
  );
});

test("named segment ledger is complete and evidence-bound", async () => {
  const payload = JSON.parse(await readFile(path.join(siteDir, snapshotNames[0]), "utf8"));
  const rows = payload.queries.segment_efforts.rows;
  assert.equal(rows.length, 17);
  assert.equal(rows.filter((row) => row.matched).length, 15);
  assert.deepEqual(
    rows.filter((row) => !row.matched).map((row) => row.campName).sort(),
    ["Sa Batalla", "Santa Llúcia"],
  );
  const puigMajor = rows.find((row) => row.campName === "Puig Major");
  const saCalobra = rows.find((row) => row.campName === "Sa Calobra");
  assert.deepEqual([puigMajor.time, puigMajor.averagePowerW], ["53:19", 235.6]);
  assert.deepEqual([saCalobra.time, saCalobra.averagePowerW], ["42:53", 230.1]);
});

test("HTML points to the reviewed snapshot and not a hosted API", async () => {
  const html = await readFile(path.join(siteDir, "index.html"), "utf8");
  assert.equal(html.includes(snapshotNames[0]), true);
  assert.equal(html.includes('meta name="data-app-snapshot-storage" content="external-v1"'), false);
  assert.equal(html.includes('meta name="data-app-sites-project"'), false);
});
