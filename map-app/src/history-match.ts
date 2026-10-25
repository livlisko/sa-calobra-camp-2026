import type {
  HistoryEffortQuality,
  HistoryMatchEvidence,
  HistoryMatchReason,
  HistoryMatchStatus,
  HistoryMetricCoverage,
  HistoryPosition,
  HistorySegmentCatalog,
  HistorySegmentMatch,
  HistorySegmentTemplate,
  HistoryTrackPoint,
  ImportedHistoryEffort,
  SegmentMatchThresholds,
} from "./history-types";

const EARTH_RADIUS_M = 6_371_008.8;
const TEMPLATE_SPACING_M = 25;
const MAX_EVIDENCE_SAMPLES = 400;
const COVERAGE_BINS = 20;

const DEFAULT_THRESHOLDS: Required<SegmentMatchThresholds> = {
  startRadiusM: 65,
  endRadiusM: 65,
  reviewRadiusM: 120,
  corridorMedianM: 45,
  corridorP95M: 110,
  minimumCoverage: 0.85,
  minimumMonotonicity: 0.82,
  minimumDistanceRatio: 0.78,
  maximumDistanceRatio: 1.28,
  maximumRecordGapSeconds: 30,
};

interface ContinuousBlock {
  startIndex: number;
  endIndex: number;
}

interface BoundaryCandidate {
  index: number;
  distanceM: number;
  timestampMs: number;
}

interface ScoredCandidate {
  match: HistorySegmentMatch;
  status: Extract<HistoryMatchStatus, "confirmed" | "review">;
}

interface WeightedMetric {
  value: number | null;
  coverage: number;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function rounded(value: number, digits = 4): number {
  const multiplier = 10 ** digits;
  return Math.round(value * multiplier) / multiplier;
}

function thresholdsFor(template: HistorySegmentTemplate): Required<SegmentMatchThresholds> {
  return { ...DEFAULT_THRESHOLDS, ...template.thresholds };
}

export function canonicalSegmentKey(stravaSegmentId: string, boundaryVersion: string): string {
  const segmentId = stravaSegmentId.trim();
  const version = boundaryVersion.trim();
  if (!/^\d+$/.test(segmentId)) throw new Error(`Invalid numeric Strava segment id: ${stravaSegmentId}`);
  if (!version) throw new Error("A non-empty segment boundary version is required.");
  return `strava:${segmentId}@${encodeURIComponent(version)}`;
}

function validPosition(value: HistoryPosition | undefined | null): value is HistoryPosition {
  return Boolean(
    value &&
    finite(value[0]) &&
    finite(value[1]) &&
    value[0] >= -180 &&
    value[0] <= 180 &&
    value[1] >= -90 &&
    value[1] <= 90,
  );
}

function geometryLines(template: HistorySegmentTemplate): HistoryPosition[][] {
  if (!template.geometry) return [];
  const lines = template.geometry.type === "LineString"
    ? [template.geometry.coordinates]
    : template.geometry.coordinates;
  return lines
    .map((line) => line.filter(validPosition))
    .filter((line) => line.length >= 2);
}

export function validateHistoryCatalog(catalog: HistorySegmentCatalog): void {
  if (!catalog.catalogVersion.trim()) throw new Error("History catalogVersion must not be empty.");
  const identities = new Set<string>();
  for (const segment of catalog.segments) {
    const identity = canonicalSegmentKey(segment.stravaSegmentId, segment.boundaryVersion);
    if (identities.has(identity)) throw new Error(`Duplicate exact segment definition: ${identity}`);
    identities.add(identity);
    if (!segment.campLabel.trim()) throw new Error(`${identity} is missing a camp label.`);
    if (!segment.templateHash.trim()) throw new Error(`${identity} is missing its template hash.`);
    if (segment.expectedDistanceM !== null && (!finite(segment.expectedDistanceM) || segment.expectedDistanceM <= 0)) {
      throw new Error(`${identity} has an invalid expected distance.`);
    }
    if (segment.matchReady && geometryLines(segment).length === 0) {
      throw new Error(`${identity} is marked match-ready without usable geometry.`);
    }
  }
}

export function haversineDistanceM(a: HistoryPosition, b: HistoryPosition): number {
  const latitudeA = a[1] * Math.PI / 180;
  const latitudeB = b[1] * Math.PI / 180;
  const latitudeDelta = latitudeB - latitudeA;
  const longitudeDelta = (b[0] - a[0]) * Math.PI / 180;
  const sinLatitude = Math.sin(latitudeDelta / 2);
  const sinLongitude = Math.sin(longitudeDelta / 2);
  const value = sinLatitude ** 2 + Math.cos(latitudeA) * Math.cos(latitudeB) * sinLongitude ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(value)));
}

