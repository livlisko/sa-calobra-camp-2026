import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { FitBaseType, FitEncoder } from "fit-file-parser/encoder";
import { createServer, transformWithOxc } from "vite";

const repoRoot = path.resolve(import.meta.dirname, "..");

async function loadHistoryMatchModule() {
  const filename = path.join(repoRoot, "map-app", "src", "history-match.ts");
  const source = await readFile(filename, "utf8");
  const transformed = await transformWithOxc(source, filename, { sourcemap: false });
  return import(`data:text/javascript;base64,${Buffer.from(transformed.code).toString("base64")}`);
}

const history = await loadHistoryMatchModule();
const baseTimestamp = Date.UTC(2026, 9, 22, 8, 0, 0);
const start = [2.9, 39.8];
const end = [2.912, 39.8];
const expectedDistanceM = history.haversineDistanceM(start, end);

function position(fraction) {
  return [
    start[0] + (end[0] - start[0]) * fraction,
    start[1] + (end[1] - start[1]) * fraction,
  ];
}

function template(overrides = {}) {
  return {
    stravaSegmentId: "653262",
    boundaryVersion: "current-2026",
    campLabel: "Sa Calobra",
    templateHash: `sha256:${"a".repeat(64)}`,
    geometry: { type: "LineString", coordinates: [start, end] },
    expectedDistanceM,
    matchReady: true,
    ...overrides,
  };
}

function catalog(segments = [template()]) {
  return { catalogVersion: "mallorca-history-v1", segments };
}

function track({ reverse = false, timestampForIndex = (index) => baseTimestamp + index * 1000 } = {}) {
  return Array.from({ length: 101 }, (_, index) => {
    const fraction = (reverse ? 100 - index : index) / 100;
    return {
      timestampMs: timestampForIndex(index),
      coordinate: position(fraction),
      distanceM: expectedDistanceM * index / 100,
      altitudeM: 100 + index * 0.5,
      powerW: index % 2 ? 200 : 0,
      heartRateBpm: index % 2 ? null : 150,
      cadenceRpm: 80,
      speedMps: expectedDistanceM / 100,
      timerRunning: true,
    };
  });
}

test("matches an ordered full-corridor pass and derives null-safe metrics", () => {
  const points = track();
  const matches = history.matchHistoryTrack(points, catalog());
  assert.equal(matches.length, 1);
  assert.equal(matches[0].status, "confirmed");
  assert.equal(matches[0].segmentKey, "strava:653262@current-2026");
  assert.ok(matches[0].evidence.templateCoverage >= 0.85);
  assert.ok(matches[0].evidence.orderedProgress >= 0.95);

  const effort = history.deriveHistoryEffort("private-source", "effort-1", "mallorca-history-v1", points, matches[0]);
  assert.ok(effort);
  assert.equal(effort.elapsedSeconds, 100);
  assert.equal(effort.movingSeconds, 100);
  assert.equal(effort.averagePowerW, 100);
  assert.equal(effort.coverage.power, 1);
  assert.equal(effort.averageHeartRateBpm, null);
  assert.ok(Math.abs(effort.coverage.heartRate - 0.5) < 0.001);
  assert.equal(effort.quality, "partial");
  assert.equal("coordinate" in effort, false);
  assert.equal("filename" in effort, false);
});

