import FitParser from "fit-file-parser";
import { deriveHistoryEffort, matchHistoryTrack, validateHistoryCatalog } from "./history-match";
import type {
  HistoryImportResult,
  HistoryImportWarning,
  HistoryPosition,
  HistorySegmentCatalog,
  HistorySegmentMatch,
  HistoryTrackPoint,
} from "./history-types";

export const MAX_HISTORY_FIT_BYTES = 64 * 1024 * 1024;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): UnknownRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function timestampMs(value: unknown): number | null {
  if (value instanceof Date && Number.isFinite(value.valueOf())) return value.valueOf();
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function degrees(value: unknown, kind: "latitude" | "longitude"): number | null {
  const number = finiteNumber(value);
  if (number === null) return null;
  const limit = kind === "latitude" ? 90 : 180;
  const converted = Math.abs(number) > limit ? number * 180 / 2 ** 31 : number;
  return converted >= -limit && converted <= limit ? converted : null;
}

function coordinate(record: UnknownRecord): HistoryPosition | null {
  const latitude = degrees(record.position_lat ?? record.positionLat, "latitude");
  const longitude = degrees(record.position_long ?? record.positionLong, "longitude");
  return latitude === null || longitude === null ? null : [longitude, latitude];
}

function normalizedText(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase().replaceAll(" ", "_") : "";
}

function isCyclingSession(session: UnknownRecord): boolean {
  const sport = session.sport;
  if (sport === 2) return true;
  const text = normalizedText(sport);
  return text.includes("cycl") || text.includes("bik");
}

function hasSportMetadata(session: UnknownRecord): boolean {
  const sport = session.sport;
  return (typeof sport === "number" && Number.isFinite(sport)) || normalizedText(sport).length > 0;
}

function cyclingWindows(parsed: UnknownRecord): Array<[number, number]> {
  const sessions = records(parsed.sessions ?? parsed.sessionMesgs);
  return sessions.filter(isCyclingSession).flatMap((session) => {
    const start = timestampMs(session.start_time ?? session.startTime);
    const timestampEnd = timestampMs(session.timestamp);
    const elapsedSeconds = finiteNumber(session.total_elapsed_time ?? session.totalElapsedTime);
    // Some Garmin activity files expose the session timestamp as the session
    // start. Prefer the latest defensible end without extending beyond metadata.
    const elapsedEnd = start !== null && elapsedSeconds !== null && elapsedSeconds > 0
      ? start + elapsedSeconds * 1000
      : null;
    const endCandidates = [timestampEnd, elapsedEnd].filter((value): value is number => value !== null);
    const end = endCandidates.length ? Math.max(...endCandidates) : null;
    if (start === null || end === null || end <= start) return [];
    return [[start, end] as [number, number]];
  });
}

function timerTransitions(parsed: UnknownRecord): Array<{ timestampMs: number; running: boolean }> {
  const events = records(parsed.events ?? parsed.eventMesgs);
  const transitions: Array<{ timestampMs: number; running: boolean }> = [];
  for (const event of events) {
    const eventName = normalizedText(event.event);
    const eventType = normalizedText(event.event_type ?? event.eventType);
    if (eventName && eventName !== "timer" && event.event !== 0) continue;
    const at = timestampMs(event.timestamp);
    if (at === null) continue;
    if (eventType === "start" || event.event_type === 0) transitions.push({ timestampMs: at, running: true });
    if (eventType.startsWith("stop") || [1, 4, 8, 9].includes(Number(event.event_type))) {
      transitions.push({ timestampMs: at, running: false });
    }
  }
  return transitions.sort((a, b) => a.timestampMs - b.timestampMs);
}

function normalizeTrack(
  parsed: UnknownRecord,
  warnings: Set<HistoryImportWarning>,
): { decodedRecordCount: number; points: HistoryTrackPoint[] } {
  const rawRecords = records(parsed.records ?? parsed.recordMesgs);
  const windows = cyclingWindows(parsed);
  const sessions = records(parsed.sessions ?? parsed.sessionMesgs);
  const hasCyclingSession = sessions.some(isCyclingSession);
  const explicitlyNonCycling = sessions.some(hasSportMetadata) && !hasCyclingSession;
  if (explicitlyNonCycling) {
    warnings.add("non_cycling_session");
    return { decodedRecordCount: rawRecords.length, points: [] };
  }
  if (!hasCyclingSession) warnings.add("no_cycling_session_metadata");
  const transitions = timerTransitions(parsed);
  let transitionIndex = 0;
  let timerRunning = true;
  let missingTimestamps = 0;
  const points: HistoryTrackPoint[] = [];

  for (const record of rawRecords) {
    const at = timestampMs(record.timestamp);
    if (at === null) {
      missingTimestamps += 1;
      continue;
    }
    if (windows.length && !windows.some(([start, end]) => at >= start && at <= end)) continue;
    while (transitionIndex < transitions.length && transitions[transitionIndex].timestampMs <= at) {
      timerRunning = transitions[transitionIndex].running;
      transitionIndex += 1;
    }
    points.push({
      timestampMs: at,
      coordinate: coordinate(record),
      distanceM: finiteNumber(record.distance),
      altitudeM: finiteNumber(record.enhanced_altitude ?? record.altitude ?? record.enhancedAltitude),
      powerW: finiteNumber(record.power),
      heartRateBpm: finiteNumber(record.heart_rate ?? record.heartRate),
      cadenceRpm: finiteNumber(record.cadence),
      speedMps: finiteNumber(record.enhanced_speed ?? record.speed ?? record.enhancedSpeed),
      timerRunning,
    });
  }
  points.sort((a, b) => a.timestampMs - b.timestampMs);
  if (missingTimestamps) warnings.add("some_records_missing_timestamps");
  if (!points.some((point) => point.coordinate !== null)) warnings.add("no_gps_records");
  return { decodedRecordCount: rawRecords.length, points };
}

function publicMatch(match: HistorySegmentMatch): Omit<HistorySegmentMatch, "window"> {
  const { window: _window, ...safe } = match;
  return safe;
}

function parserError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(typeof error === "string" ? error : "The FIT file could not be decoded.");
}