function interpolatePosition(a: HistoryPosition, b: HistoryPosition, fraction: number): HistoryPosition {
  return [
    a[0] + (b[0] - a[0]) * fraction,
    a[1] + (b[1] - a[1]) * fraction,
  ];
}

function resampleLine(line: HistoryPosition[], spacingM: number): HistoryPosition[] {
  const output: HistoryPosition[] = [line[0]];
  let carryM = 0;
  for (let index = 1; index < line.length; index += 1) {
    let start = line[index - 1];
    const end = line[index];
    let remainingM = haversineDistanceM(start, end);
    if (remainingM <= 0) continue;
    while (carryM + remainingM >= spacingM) {
      const fraction = (spacingM - carryM) / remainingM;
      const inserted = interpolatePosition(start, end, fraction);
      output.push(inserted);
      start = inserted;
      remainingM = haversineDistanceM(start, end);
      carryM = 0;
      if (remainingM <= 0) break;
    }
    carryM += remainingM;
  }
  const finalPoint = line.at(-1)!;
  if (haversineDistanceM(output.at(-1)!, finalPoint) > 1) output.push(finalPoint);
  return output;
}

function templatePoints(template: HistorySegmentTemplate): HistoryPosition[] {
  const output: HistoryPosition[] = [];
  for (const line of geometryLines(template)) {
    const resampled = resampleLine(line, TEMPLATE_SPACING_M);
    if (output.length && haversineDistanceM(output.at(-1)!, resampled[0]) < 1) resampled.shift();
    output.push(...resampled);
  }
  return output;
}

function percentile(values: number[], percentileValue: number): number {
  if (!values.length) return Infinity;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(percentileValue * sorted.length) - 1));
  return sorted[index];
}

function splitContinuousBlocks(points: HistoryTrackPoint[], maximumGapSeconds: number): ContinuousBlock[] {
  const blocks: ContinuousBlock[] = [];
  let blockStart = 0;
  const closeBlock = (endIndex: number) => {
    if (endIndex - blockStart >= 2) blocks.push({ startIndex: blockStart, endIndex });
  };
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const timestampGapSeconds = (current.timestampMs - previous.timestampMs) / 1000;
    const distanceReset = previous.distanceM !== null && current.distanceM !== null && current.distanceM < previous.distanceM - 100;
    const breaks =
      timestampGapSeconds <= 0 ||
      timestampGapSeconds > maximumGapSeconds ||
      !previous.timerRunning ||
      !current.timerRunning ||
      distanceReset;
    if (breaks) {
      closeBlock(index - 1);
      blockStart = index;
    }
  }
  closeBlock(points.length - 1);
  return blocks;
}

function anchorCandidates(
  points: HistoryTrackPoint[],
  block: ContinuousBlock,
  anchor: HistoryPosition,
  radiusM: number,
): BoundaryCandidate[] {
  const candidates: BoundaryCandidate[] = [];
  let best: BoundaryCandidate | null = null;
  let previousNearIndex = -2;
  const flush = () => {
    if (best) candidates.push(best);
    best = null;
  };
  for (let index = block.startIndex; index <= block.endIndex; index += 1) {
    const coordinate = points[index].coordinate;
    if (!coordinate) continue;
    const distanceM = haversineDistanceM(coordinate, anchor);
    if (distanceM > radiusM) {
      if (best && index > previousNearIndex + 1) flush();
      continue;
    }
    if (best && index > previousNearIndex + 3) flush();
    const candidate = { index, distanceM, timestampMs: points[index].timestampMs };
    if (!best || candidate.distanceM < best.distanceM) best = candidate;
    previousNearIndex = index;
  }
  flush();
  return candidates;
}