test("time weighting includes recorded zero power and respects irregular intervals", () => {
  const points = [
    { timestampMs: baseTimestamp, coordinate: start, distanceM: 0, altitudeM: 100, powerW: 0, heartRateBpm: null, cadenceRpm: null, speedMps: null, timerRunning: true },
    { timestampMs: baseTimestamp + 1000, coordinate: position(0.25), distanceM: 250, altitudeM: 110, powerW: 200, heartRateBpm: null, cadenceRpm: null, speedMps: null, timerRunning: true },
    { timestampMs: baseTimestamp + 4000, coordinate: end, distanceM: 1000, altitudeM: 120, powerW: 200, heartRateBpm: null, cadenceRpm: null, speedMps: null, timerRunning: true },
  ];
  const match = {
    segmentKey: "strava:653262@current-2026",
    stravaSegmentId: "653262",
    boundaryVersion: "current-2026",
    campLabel: "Sa Calobra",
    templateHash: `sha256:${"a".repeat(64)}`,
    status: "confirmed",
    confidence: "high",
    reasons: [],
    evidence: {
      score: 1,
      startDistanceM: 0,
      endDistanceM: 0,
      routeDistanceM: 1000,
      distanceRatio: 1,
      templateCoverage: 1,
      orderedProgress: 1,
      insideCorridorRatio: 1,
      medianLateralErrorM: 0,
      p95LateralErrorM: 0,
      sampledPointCount: 3,
    },
    window: { startIndex: 0, endIndex: 2, startTimestampMs: baseTimestamp, endTimestampMs: baseTimestamp + 4000 },
  };
  const effort = history.deriveHistoryEffort("source", "effort", "v1", points, match);
  assert.ok(effort);
  assert.equal(effort.averagePowerW, 150);
  assert.equal(effort.coverage.power, 1);
});

test("low-coverage sensor values never enter personal metric trends", () => {
  const points = track().map((point, index) => ({ ...point, powerW: index === 0 ? 400 : null }));
  const match = history.matchHistoryTrack(points, catalog())[0];
  const effort = history.deriveHistoryEffort("source", "sparse-power", "v1", points, match);
  assert.ok(effort);
  assert.ok(effort.coverage.power < 0.02);
  assert.equal(effort.averagePowerW, null);
  assert.equal(effort.quality, "partial");
});