/**
 * Decode and reduce one FIT file. The returned value contains effort summaries
 * only. Raw bytes, filenames, coordinates, device metadata, and record arrays
 * are never returned from the worker boundary.
 */
export async function parseFitHistory(
  bytes: ArrayBuffer,
  sourceId: string,
  catalog: HistorySegmentCatalog,
  onPhase?: (phase: "decoding" | "matching" | "finalizing") => void,
): Promise<HistoryImportResult> {
  if (!sourceId.trim()) throw new Error("A private, session-local sourceId is required.");
  if (bytes.byteLength > MAX_HISTORY_FIT_BYTES) {
    throw new Error(`FIT input exceeds the ${MAX_HISTORY_FIT_BYTES} byte safety limit.`);
  }
  validateHistoryCatalog(catalog);
  onPhase?.("decoding");
  const parser = new FitParser({
    force: false,
    strict: true,
    mode: "list",
    lengthUnit: "m",
    speedUnit: "m/s",
    temperatureUnit: "celsius",
  });
  let parsedValue: unknown;
  try {
    parsedValue = await parser.parseAsync(bytes);
  } catch (error) {
    throw parserError(error);
  }
  if (!isRecord(parsedValue)) throw new Error("The FIT decoder returned an unsupported result.");
  const warnings = new Set<HistoryImportWarning>();
  const normalized = normalizeTrack(parsedValue, warnings);

  onPhase?.("matching");
  const matches = matchHistoryTrack(normalized.points, catalog);
  const efforts = matches.flatMap((match, index) => {
    const effort = deriveHistoryEffort(
      sourceId,
      `${sourceId}:${match.segmentKey}:${index + 1}`,
      catalog.catalogVersion,
      normalized.points,
      match,
    );
    return effort ? [effort] : [];
  });
  if (!efforts.length) warnings.add("no_matching_segments");

  onPhase?.("finalizing");
  return {
    sourceId,
    parser: "fit-file-parser",
    integrity: "strict-crc-valid",
    startedAtIso: normalized.points.length ? new Date(normalized.points[0].timestampMs).toISOString() : null,
    endedAtIso: normalized.points.length ? new Date(normalized.points.at(-1)!.timestampMs).toISOString() : null,
    decodedRecordCount: normalized.decodedRecordCount,
    usableRecordCount: normalized.points.length,
    efforts,
    matches: matches.map(publicMatch),
    warnings: [...warnings],
  };
}