function pointToSegmentProjection(
  point: HistoryPosition,
  a: HistoryPosition,
  b: HistoryPosition,
): { fraction: number; distanceM: number } {
  const latitudeRadians = point[1] * Math.PI / 180;
  const longitudeScale = Math.cos(latitudeRadians) * Math.PI / 180 * EARTH_RADIUS_M;
  const latitudeScale = Math.PI / 180 * EARTH_RADIUS_M;
  const ax = (a[0] - point[0]) * longitudeScale;
  const ay = (a[1] - point[1]) * latitudeScale;
  const bx = (b[0] - point[0]) * longitudeScale;
  const by = (b[1] - point[1]) * latitudeScale;
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const fraction = lengthSquared > 0 ? clamp(-(ax * dx + ay * dy) / lengthSquared) : 0;
  const projectedX = ax + dx * fraction;
  const projectedY = ay + dy * fraction;
  return { fraction, distanceM: Math.hypot(projectedX, projectedY) };
}

function boundaryTimestamp(
  points: HistoryTrackPoint[],
  candidateIndex: number,
  anchor: HistoryPosition,
  maximumGapSeconds: number,
): number {
  let bestTimestamp = points[candidateIndex].timestampMs;
  let bestDistance = points[candidateIndex].coordinate
    ? haversineDistanceM(points[candidateIndex].coordinate!, anchor)
    : Infinity;
  const pairs: Array<[number, number]> = [];
  if (candidateIndex > 0) pairs.push([candidateIndex - 1, candidateIndex]);
  if (candidateIndex + 1 < points.length) pairs.push([candidateIndex, candidateIndex + 1]);
  for (const [startIndex, endIndex] of pairs) {
    const start = points[startIndex];
    const end = points[endIndex];
    if (!start.coordinate || !end.coordinate) continue;
    const gapSeconds = (end.timestampMs - start.timestampMs) / 1000;
    if (gapSeconds <= 0 || gapSeconds > maximumGapSeconds || !start.timerRunning || !end.timerRunning) continue;
    const projection = pointToSegmentProjection(anchor, start.coordinate, end.coordinate);
    if (projection.distanceM >= bestDistance) continue;
    bestDistance = projection.distanceM;
    bestTimestamp = start.timestampMs + (end.timestampMs - start.timestampMs) * projection.fraction;
  }
  return bestTimestamp;
}

function sampledCoordinates(points: HistoryTrackPoint[], startIndex: number, endIndex: number): HistoryPosition[] {
  const coordinates: HistoryPosition[] = [];
  const count = endIndex - startIndex + 1;
  const stride = Math.max(1, Math.ceil(count / MAX_EVIDENCE_SAMPLES));
  for (let index = startIndex; index <= endIndex; index += stride) {
    const coordinate = points[index].coordinate;
    if (coordinate) coordinates.push(coordinate);
  }
  const finalCoordinate = points[endIndex]?.coordinate;
  if (finalCoordinate && coordinates.at(-1) !== finalCoordinate) coordinates.push(finalCoordinate);
  return coordinates;
}

function nearestTemplatePoint(
  coordinate: HistoryPosition,
  template: HistoryPosition[],
): { index: number; distanceM: number } {
  let bestIndex = 0;
  let bestDistanceM = Infinity;
  for (let index = 0; index < template.length; index += 1) {
    const distanceM = haversineDistanceM(coordinate, template[index]);
    if (distanceM < bestDistanceM) {
      bestDistanceM = distanceM;
      bestIndex = index;
    }
  }
  return { index: bestIndex, distanceM: bestDistanceM };
}

