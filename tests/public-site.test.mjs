import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
const snapshotNames = files.filter(
  (file) => path.dirname(file) === "." && /^snapshot\.[a-f0-9]{64}\.json$/.test(file),
);

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

test("public tree includes both the report and the independently built map", async () => {
  assert.equal(files.includes("index.html"), true);
  assert.equal(files.includes(path.join("map", "index.html")), true);
  assert.equal(files.includes(path.join("map", "data", "mallorca-map.snapshot.json")), true);
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

test("peer comparison is complete, anonymized, and arithmetically anchored", async () => {
  const payload = JSON.parse(await readFile(path.join(siteDir, snapshotNames[0]), "utf8"));
  const summary = payload.queries.camp_peer_summary.rows[0];
  assert.deepEqual(
    [summary.mountainPoints, summary.mountainRank, summary.mountainFieldSize],
    [34, 1, 10],
  );
  assert.deepEqual(
    [summary.queenCompleteTime, summary.queenCompleteRank, summary.queenCompleteFieldSize],
    ["1:38:20", 1, 9],
  );
  assert.deepEqual(
    [summary.ttScratchTime, summary.ttScratchRank, summary.ttHandicapSourcePlace],
    ["42:53", 3, 11],
  );
  assert.deepEqual(
    [summary.sprintPoints, summary.sprintRank, summary.sprintWPerKgRank],
    [23, 4, 3],
  );

  const mountainRows = payload.queries.mountain_points_distribution.rows;
  const queenRows = payload.queries.queen_complete_distribution.rows;
  assert.equal(mountainRows.length, 10);
  assert.equal(queenRows.length, 9);
  assert.equal(payload.queries.queen_climb_benchmarks.rows.length, 4);
  assert.equal(payload.queries.comparison_validation.rows.length, 6);
  for (const row of [...mountainRows, ...queenRows]) {
    assert.match(row.entrant, /^(You|Field \d+)$/);
    assert.equal(Object.hasOwn(row, "rider"), false);
    assert.equal(Object.hasOwn(row, "name"), false);
  }
});

test("peer source metadata exposes no raw source filenames or identity crosswalk", async () => {
  const payload = JSON.parse(await readFile(path.join(siteDir, snapshotNames[0]), "utf8"));
  const comparisonQueryIds = [
    "camp_peer_summary",
    "mountain_points_distribution",
    "mountain_stage_benchmarks",
    "queen_climb_benchmarks",
    "queen_complete_distribution",
    "tt_outcome",
    "sprint_profile",
    "peer_ride_context",
    "comparison_validation",
  ];
  const comparisonText = JSON.stringify(
    Object.fromEntries(comparisonQueryIds.map((id) => [id, payload.queries[id]])),
  );
  assert.doesNotMatch(comparisonText, /\.pdf\b/i);
  assert.doesNotMatch(comparisonText, /_ACTIVITY(?: 2)?\.fit\b/i);
  assert.doesNotMatch(comparisonText, /\b(?:rider|participant)(?:Name|Identity|Crosswalk)\b/i);
});

test("HTML points to the reviewed snapshot and not a hosted API", async () => {
  const html = await readFile(path.join(siteDir, "index.html"), "utf8");
  assert.equal(html.includes(snapshotNames[0]), true);
  assert.equal(html.includes('meta name="data-app-snapshot-storage" content="external-v1"'), false);
  assert.equal(html.includes('meta name="data-app-sites-project"'), false);
});
