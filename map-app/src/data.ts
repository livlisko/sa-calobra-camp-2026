import type {
  AtlasData,
  Bounds,
  LineString,
  MultiLineString,
  Place,
  Polygon,
  Position,
  Ride,
  RouteGeometry,
  Segment,
  TelemetrySample,
} from "./types";

const SNAPSHOT_URL = "./data/mallorca-map.snapshot.json";
const DEFAULT_BOUNDS: Bounds = [2.3447, 39.2643, 3.4788, 39.9626];
const DEFAULT_COLORS = ["#ff7657", "#e8bd55", "#62c9ae", "#9e88ff", "#4fb4e8", "#f38fc0"];

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const object = (value: unknown): UnknownRecord => (isRecord(value) ? value : {});
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function nullableText(value: unknown): string | null {
  const result = text(value).trim();
  return result ? result : null;
}

function number(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function firstNumber(record: UnknownRecord, keys: string[]): number | null {
  for (const key of keys) {
    const value = number(record[key]);
    if (value !== null) return value;
  }
  return null;
}

function firstText(record: UnknownRecord, keys: string[]): string | null {
  for (const key of keys) {
    const value = nullableText(record[key]);
    if (value) return value;
  }
  return null;
}

function position(value: unknown): Position | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const longitude = number(value[0]);
  const latitude = number(value[1]);
  if (longitude === null || latitude === null) return null;
  if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) return null;
  return [longitude, latitude];
}

function bounds(value: unknown, fallback: Bounds): Bounds {
  if (!Array.isArray(value) || value.length < 4) return fallback;
  const values = value.slice(0, 4).map(number);
  if (values.some((entry) => entry === null)) return fallback;
  return values as Bounds;
}

function lineCoordinates(value: unknown): Position[] {
  return array(value).map(position).filter((entry): entry is Position => entry !== null);
}

function routeGeometry(value: unknown): MultiLineString {
  const geometry = object(value);
  const source = geometry.coordinates ?? value;
  if (geometry.type === "LineString") {
    const line = lineCoordinates(source);
    return { type: "MultiLineString", coordinates: line.length > 1 ? [line] : [] };
  }
  const maybeLines = array(source);
  if (maybeLines.length && position(maybeLines[0])) {
    const line = lineCoordinates(maybeLines);
    return { type: "MultiLineString", coordinates: line.length > 1 ? [line] : [] };
  }
  const lines = maybeLines.map(lineCoordinates).filter((line) => line.length > 1);
  return { type: "MultiLineString", coordinates: lines };
}

function lineGeometry(value: unknown): LineString | null {
  const geometry = object(value);
  const coordinates = lineCoordinates(geometry.coordinates ?? value);
  return coordinates.length > 1 ? { type: "LineString", coordinates } : null;
}

function segmentGeometry(value: unknown): RouteGeometry | null {
  const geometry = object(value);
  if (geometry.type === "MultiLineString") {
    const route = routeGeometry(geometry);
    return route.coordinates.length ? route : null;
  }
  return lineGeometry(value);
}

function polygonGeometry(value: unknown): Polygon | null {
  const wrapper = object(value);
  const geometry = wrapper.type === "Feature" ? object(wrapper.geometry) : wrapper;
  if ((geometry.type !== "Polygon" && geometry.type !== "MultiPolygon") || !Array.isArray(geometry.coordinates)) {
    return null;
  }
  return { type: geometry.type, coordinates: geometry.coordinates };
}

function computedBounds(geometry: MultiLineString, fallback: Bounds): Bounds {
  const coordinates = geometry.coordinates.flat();
  if (!coordinates.length) return fallback;
  return coordinates.reduce<Bounds>(
    (result, [longitude, latitude]) => [
      Math.min(result[0], longitude),
      Math.min(result[1], latitude),
      Math.max(result[2], longitude),
      Math.max(result[3], latitude),
    ],
    [Infinity, Infinity, -Infinity, -Infinity],
  );
}

function normalizeSample(rawValue: unknown, rideId: string, index: number): TelemetrySample | null {
  const raw = object(rawValue);
  const coordinate = position(raw.coordinate ?? raw.coordinates ?? raw.position);
  if (!coordinate) return null;
  return {
    sampleId: firstText(raw, ["sampleId", "id"]) ?? `${rideId}-point-${String(index + 1).padStart(4, "0")}`,
    rideId,
    movingSeconds: firstNumber(raw, ["movingSeconds", "movingTimeSeconds", "elapsedSeconds"]) ?? 0,
    distanceKm: firstNumber(raw, ["distanceKm", "distanceKilometers"]) ?? 0,
    coordinate,
    recordedAltitudeM: firstNumber(raw, ["recordedAltitudeM", "altitudeM", "elevationM"]),
    powerMeanW: firstNumber(raw, ["powerMeanW", "averagePowerW", "powerW"]),
    powerMaxW: firstNumber(raw, ["powerMaxW", "maxPowerW"]),
    heartRateMeanBpm: firstNumber(raw, ["heartRateMeanBpm", "averageHeartRateBpm", "heartRateBpm"]),
    cadenceMeanRpm: firstNumber(raw, ["cadenceMeanRpm", "averageCadenceRpm", "cadenceRpm"]),
    recordedTemperatureC: firstNumber(raw, ["recordedTemperatureC", "temperatureC"]),
    speedMeanKmh: firstNumber(raw, ["speedMeanKmh", "averageSpeedKmh", "speedKmh"]),
    gradePct: firstNumber(raw, ["gradePct", "smoothedGradePct", "gradeMeanPct"]),
    segmentId: firstText(raw, ["segmentId"]) ?? array(raw.segmentIds).map((entry) => text(entry)).find(Boolean) ?? null,
    label: firstText(raw, ["label", "name"]),
  };
}