function recordedRouteDistanceM(points: HistoryTrackPoint[], startIndex: number, endIndex: number): number | null {
  const startDistance = points[startIndex]?.distanceM;
  const endDistance = points[endIndex]?.distanceM;
  if (startDistance !== null && startDistance !== undefined && endDistance !== null && endDistance !== undefined && endDistance >= startDistance) {
    return endDistance - startDistance;
  }
  let distanceM = 0;
  let pairs = 0;
  for (let index = startIndex + 1; index <= endIndex; index += 1) {
    const previous = points[index - 1].coordinate;
    const current = points[index].coordinate;
    if (!previous || !current) continue;
    distanceM += haversineDistanceM(previous, current);
    pairs += 1;
  }
  return pairs ? distanceM : null;
}

function scoreCandidate(
  points: HistoryTrackPoint[],
  template: HistorySegmentTemplate,
  templateLine: HistoryPosition[],
  start: BoundaryCandidate,
  end: BoundaryCandidate,
): ScoredCandidate | null {
  const thresholds = thresholdsFor(template);
  const coordinates = sampledCoordinates(points, start.index, end.index);
  if (coordinates.length < 5) return null;
  const nearest = coordinates.map((coordinate) => nearestTemplatePoint(coordinate, templateLine));
  const lateralErrors = nearest.map((entry) => entry.distanceM);
  const progresses = nearest.map((entry) => entry.index / Math.max(1, templateLine.length - 1));
  const visitedBins = new Set<number>();
  nearest.forEach((entry) => {
    if (entry.distanceM <= thresholds.reviewRadiusM) {
      visitedBins.add(Math.min(COVERAGE_BINS - 1, Math.floor((entry.index / templateLine.length) * COVERAGE_BINS)));
    }
  });
  const templateCoverage = visitedBins.size / COVERAGE_BINS;
  let orderedSteps = 0;
  for (let index = 1; index < progresses.length; index += 1) {
    if (progresses[index] >= progresses[index - 1] - 0.04) orderedSteps += 1;
  }
  const orderedProgress = progresses.length > 1 ? orderedSteps / (progresses.length - 1) : 0;
  const insideCorridorRatio = lateralErrors.filter((value) => value <= thresholds.corridorP95M).length / lateralErrors.length;
  const medianLateralErrorM = percentile(lateralErrors, 0.5);
  const p95LateralErrorM = percentile(lateralErrors, 0.95);
  const routeDistanceM = recordedRouteDistanceM(points, start.index, end.index);
  const expectedDistanceM = template.expectedDistanceM ?? (() => {
    let sum = 0;
    for (let index = 1; index < templateLine.length; index += 1) {
      sum += haversineDistanceM(templateLine[index - 1], templateLine[index]);
    }
    return sum;
  })();
  const distanceRatio = routeDistanceM !== null && expectedDistanceM > 0 ? routeDistanceM / expectedDistanceM : null;

  const startScore = 1 - clamp(start.distanceM / thresholds.reviewRadiusM);
  const endScore = 1 - clamp(end.distanceM / thresholds.reviewRadiusM);
  const lateralScore = 1 - clamp(medianLateralErrorM / (thresholds.corridorMedianM * 2));
  const distanceScore = distanceRatio === null
    ? 0.5
    : 1 - clamp(Math.abs(Math.log(Math.max(0.01, distanceRatio))) / Math.log(1.75));
  const score = clamp(
    startScore * 0.12 +
    endScore * 0.12 +
    templateCoverage * 0.24 +
    orderedProgress * 0.2 +
    insideCorridorRatio * 0.12 +
    lateralScore * 0.12 +
    distanceScore * 0.08,
  );

  const confirmedChecks = {
    start: start.distanceM <= thresholds.startRadiusM,
    end: end.distanceM <= thresholds.endRadiusM,
    coverage: templateCoverage >= thresholds.minimumCoverage,
    order: orderedProgress >= thresholds.minimumMonotonicity,
    lateral: medianLateralErrorM <= thresholds.corridorMedianM && p95LateralErrorM <= thresholds.corridorP95M && insideCorridorRatio >= 0.85,
    distance: distanceRatio === null || (distanceRatio >= thresholds.minimumDistanceRatio && distanceRatio <= thresholds.maximumDistanceRatio),
  };
  const reviewChecks = {
    start: start.distanceM <= thresholds.reviewRadiusM,
    end: end.distanceM <= thresholds.reviewRadiusM,
    coverage: templateCoverage >= Math.max(0.5, thresholds.minimumCoverage - 0.25),
    order: orderedProgress >= Math.max(0.6, thresholds.minimumMonotonicity - 0.2),
    lateral: medianLateralErrorM <= thresholds.corridorMedianM * 2 && p95LateralErrorM <= thresholds.corridorP95M * 1.75 && insideCorridorRatio >= 0.55,
    distance: distanceRatio === null || (distanceRatio >= 0.6 && distanceRatio <= 1.65),
  };
  if (!Object.values(reviewChecks).every(Boolean)) return null;

  const reasons: HistoryMatchReason[] = [];
  if (!confirmedChecks.start) reasons.push("start_too_far");
  if (!confirmedChecks.end) reasons.push("end_too_far");
  if (!confirmedChecks.coverage) reasons.push("insufficient_corridor_coverage");
  if (!confirmedChecks.order) reasons.push("insufficient_ordered_progress");
  if (!confirmedChecks.lateral) reasons.push("lateral_error_too_high");
  if (!confirmedChecks.distance) reasons.push("distance_outside_confirmed_range");
  const status: Extract<HistoryMatchStatus, "confirmed" | "review"> = reasons.length ? "review" : "confirmed";
  const evidence: HistoryMatchEvidence = {
    score: rounded(score),
    startDistanceM: rounded(start.distanceM, 1),
    endDistanceM: rounded(end.distanceM, 1),
    routeDistanceM: routeDistanceM === null ? null : rounded(routeDistanceM, 1),
    distanceRatio: distanceRatio === null ? null : rounded(distanceRatio),
    templateCoverage: rounded(templateCoverage),
    orderedProgress: rounded(orderedProgress),
    insideCorridorRatio: rounded(insideCorridorRatio),
    medianLateralErrorM: rounded(medianLateralErrorM, 1),
    p95LateralErrorM: rounded(p95LateralErrorM, 1),
    sampledPointCount: coordinates.length,
  };
  const segmentKey = canonicalSegmentKey(template.stravaSegmentId, template.boundaryVersion);
  return {
    status,
    match: {
      segmentKey,
      stravaSegmentId: template.stravaSegmentId,
      boundaryVersion: template.boundaryVersion,
      campLabel: template.campLabel,
      templateHash: template.templateHash,
      status,
      confidence: status === "confirmed" ? (score >= 0.85 ? "high" : "medium") : "low",
      reasons,
      evidence,
      window: {
        startIndex: start.index,
        endIndex: end.index,
        startTimestampMs: boundaryTimestamp(points, start.index, templateLine[0], thresholds.maximumRecordGapSeconds),
        endTimestampMs: boundaryTimestamp(points, end.index, templateLine.at(-1)!, thresholds.maximumRecordGapSeconds),
      },
    },
  };
}

