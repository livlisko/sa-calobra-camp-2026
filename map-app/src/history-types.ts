export type HistoryPosition = readonly [longitude: number, latitude: number];

export type HistoryLineString = {
  type: "LineString";
  coordinates: HistoryPosition[];
};

export type HistoryMultiLineString = {
  type: "MultiLineString";
  coordinates: HistoryPosition[][];
};

export type HistoryRouteGeometry = HistoryLineString | HistoryMultiLineString;

export interface SegmentMatchThresholds {
  startRadiusM?: number;
  endRadiusM?: number;
  reviewRadiusM?: number;
  corridorMedianM?: number;
  corridorP95M?: number;
  minimumCoverage?: number;
  minimumMonotonicity?: number;
  minimumDistanceRatio?: number;
  maximumDistanceRatio?: number;
  maximumRecordGapSeconds?: number;
}

/**
 * One exact segment boundary definition. A same-name Strava segment with a
 * different numeric id or boundaryVersion is intentionally a different item.
 */
export interface HistorySegmentTemplate {
  stravaSegmentId: string;
  boundaryVersion: string;
  campLabel: string;
  templateHash: string;
  geometry: HistoryRouteGeometry | null;
  expectedDistanceM: number | null;
  matchReady: boolean;
  thresholds?: SegmentMatchThresholds;
  note?: string | null;
}

export interface HistorySegmentCatalog {
  catalogVersion: string;
  segments: HistorySegmentTemplate[];
}

export interface HistoryTrackPoint {
  timestampMs: number;
  coordinate: HistoryPosition | null;
  distanceM: number | null;
  altitudeM: number | null;
  powerW: number | null;
  heartRateBpm: number | null;
  cadenceRpm: number | null;
  speedMps: number | null;
  timerRunning: boolean;
}

export type HistoryMatchStatus = "confirmed" | "review" | "not_found" | "unavailable";
export type HistoryMatchConfidence = "high" | "medium" | "low" | "none";

export type HistoryMatchReason =
  | "ambiguous_window"
  | "catalog_template_unavailable"
  | "distance_outside_confirmed_range"
  | "end_too_far"
  | "insufficient_corridor_coverage"
  | "insufficient_ordered_progress"
  | "lateral_error_too_high"
  | "start_too_far";

export interface HistoryMatchEvidence {
  score: number;
  startDistanceM: number;
  endDistanceM: number;
  routeDistanceM: number | null;
  distanceRatio: number | null;
  templateCoverage: number;
  orderedProgress: number;
  insideCorridorRatio: number;
  medianLateralErrorM: number;
  p95LateralErrorM: number;
  sampledPointCount: number;
}

export interface HistoryMatchedWindow {
  startIndex: number;
  endIndex: number;
  startTimestampMs: number;
  endTimestampMs: number;
}

export interface HistorySegmentMatch {
  segmentKey: string;
  stravaSegmentId: string;
  boundaryVersion: string;
  campLabel: string;
  templateHash: string;
  status: HistoryMatchStatus;
  confidence: HistoryMatchConfidence;
  reasons: HistoryMatchReason[];
  evidence: HistoryMatchEvidence | null;
  /** Internal indexes are useful for deriving metrics and are removed from the worker response. */
  window: HistoryMatchedWindow | null;
}

export interface HistoryMetricCoverage {
  power: number;
  heartRate: number;
  cadence: number;
  altitude: number;
}

export type HistoryEffortQuality = "complete" | "partial" | "insufficient";

/**
 * Privacy-minimal effort returned to the UI. It deliberately contains no
 * filename, activity id, full route, raw samples, or Strava effort id.
 */
export interface ImportedHistoryEffort {
  effortId: string;
  sourceId: string;
  source: "fit-derived";
  catalogVersion: string;
  segmentKey: string;
  stravaSegmentId: string;
  boundaryVersion: string;
  campLabel: string;
  templateHash: string;
  startedAtIso: string;
  elapsedSeconds: number;
  movingSeconds: number;
  distanceM: number | null;
  elevationGainM: number | null;
  averagePowerW: number | null;
  averageHeartRateBpm: number | null;
  averageCadenceRpm: number | null;
  coverage: HistoryMetricCoverage;
  matchStatus: Extract<HistoryMatchStatus, "confirmed" | "review">;
  matchConfidence: Exclude<HistoryMatchConfidence, "none">;
  matchScore: number;
  matchReasons: HistoryMatchReason[];
  quality: HistoryEffortQuality;
}

export type HistoryImportWarning =
  | "no_cycling_session_metadata"
  | "non_cycling_session"
  | "no_gps_records"
  | "no_matching_segments"
  | "some_records_missing_timestamps";

export interface HistoryImportResult {
  sourceId: string;
  parser: "fit-file-parser";
  integrity: "strict-crc-valid";
  startedAtIso: string | null;
  endedAtIso: string | null;
  decodedRecordCount: number;
  usableRecordCount: number;
  efforts: ImportedHistoryEffort[];
  matches: Array<Omit<HistorySegmentMatch, "window">>;
  warnings: HistoryImportWarning[];
}

export type HistoryWorkerErrorCode =
  | "cancelled"
  | "file_too_large"
  | "invalid_catalog"
  | "invalid_fit"
  | "unsupported_fit";

export interface HistoryWorkerParseRequest {
  type: "parse";
  requestId: string;
  sourceId: string;
  bytes: ArrayBuffer;
  catalog: HistorySegmentCatalog;
}

export interface HistoryWorkerCancelRequest {
  type: "cancel";
  requestId: string;
}

export type HistoryWorkerRequest = HistoryWorkerParseRequest | HistoryWorkerCancelRequest;

export interface HistoryWorkerProgressMessage {
  type: "progress";
  requestId: string;
  sourceId: string;
  phase: "decoding" | "matching" | "finalizing";
}

export interface HistoryWorkerResultMessage {
  type: "result";
  requestId: string;
  sourceId: string;
  result: HistoryImportResult;
}

export interface HistoryWorkerFailureMessage {
  type: "failure";
  requestId: string;
  sourceId: string;
  code: HistoryWorkerErrorCode;
  message: string;
}

export type HistoryWorkerMessage =
  | HistoryWorkerProgressMessage
  | HistoryWorkerResultMessage
  | HistoryWorkerFailureMessage;