test("explicitly non-cycling FIT sessions are excluded before segment matching", async () => {
  const snapshot = JSON.parse(await readFile(path.join(repoRoot, "map-app", "public", "data", "mallorca-map.snapshot.json"), "utf8"));
  const segment = snapshot.segments.find((entry) => entry.segmentId === "segment-14");
  assert.ok(segment?.geometry);
  const coordinates = segment.geometry.type === "LineString" ? segment.geometry.coordinates : segment.geometry.coordinates.flat();
  const encoder = new FitEncoder();
  const startedAt = new Date("2025-10-22T08:00:00.000Z");
  const semicircles = (degrees) => Math.round(degrees * 2 ** 31 / 180);
  encoder.writeMessage(0, [
    { number: 0, size: 1, baseType: FitBaseType.Enum, value: 4 },
    { number: 1, size: 2, baseType: FitBaseType.Uint16, value: 1 },
    { number: 4, size: 4, baseType: FitBaseType.Uint32, value: FitEncoder.toFitTimestamp(startedAt) },
  ]);
  coordinates.forEach(([longitude, latitude], index) => {
    const fraction = index / (coordinates.length - 1);
    const timestamp = new Date(startedAt.valueOf() + index * 5000);
    encoder.writeMessage(20, [
      { number: 0, size: 4, baseType: FitBaseType.Sint32, value: semicircles(latitude) },
      { number: 1, size: 4, baseType: FitBaseType.Sint32, value: semicircles(longitude) },
      { number: 2, size: 2, baseType: FitBaseType.Uint16, value: Math.round((100 + fraction * 660 + 500) * 5) },
      { number: 3, size: 1, baseType: FitBaseType.Uint8, value: 155 },
      { number: 4, size: 1, baseType: FitBaseType.Uint8, value: 80 },
      { number: 5, size: 4, baseType: FitBaseType.Uint32, value: Math.round(fraction * 9410 * 100) },
      { number: 7, size: 2, baseType: FitBaseType.Uint16, value: 220 },
      { number: 253, size: 4, baseType: FitBaseType.Uint32, value: FitEncoder.toFitTimestamp(timestamp) },
    ], 1);
  });
  const durationSeconds = (coordinates.length - 1) * 5;
  encoder.writeMessage(18, [
    { number: 2, size: 4, baseType: FitBaseType.Uint32, value: FitEncoder.toFitTimestamp(startedAt) },
    { number: 5, size: 1, baseType: FitBaseType.Enum, value: 1 },
    { number: 7, size: 4, baseType: FitBaseType.Uint32, value: durationSeconds * 1000 },
    { number: 8, size: 4, baseType: FitBaseType.Uint32, value: durationSeconds * 1000 },
    { number: 253, size: 4, baseType: FitBaseType.Uint32, value: FitEncoder.toFitTimestamp(new Date(startedAt.valueOf() + durationSeconds * 1000)) },
  ], 2);
  const encoded = encoder.close();
  const vite = await createServer({ root: repoRoot, appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  try {
    const fitHistory = await vite.ssrLoadModule("/map-app/src/history-fit.ts");
    const result = await fitHistory.parseFitHistory(
      encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength),
      "private-running-source",
      {
        catalogVersion: "mallorca-history-test-v1",
        segments: [{
          stravaSegmentId: String(segment.stravaSegmentId),
          boundaryVersion: "public-rider-trace-2026-v1",
          campLabel: segment.campLabel,
          templateHash: `sha256:${"b".repeat(64)}`,
          geometry: segment.geometry,
          expectedDistanceM: segment.stats.distanceKm * 1000,
          matchReady: true,
        }],
      },
    );
    assert.equal(result.efforts.length, 0);
    assert.ok(result.warnings.includes("non_cycling_session"));
    assert.ok(result.warnings.includes("no_matching_segments"));
  } finally {
    await vite.close();
  }
});

test("does not confirm reverse-direction or cross-gap traces", () => {
  const reverseMatches = history.matchHistoryTrack(track({ reverse: true }), catalog());
  assert.equal(reverseMatches.some((match) => match.status === "confirmed"), false);

  const gapMatches = history.matchHistoryTrack(
    track({ timestampForIndex: (index) => baseTimestamp + (index <= 50 ? index : index + 60) * 1000 }),
    catalog(),
  );
  assert.equal(gapMatches.some((match) => match.status === "confirmed"), false);
});

test("keeps exact segment versions separate and reviews indistinguishable boundaries", () => {
  const posted = template({ stravaSegmentId: "21004670", boundaryVersion: "camp-posted-retired", campLabel: "Sant Salvador" });
  const replacement = template({ stravaSegmentId: "2384380", boundaryVersion: "current-replacement", campLabel: "Sant Salvador" });
  const matches = history.matchHistoryTrack(track(), catalog([posted, replacement]));
  assert.deepEqual(new Set(matches.map((match) => match.segmentKey)), new Set([
    "strava:21004670@camp-posted-retired",
    "strava:2384380@current-replacement",
  ]));
  assert.ok(matches.every((match) => match.status === "review"));
  assert.ok(matches.every((match) => match.reasons.includes("ambiguous_window")));
});

test("rejects duplicate exact identities but not duplicate display names", () => {
  assert.throws(
    () => history.validateHistoryCatalog(catalog([template(), template()])),
    /Duplicate exact segment definition/,
  );
  assert.doesNotThrow(() => history.validateHistoryCatalog(catalog([
    template({ stravaSegmentId: "1", campLabel: "Honor" }),
    template({ stravaSegmentId: "2", campLabel: "Honor" }),
  ])));
});

test("history import core has no network or browser-persistence path", async () => {
  const files = await Promise.all([
    "history-client.ts",
    "history-fit.ts",
    "history-match.ts",
    "history-worker.ts",
  ].map((name) => readFile(path.join(repoRoot, "map-app", "src", name), "utf8")));
  const source = files.join("\n");
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /\bXMLHttpRequest\b/);
  assert.doesNotMatch(source, /\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b/);
});