function overlaps(a: HistorySegmentMatch, b: HistorySegmentMatch): boolean {
  if (!a.window || !b.window) return false;
  return a.window.startIndex <= b.window.endIndex && b.window.startIndex <= a.window.endIndex;
}

function selectNonOverlapping(candidates: ScoredCandidate[]): HistorySegmentMatch[] {
  const ordered = [...candidates].sort((a, b) => (b.match.evidence?.score ?? 0) - (a.match.evidence?.score ?? 0));
  const selected: HistorySegmentMatch[] = [];
  for (const candidate of ordered) {
    if (selected.some((entry) => overlaps(entry, candidate.match))) continue;
    const alternatives = ordered.filter((entry) => entry !== candidate && overlaps(entry.match, candidate.match));
    const closeAlternative = alternatives.some(
      (entry) => Math.abs((entry.match.evidence?.score ?? 0) - (candidate.match.evidence?.score ?? 0)) <= 0.05,
    );
    if (closeAlternative && candidate.match.status === "confirmed") {
      candidate.match.status = "review";
      candidate.match.confidence = "low";
      candidate.match.reasons = [...candidate.match.reasons, "ambiguous_window"];
    }
    selected.push(candidate.match);
  }
  return selected.sort((a, b) => (a.window?.startTimestampMs ?? 0) - (b.window?.startTimestampMs ?? 0));
}