function addDerivedGrades(samples: TelemetrySample[]): TelemetrySample[] {
  return samples.map((sample, index) => {
    if (sample.gradePct !== null) return sample;
    const before = samples[Math.max(0, index - 2)];
    const after = samples[Math.min(samples.length - 1, index + 2)];
    if (!before || !after || before.recordedAltitudeM === null || after.recordedAltitudeM === null) return sample;
    const distanceM = (after.distanceKm - before.distanceKm) * 1000;
    const movingSpan = after.movingSeconds - before.movingSeconds;
    if (distanceM < 30 || movingSpan <= 0 || movingSpan > 180) return sample;
    const grade = ((after.recordedAltitudeM - before.recordedAltitudeM) / distanceM) * 100;
    return { ...sample, gradePct: Math.abs(grade) <= 40 ? grade : null };
  });
}

function normalizeRide(rawValue: unknown, index: number): Ride {
  const raw = object(rawValue);
  const summary = object(raw.summary ?? raw.stats);
  const rideId = firstText(raw, ["rideId", "id"]) ?? `ride-${index + 1}`;
  const geometry = routeGeometry(raw.route ?? raw.routeGeometry ?? raw.routeCoordinates);
  const telemetry = addDerivedGrades(array(raw.telemetrySamples ?? raw.telemetryPoints ?? raw.telemetry)
    .map((sample, sampleIndex) => normalizeSample(sample, rideId, sampleIndex))
    .filter((sample): sample is TelemetrySample => sample !== null)
    .sort((a, b) => a.movingSeconds - b.movingSeconds || a.distanceKm - b.distanceKm));
  const routeBounds = computedBounds(geometry, DEFAULT_BOUNDS);
  const explicitBounds = raw.boundsWsen ?? raw.publicBoundsWsen ?? raw.bounds;
  return {
    rideId,
    date: firstText(raw, ["date", "rideDate"]) ?? "",
    label: firstText(raw, ["label", "name", "title"]) ?? `Ride ${index + 1}`,
    subtitle: firstText(raw, ["subtitle", "orientation"]),
    color: firstText(raw, ["color"]) ?? DEFAULT_COLORS[index % DEFAULT_COLORS.length],
    summary: {
      distanceKm: firstNumber(summary, ["distanceKm", "distanceKilometers"]) ?? firstNumber(raw, ["distanceKm"]),
      ascentM: firstNumber(summary, ["ascentM", "elevationGainM", "totalAscentM"]) ?? firstNumber(raw, ["ascentM"]),
      movingSeconds: firstNumber(summary, ["movingSeconds", "movingTimeSeconds"]) ?? firstNumber(raw, ["movingSeconds"]),
      averagePowerW: firstNumber(summary, ["averagePowerW", "avgPowerW"]),
      normalizedPowerW: firstNumber(summary, ["normalizedPowerW", "npW"]),
      trainingLoad: firstNumber(summary, ["trainingLoad", "tss"]),
    },
    route: geometry,
    boundsWsen: bounds(explicitBounds, routeBounds),
    labelCoordinate: position(raw.labelCoordinate ?? raw.labelPoint),
    telemetrySamples: telemetry,
    note: firstText(raw, ["note", "dataNote", "officialSegmentNote"]),
  };
}

