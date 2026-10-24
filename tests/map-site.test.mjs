import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");
const snapshotPath = path.join(repoRoot, "site", "map", "data", "mallorca-map.snapshot.json");
const snapshotText = await readFile(snapshotPath, "utf8");
const snapshot = JSON.parse(snapshotText);

function normalizedLabel(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function isPosition(value) {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1]) &&
    value[0] >= -180 &&
    value[0] <= 180 &&
    value[1] >= -90 &&
    value[1] <= 90
  );
}

function isRouteGeometry(value) {
  if (!value || typeof value !== "object") return false;
  if (value.type === "LineString") {
    return Array.isArray(value.coordinates) && value.coordinates.length > 1 && value.coordinates.every(isPosition);
  }
  return (
    value.type === "MultiLineString" &&
    Array.isArray(value.coordinates) &&
    value.coordinates.length > 0 &&
    value.coordinates.every(
      (line) => Array.isArray(line) && line.length > 1 && line.every(isPosition),
    )
  );
}

function collectObjectKeys(value, result = []) {
  if (Array.isArray(value)) {
    for (const entry of value) collectObjectKeys(entry, result);
  } else if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      result.push(key);
      collectObjectKeys(entry, result);
    }
  }
  return result;
}

test("map snapshot carries the reviewed six-ride and segment contract", () => {
  assert.match(String(snapshot.schemaVersion), /^mallorca-relief(?:-map)?-v\d+$/);
  assert.equal(snapshot.rides.length, 6);
  assert.equal(snapshot.segments.length, 17);
  assert.equal(snapshot.segments.filter((segment) => segment.matched).length, 15);

  const rideIds = new Set(snapshot.rides.map((ride) => ride.rideId));
  assert.equal(rideIds.size, 6);
  assert.deepEqual(
    snapshot.rides.slice(0, 2).map((ride) => ride.label),
    ["Santa Magdalena reroute", "Betlem & Sant Salvador"],
  );

  for (const ride of snapshot.rides) {
    assert.equal(isRouteGeometry(ride.route), true, `${ride.rideId} route geometry`);
    assert.ok(Array.isArray(ride.telemetrySamples) && ride.telemetrySamples.length > 0, `${ride.rideId} telemetry`);
    assert.ok(ride.telemetrySamples.every((sample) => isPosition(sample.coordinate)), `${ride.rideId} sample coordinates`);
    assert.ok(
      ride.telemetrySamples.every(
        (sample, index, samples) =>
          index === 0 ||
          (sample.movingSeconds >= samples[index - 1].movingSeconds &&
            sample.distanceKm >= samples[index - 1].distanceKm),
      ),
      `${ride.rideId} telemetry order`,
    );
  }

  for (const segment of snapshot.segments) {
    assert.equal(rideIds.has(segment.rideId), true, `${segment.segmentId} ride reference`);
    assert.equal(
      segment.matched ? isRouteGeometry(segment.geometry) : segment.geometry == null,
      true,
      `${segment.segmentId} geometry/match state`,
    );
  }

  assert.deepEqual(
    snapshot.segments
      .filter((segment) => !segment.matched)
      .map((segment) => normalizedLabel(segment.campLabel))
      .sort(),
    ["sa batalla", "santa llucia"],
  );
  assert.equal(
    snapshot.segments.some((segment) => normalizedLabel(segment.campLabel) === "puig maria"),
    false,
  );

  const caffeineRide = snapshot.rides.find((ride) => ride.label === "Caffeine Ride");
  assert.ok(caffeineRide);
  assert.equal(snapshot.segments.filter((segment) => segment.rideId === caffeineRide.rideId).length, 0);

  const metricAnchors = [
    ["puig major", 3199, 235.6],
    ["sa calobra", 2573, 230.1],
  ];
  for (const [label, elapsedSeconds, averagePowerW] of metricAnchors) {
    const segment = snapshot.segments.find(
      (candidate) => normalizedLabel(candidate.campLabel) === label,
    );
    assert.ok(segment, label);
    assert.equal(segment.stats.elapsedSeconds, elapsedSeconds, `${label} elapsed seconds`);
    assert.equal(segment.stats.averagePowerW, averagePowerW, `${label} average power`);
  }
});