function matchTemplate(points: HistoryTrackPoint[], template: HistorySegmentTemplate): HistorySegmentMatch[] {
  const segmentKey = canonicalSegmentKey(template.stravaSegmentId, template.boundaryVersion);
  if (!template.matchReady || !template.geometry) {
    return [{
      segmentKey,
      stravaSegmentId: template.stravaSegmentId,
      boundaryVersion: template.boundaryVersion,
      campLabel: template.campLabel,
      templateHash: template.templateHash,
      status: "unavailable",
      confidence: "none",
      reasons: ["catalog_template_unavailable"],
      evidence: null,
      window: null,
    }];
  }
  const line = templatePoints(template);
  if (line.length < 2) return [];
  const thresholds = thresholdsFor(template);
  const blocks = splitContinuousBlocks(points, thresholds.maximumRecordGapSeconds);
  const candidates: ScoredCandidate[] = [];
  for (const block of blocks) {
    const starts = anchorCandidates(points, block, line[0], thresholds.reviewRadiusM);
    const ends = anchorCandidates(points, block, line.at(-1)!, thresholds.reviewRadiusM);
    for (const start of starts) {
      for (const end of ends) {
        if (end.index <= start.index + 2 || end.timestampMs <= start.timestampMs + 10_000) continue;
        const scored = scoreCandidate(points, template, line, start, end);
        if (scored) candidates.push(scored);
      }
    }
  }
  const selected = selectNonOverlapping(candidates);
  if (selected.length) return selected;
  return [{
    segmentKey,
    stravaSegmentId: template.stravaSegmentId,
    boundaryVersion: template.boundaryVersion,
    campLabel: template.campLabel,
    templateHash: template.templateHash,
    status: "not_found",
    confidence: "none",
    reasons: [],
    evidence: null,
    window: null,
  }];
}

export function matchHistoryTrack(
  points: HistoryTrackPoint[],
  catalog: HistorySegmentCatalog,
): HistorySegmentMatch[] {
  validateHistoryCatalog(catalog);
  const matches = catalog.segments.flatMap((template) => matchTemplate(points, template));
  // A FIT trace has no Strava segment identifier. When two catalog versions
  // resolve to effectively the same time window, keep both exact identities
  // but require review instead of guessing which Strava boundary produced it.
  for (let leftIndex = 0; leftIndex < matches.length; leftIndex += 1) {
    const left = matches[leftIndex];
    if (!left.window || (left.status !== "confirmed" && left.status !== "review")) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < matches.length; rightIndex += 1) {
      const right = matches[rightIndex];
      if (!right.window || left.segmentKey === right.segmentKey) continue;
      if (right.status !== "confirmed" && right.status !== "review") continue;
      const leftDuration = left.window.endTimestampMs - left.window.startTimestampMs;
      const rightDuration = right.window.endTimestampMs - right.window.startTimestampMs;
      const nearlySameBoundaries =
        Math.abs(left.window.startTimestampMs - right.window.startTimestampMs) <= 30_000 &&
        Math.abs(left.window.endTimestampMs - right.window.endTimestampMs) <= 30_000 &&
        Math.max(leftDuration, rightDuration) / Math.max(1, Math.min(leftDuration, rightDuration)) <= 1.08;
      if (!nearlySameBoundaries) continue;
      for (const match of [left, right]) {
        match.status = "review";
        match.confidence = "low";
        if (!match.reasons.includes("ambiguous_window")) match.reasons.push("ambiguous_window");
      }
    }
  }
  return matches;
}