function normalizeSegment(rawValue: unknown, index: number): Segment {
  const raw = object(rawValue);
  const stats = object(raw.stats ?? raw.metrics);
  const geometry = segmentGeometry(raw.geometry ?? raw.route ?? raw.coordinates);
  const explicitMatch = typeof raw.matched === "boolean" ? raw.matched : text(raw.status).toLowerCase() === "matched";
  const matched = explicitMatch || geometry !== null;
  const stravaSegmentId = raw.stravaSegmentId;
  return {
    segmentId: firstText(raw, ["segmentId", "ledgerId", "id"]) ?? `segment-${index + 1}`,
    rideId: firstText(raw, ["rideId"]) ?? "",
    campLabel: firstText(raw, ["campLabel", "name", "label"]) ?? `Segment ${index + 1}`,
    currentStravaTitle: firstText(raw, ["currentStravaTitle", "stravaTitle"]),
    stravaSegmentId:
      typeof stravaSegmentId === "string" || typeof stravaSegmentId === "number" ? stravaSegmentId : null,
    stravaUrl: firstText(raw, ["stravaUrl", "url"]),
    matched,
    geometry: matched ? geometry : null,
    startPoint: position(raw.startPoint) ?? (geometry ? (geometry.type === "LineString" ? geometry.coordinates[0] : geometry.coordinates[0]?.[0]) : null) ?? null,
    endPoint: position(raw.endPoint) ?? (geometry ? (geometry.type === "LineString" ? geometry.coordinates.at(-1) : geometry.coordinates.at(-1)?.at(-1)) : null) ?? null,
    stats: {
      elapsedSeconds: firstNumber(stats, ["elapsedSeconds", "timeSeconds"]),
      distanceKm: firstNumber(stats, ["distanceKm"]),
      elevationGainM: firstNumber(stats, ["elevationGainM", "ascentM"]),
      averageGradePct: firstNumber(stats, ["averageGradePct", "gradePct"]),
      averagePowerW: firstNumber(stats, ["averagePowerW", "powerW"]),
      averageHeartRateBpm: firstNumber(stats, ["averageHeartRateBpm", "heartRateBpm"]),
    },
    confidence: firstText(raw, ["confidence"]),
    boundaryBasis: firstText(raw, ["boundaryBasis"]),
    note: firstText(raw, ["note"]),
  };
}

function normalizePlace(rawValue: unknown, index: number): Place | null {
  const raw = object(rawValue);
  const coordinates = position(raw.coordinates ?? raw.coordinate ?? raw.position);
  if (!coordinates) return null;
  return {
    id: firstText(raw, ["id", "placeId"]) ?? `place-${index + 1}`,
    name: firstText(raw, ["name", "label"]) ?? `Place ${index + 1}`,
    kind: firstText(raw, ["kind", "type"]) ?? "orientation",
    coordinates,
    region: firstText(raw, ["region"]),
    shortOrientationNote: firstText(raw, ["shortOrientationNote", "note", "description"]),
    approximate: typeof raw.approximate === "boolean" ? raw.approximate : true,
  };
}

function normalizeProvenance(value: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(object(value))
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .map(([key, entry]) => [key, entry.trim()]),
  );
}

export function normalizeAtlasData(value: unknown): AtlasData {
  const raw = object(value);
  const metadata = object(raw.metadata);
  const map = object(raw.map);
  const boundarySource = object(map.boundarySource);
  const rides = array(raw.rides).map(normalizeRide);
  const segments = array(raw.segments).map(normalizeSegment);
  const places = array(raw.places ?? raw.orientationPlaces)
    .map(normalizePlace)
    .filter((entry): entry is Place => entry !== null);
  const result: AtlasData = {
    schemaVersion: firstText(raw, ["schemaVersion"]) ?? firstText(metadata, ["schemaVersion"]) ?? "unknown",
    generatedAt: firstText(raw, ["generatedAt"]) ?? firstText(metadata, ["generatedAt"]),
    map: {
      crs: firstText(map, ["crs"]) ?? "EPSG:4326",
      islandBoundsWsen: bounds(map.islandBoundsWsen ?? map.boundsWsen ?? metadata.bounds, DEFAULT_BOUNDS),
      islandBoundary: polygonGeometry(map.islandBoundary ?? raw.islandBoundary),
      boundaryAttribution:
        firstText(boundarySource, ["attribution"]) ?? "© OpenStreetMap contributors",
    },
    rides,
    segments,
    places,
    provenance: normalizeProvenance(raw.provenance),
    sourceNotes: array(metadata.sourceNotes ?? raw.sourceNotes).map((entry) => text(entry)).filter(Boolean),
  };
  validateAtlasData(result);
  return result;
}

export function validateAtlasData(data: AtlasData): void {
  const failures: string[] = [];
  if (data.rides.length !== 6) failures.push(`expected 6 rides, received ${data.rides.length}`);
  if (data.segments.length !== 17) failures.push(`expected 17 segment-ledger entries, received ${data.segments.length}`);
  const matchedCount = data.segments.filter((segment) => segment.matched).length;
  if (matchedCount !== 15) failures.push(`expected 15 matched segments, received ${matchedCount}`);
  if (data.rides.some((ride) => !ride.route.coordinates.length)) failures.push("one or more rides has no route geometry");
  if (data.segments.some((segment) => segment.matched && !segment.geometry)) {
    failures.push("one or more matched segments has no rider-trace geometry");
  }
  if (data.segments.some((segment) => !segment.matched && segment.geometry)) {
    failures.push("an unmatched segment incorrectly contains ridden geometry");
  }
  const rideIds = new Set(data.rides.map((ride) => ride.rideId));
  if (data.segments.some((segment) => !rideIds.has(segment.rideId))) failures.push("a segment references an unknown ride");
  if (failures.length) throw new Error(`Map snapshot failed validation: ${failures.join("; ")}.`);
}

export async function loadAtlasData(signal?: AbortSignal): Promise<AtlasData> {
  const response = await fetch(SNAPSHOT_URL, { signal, cache: "no-store" });
  if (!response.ok) throw new Error(`Could not load the reviewed map snapshot (${response.status}).`);
  return normalizeAtlasData(await response.json());
}