test("map snapshot provides island context, attribution, and orientation points", () => {
  assert.equal(snapshot.map?.crs, "EPSG:4326");
  assert.ok(Array.isArray(snapshot.map?.islandBoundsWsen) && snapshot.map.islandBoundsWsen.length === 4);
  assert.ok(snapshot.map?.islandBoundary?.type === "Polygon" || snapshot.map?.islandBoundary?.type === "MultiPolygon");
  assert.match(JSON.stringify(snapshot.map?.boundarySource ?? snapshot.sources ?? {}), /OpenStreetMap/i);
  assert.ok(Array.isArray(snapshot.places) && snapshot.places.length >= 5);
  assert.ok(snapshot.places.every((place) => isPosition(place.coordinates)));
});

test("map snapshot respects the public privacy boundary", () => {
  const publicText = snapshotText;
  for (const forbidden of [
    "/Users/",
    "data-app-local-thread",
    "data-app-sites-project",
    "appgprj_",
  ]) {
    assert.equal(publicText.includes(forbidden), false, forbidden);
  }
  assert.doesNotMatch(publicText, /\b\d{11}_ACTIVITY(?: 2)?\.fit\b/);
  assert.doesNotMatch(publicText, /strava\.com\/activities\/\d+/);
  assert.doesNotMatch(publicText, /\b(?:activity|effort)(?:_|-)?id\b/i);
  assert.doesNotMatch(publicText, /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i);
  const keys = collectObjectKeys(snapshot);
  assert.equal(keys.some((key) => /(?:activity|effort).*id/i.test(key)), false);
  assert.equal(keys.some((key) => /(?:fitFile|deviceSerial|athleteId|profileId|localPath)/i.test(key)), false);

  const boundaryText = JSON.stringify(snapshot.privacy ?? snapshot.metadata?.privacy ?? {});
  assert.match(boundaryText, /(?:trim|mask|redact)/i);

  const endpointCounts = new Map();
  for (const ride of snapshot.rides) {
    const lines = ride.route.type === "LineString" ? [ride.route.coordinates] : ride.route.coordinates;
    for (const point of [lines[0][0], lines.at(-1).at(-1)]) {
      const key = `${point[0].toFixed(5)},${point[1].toFixed(5)}`;
      endpointCounts.set(key, (endpointCounts.get(key) ?? 0) + 1);
    }
  }
  assert.ok(Math.max(...endpointCounts.values()) < 3, "three or more route endpoints expose one repeated location");
});

test("optional contentHash binds the canonical public snapshot", () => {
  if (snapshot.contentHash == null) return;
  assert.match(snapshot.contentHash, /^sha256:[a-f0-9]{64}$/);
  const actual = execFileSync(
    "python3",
    [
      "-c",
      [
        "import hashlib,json,sys",
        "data=json.load(open(sys.argv[1], encoding='utf-8'))",
        "data.pop('contentHash', None)",
        "canonical=json.dumps(data, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')",
        "print('sha256:'+hashlib.sha256(canonical).hexdigest())",
      ].join(";"),
      snapshotPath,
    ],
    { encoding: "utf8" },
  ).trim();
  assert.equal(snapshot.contentHash, actual);
});

test("map build ships and binds a same-origin MapLibre worker", async () => {
  const mapDir = path.join(repoRoot, "site", "map");
  const assetsDir = path.join(mapDir, "assets");
  const assetNames = await readdir(assetsDir);
  const workerNames = assetNames.filter((name) => /^maplibre-gl-worker-[a-zA-Z0-9_-]+\.mjs$/.test(name));
  const appNames = assetNames.filter((name) => /^index-[a-zA-Z0-9_-]+\.js$/.test(name));
  assert.equal(workerNames.length, 1, "one hashed MapLibre worker asset");
  assert.equal(appNames.length, 1, "one hashed application module");
  const appModule = await readFile(path.join(assetsDir, appNames[0]), "utf8");
  assert.equal(appModule.includes(workerNames[0]), true, "application binds the emitted worker URL");
});