function weightedMetric(
  points: HistoryTrackPoint[],
  startTimestampMs: number,
  endTimestampMs: number,
  selector: (point: HistoryTrackPoint) => number | null,
  maximumGapSeconds: number,
): WeightedMetric {
  let weightedSum = 0;
  let coveredSeconds = 0;
  let eligibleSeconds = 0;
  for (let index = 0; index + 1 < points.length; index += 1) {
    const point = points[index];
    const next = points[index + 1];
    const intervalStart = Math.max(startTimestampMs, point.timestampMs);
    const intervalEnd = Math.min(endTimestampMs, next.timestampMs);
    if (intervalEnd <= intervalStart) continue;
    const rawSeconds = (next.timestampMs - point.timestampMs) / 1000;
    if (rawSeconds <= 0 || rawSeconds > maximumGapSeconds || !point.timerRunning || !next.timerRunning) continue;
    const seconds = (intervalEnd - intervalStart) / 1000;
    eligibleSeconds += seconds;
    const value = selector(point);
    if (!finite(value)) continue;
    weightedSum += value * seconds;
    coveredSeconds += seconds;
  }
  return {
    value: coveredSeconds > 0 ? weightedSum / coveredSeconds : null,
    coverage: eligibleSeconds > 0 ? coveredSeconds / eligibleSeconds : 0,
  };
}

function valueAtTimestamp(
  points: HistoryTrackPoint[],
  timestampMs: number,
  selector: (point: HistoryTrackPoint) => number | null,
): number | null {
  for (let index = 0; index + 1 < points.length; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    if (timestampMs < start.timestampMs || timestampMs > end.timestampMs) continue;
    const startValue = selector(start);
    const endValue = selector(end);
    if (!finite(startValue) || !finite(endValue) || end.timestampMs <= start.timestampMs) return startValue ?? endValue ?? null;
    const fraction = (timestampMs - start.timestampMs) / (end.timestampMs - start.timestampMs);
    return startValue + (endValue - startValue) * fraction;
  }
  return null;
}

function elevationGain(
  points: HistoryTrackPoint[],
  startTimestampMs: number,
  endTimestampMs: number,
  maximumGapSeconds: number,
): number | null {
  let gain = 0;
  let validPairs = 0;
  for (let index = 0; index + 1 < points.length; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    if (start.timestampMs < startTimestampMs || end.timestampMs > endTimestampMs) continue;
    const seconds = (end.timestampMs - start.timestampMs) / 1000;
    if (seconds <= 0 || seconds > maximumGapSeconds || !start.timerRunning || !end.timerRunning) continue;
    if (start.altitudeM === null || end.altitudeM === null) continue;
    gain += Math.max(0, end.altitudeM - start.altitudeM);
    validPairs += 1;
  }
  return validPairs ? gain : null;
}

function movingSeconds(
  points: HistoryTrackPoint[],
  startTimestampMs: number,
  endTimestampMs: number,
  maximumGapSeconds: number,
): number {
  let total = 0;
  for (let index = 0; index + 1 < points.length; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    const intervalStart = Math.max(startTimestampMs, start.timestampMs);
    const intervalEnd = Math.min(endTimestampMs, end.timestampMs);
    if (intervalEnd <= intervalStart) continue;
    const rawSeconds = (end.timestampMs - start.timestampMs) / 1000;
    if (rawSeconds <= 0 || rawSeconds > maximumGapSeconds || !start.timerRunning || !end.timerRunning) continue;
    total += (intervalEnd - intervalStart) / 1000;
  }
  return total;
}

function effortQuality(match: HistorySegmentMatch, moving: number, coverage: HistoryMetricCoverage): HistoryEffortQuality {
  if (!match.window || moving <= 0 || !match.evidence || match.evidence.sampledPointCount < 5) return "insufficient";
  const recordedCoverage = [coverage.power, coverage.heartRate, coverage.cadence, coverage.altitude]
    .filter((value) => value > 0);
  if (match.status === "review" || !recordedCoverage.length || Math.min(...recordedCoverage) < 0.9) {
    return "partial";
  }
  return "complete";
}

export function deriveHistoryEffort(
  sourceId: string,
  effortId: string,
  catalogVersion: string,
  points: HistoryTrackPoint[],
  match: HistorySegmentMatch,
  maximumGapSeconds = DEFAULT_THRESHOLDS.maximumRecordGapSeconds,
): ImportedHistoryEffort | null {
  if (!match.window || (match.status !== "confirmed" && match.status !== "review") || !match.evidence) return null;
  const { startTimestampMs, endTimestampMs } = match.window;
  if (endTimestampMs <= startTimestampMs) return null;
  const power = weightedMetric(points, startTimestampMs, endTimestampMs, (point) => point.powerW, maximumGapSeconds);
  const heartRate = weightedMetric(points, startTimestampMs, endTimestampMs, (point) => point.heartRateBpm, maximumGapSeconds);
  const cadence = weightedMetric(points, startTimestampMs, endTimestampMs, (point) => point.cadenceRpm, maximumGapSeconds);
  const altitude = weightedMetric(points, startTimestampMs, endTimestampMs, (point) => point.altitudeM, maximumGapSeconds);
  const moving = movingSeconds(points, startTimestampMs, endTimestampMs, maximumGapSeconds);
  const startDistanceM = valueAtTimestamp(points, startTimestampMs, (point) => point.distanceM);
  const endDistanceM = valueAtTimestamp(points, endTimestampMs, (point) => point.distanceM);
  const distanceM = startDistanceM !== null && endDistanceM !== null && endDistanceM >= startDistanceM
    ? endDistanceM - startDistanceM
    : match.evidence.routeDistanceM;
  const coverage: HistoryMetricCoverage = {
    power: rounded(power.coverage),
    heartRate: rounded(heartRate.coverage),
    cadence: rounded(cadence.coverage),
    altitude: rounded(altitude.coverage),
  };
  // A comparison headline should describe almost the entire segment, not a
  // short sensor fragment. Keep the coverage visible in the ledger and omit
  // a metric from trends unless at least 90% of moving time is represented.
  const minimumMetricCoverage = 0.9;
  return {
    effortId,
    sourceId,
    source: "fit-derived",
    catalogVersion,
    segmentKey: match.segmentKey,
    stravaSegmentId: match.stravaSegmentId,
    boundaryVersion: match.boundaryVersion,
    campLabel: match.campLabel,
    templateHash: match.templateHash,
    startedAtIso: new Date(startTimestampMs).toISOString(),
    elapsedSeconds: Math.max(0, Math.round((endTimestampMs - startTimestampMs) / 1000)),
    movingSeconds: Math.max(0, Math.round(moving)),
    distanceM: distanceM === null ? null : rounded(distanceM, 1),
    elevationGainM: (() => {
      const value = elevationGain(points, startTimestampMs, endTimestampMs, maximumGapSeconds);
      return value === null ? null : rounded(value, 1);
    })(),
    averagePowerW: power.value === null || power.coverage < minimumMetricCoverage ? null : rounded(power.value, 1),
    averageHeartRateBpm: heartRate.value === null || heartRate.coverage < minimumMetricCoverage ? null : rounded(heartRate.value, 1),
    averageCadenceRpm: cadence.value === null || cadence.coverage < minimumMetricCoverage ? null : rounded(cadence.value, 1),
    coverage,
    matchStatus: match.status,
    matchConfidence: match.confidence === "none" ? "low" : match.confidence,
    matchScore: match.evidence.score,
    matchReasons: [...match.reasons],
    quality: effortQuality(match, moving, coverage),
  };
}
