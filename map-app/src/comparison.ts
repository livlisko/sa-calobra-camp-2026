import "./comparison.css";
import type { HistoryEffortQuality, HistoryMetricCoverage, ImportedHistoryEffort } from "./history-types";

export type ComparisonMetric = "time" | "power" | "heart-rate";
export type ComparisonBaseline = "previous" | "best";
export type ComparisonEffortScope = "personal" | "published-reference";
export type ComparisonMatchStatus = "exact" | "confirmed" | "provisional" | "unmatched";
export type ComparisonEffortSource = "fit-derived" | "strava-reported" | "published-reviewed" | "manual";

export interface ComparisonSegment {
  /** Public atlas segment key, for example `segment-14`. */
  segmentId: string;
  /** Camp-facing name. Names are labels only and must never be used as join keys. */
  campLabel: string;
  stravaSegmentId?: string | number | null;
  /** Stable boundary/version key. Different same-name segment versions must use different keys. */
  versionKey?: string | null;
  stageLabel?: string | null;
}

export interface ComparisonRankSnapshot {
  position: number;
  fieldSize: number;
  scope?: string | null;
  capturedDate?: string | null;
}

export interface ComparisonEffort {
  /** Local opaque key. Never place this value in a share URL. */
  effortId: string;
  segmentId: string;
  /** Must match the catalog segment version after geometry review. */
  segmentVersionKey?: string | null;
  activityDate: string;
  elapsedSeconds: number | null;
  averagePowerW: number | null;
  averageHeartRateBpm: number | null;
  scope: ComparisonEffortScope;
  matchStatus: ComparisonMatchStatus;
  source: ComparisonEffortSource;
  label?: string | null;
  rankSnapshot?: ComparisonRankSnapshot | null;
  coverage?: HistoryMetricCoverage | null;
  quality?: HistoryEffortQuality | null;
}

export type ComparisonImportStatus = "idle" | "parsing" | "review" | "ready" | "error";

export interface ComparisonImportState {
  status: ComparisonImportStatus;
  filesProcessed?: number;
  exactCount?: number;
  confirmedCount?: number;
  provisionalCount?: number;
  unmatchedCount?: number;
  errorMessages?: string[];
  rememberedOnDevice?: boolean;
  lastImportedAt?: string | null;
}

export interface ComparisonDataset {
  segments: ComparisonSegment[];
  efforts: ComparisonEffort[];
  importState?: ComparisonImportState;
}

export interface ComparisonViewState {
  selectedSegmentId: string | null;
  metric: ComparisonMetric;
  baseline: ComparisonBaseline;
  showSingleAttempts: boolean;
}

export interface ComparisonControllerOptions {
  root: HTMLElement;
  dataset: ComparisonDataset;
  initialState?: Partial<ComparisonViewState>;
  onStateChange?: (state: Readonly<ComparisonViewState>) => void;
  onSegmentSelect?: (segmentId: string | null) => void;
  onFilesSelected?: (files: File[]) => void | Promise<void>;
  onReviewMatches?: () => void;
  onForgetHistory?: () => void | Promise<void>;
  onPersistenceChange?: (remembered: boolean) => void | Promise<void>;
  /** Owner-only action. Anonymous visitors must not adopt the public reference implicitly. */
  onAdoptPublishedReference?: (effortId: string) => void | Promise<void>;
}

export interface ComparisonController {
  getState(): Readonly<ComparisonViewState>;
  setState(patch: Partial<ComparisonViewState>, notify?: boolean): void;
  setDataset(dataset: ComparisonDataset): void;
  selectSegment(segmentId: string | null, notify?: boolean): void;
  render(): void;
  destroy(): void;
}

export interface SegmentComparisonSummary {
  segment: ComparisonSegment;
  personalAttempts: ComparisonEffort[];
  provisionalAttempts: ComparisonEffort[];
  referenceAttempts: ComparisonEffort[];
  latest: ComparisonEffort | null;
  previous: ComparisonEffort | null;
  priorBest: ComparisonEffort | null;
}

/**
 * Adapts the privacy-minimal worker result to the presentation contract.
 * The caller must resolve `atlasSegmentId` from the numeric-id + boundary
 * catalog; this helper deliberately never falls back to a name match.
 */
export function comparisonEffortFromImportedHistory(
  effort: ImportedHistoryEffort,
  atlasSegmentId: string,
): ComparisonEffort {
  return {
    effortId: effort.effortId,
    segmentId: atlasSegmentId,
    segmentVersionKey: effort.segmentKey,
    activityDate: effort.startedAtIso,
    elapsedSeconds: effort.elapsedSeconds,
    averagePowerW: effort.averagePowerW,
    averageHeartRateBpm: effort.averageHeartRateBpm,
    scope: "personal",
    matchStatus: effort.matchStatus === "confirmed" ? "confirmed" : "provisional",
    source: "fit-derived",
    coverage: { ...effort.coverage },
    quality: effort.quality,
  };
}

const DEFAULT_STATE: ComparisonViewState = {
  selectedSegmentId: null,
  metric: "time",
  baseline: "previous",
  showSingleAttempts: false,
};

const METRIC_LABELS: Record<ComparisonMetric, string> = {
  time: "Time",
  power: "Power",
  "heart-rate": "Heart rate",
};

const VALID_MATCHES = new Set<ComparisonMatchStatus>(["exact", "confirmed"]);

let comparisonInstance = 0;

function node<K extends keyof HTMLElementTagNameMap>(
  name: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const result = document.createElement(name);
  if (className) result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}

function control(className: string, text: string): HTMLButtonElement {
  const result = node("button", className, text);
  result.type = "button";
  return result;
}

function canonicalStravaId(value: string | number | null | undefined): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(Math.trunc(value));
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

export function segmentVersionKey(segment: ComparisonSegment): string {
  const explicit = segment.versionKey?.trim();
  if (explicit) return explicit;
  const stravaId = canonicalStravaId(segment.stravaSegmentId);
  return stravaId ? `strava:${stravaId}` : `catalog:${segment.segmentId}`;
}

function effortBelongsToSegment(effort: ComparisonEffort, segment: ComparisonSegment): boolean {
  if (effort.segmentId !== segment.segmentId) return false;
  const effortVersion = effort.segmentVersionKey?.trim();
  return !effortVersion || effortVersion === segmentVersionKey(segment);
}

function validDateValue(value: string): number {
  const date = new Date(`${value.length === 10 ? `${value}T12:00:00Z` : value}`);
  return Number.isFinite(date.valueOf()) ? date.valueOf() : 0;
}

function chronological(a: ComparisonEffort, b: ComparisonEffort): number {
  return validDateValue(a.activityDate) - validDateValue(b.activityDate) || a.effortId.localeCompare(b.effortId);
}

export function summarizeComparisonDataset(dataset: ComparisonDataset): SegmentComparisonSummary[] {
  return dataset.segments.map((segment) => {
    const related = dataset.efforts.filter((effort) => effortBelongsToSegment(effort, segment));
    const personalAttempts = related
      .filter((effort) => effort.scope === "personal" && VALID_MATCHES.has(effort.matchStatus))
      .sort(chronological);
    const provisionalAttempts = related
      .filter((effort) => effort.scope === "personal" && effort.matchStatus === "provisional")
      .sort(chronological);
    const referenceAttempts = related
      .filter((effort) => effort.scope === "published-reference" && VALID_MATCHES.has(effort.matchStatus))
      .sort(chronological);
    const latest = personalAttempts.at(-1) ?? null;
    const previous = personalAttempts.at(-2) ?? null;
    const priorBestCandidates = latest
      ? personalAttempts.filter((effort) => effort.effortId !== latest.effortId && effort.elapsedSeconds !== null)
      : [];
    const priorBest = priorBestCandidates.sort((a, b) => a.elapsedSeconds! - b.elapsedSeconds!)[0] ?? null;
    return { segment, personalAttempts, provisionalAttempts, referenceAttempts, latest, previous, priorBest };
  });
}

function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "Not recorded";
  const rounded = Math.max(0, Math.round(seconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remainder = rounded % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function formatDate(value: string, compact = false): string {
  const milliseconds = validDateValue(value);
  if (!milliseconds) return value || "Date unavailable";
  return new Intl.DateTimeFormat("en", compact
    ? { year: "numeric" }
    : { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
    .format(new Date(milliseconds));
}

function metricValue(effort: ComparisonEffort, metric: ComparisonMetric): number | null {
  if (metric === "time") return effort.elapsedSeconds;
  if (metric === "power") return effort.averagePowerW;
  return effort.averageHeartRateBpm;
}

function formatMetric(value: number | null, metric: ComparisonMetric): string {
  if (value === null || !Number.isFinite(value)) return "Not recorded";
  if (metric === "time") return formatDuration(value);
  if (metric === "power") return `${Math.round(value)} W`;
  return `${Math.round(value)} bpm`;
}

function signedNumber(value: number): string {
  if (Math.abs(value) < 0.5) return "0";
  return `${value > 0 ? "+" : "−"}${Math.abs(Math.round(value))}`;
}

export function formatComparisonDelta(
  latest: ComparisonEffort | null,
  baseline: ComparisonEffort | null,
  metric: ComparisonMetric,
  baselineLabel: string,
): string {
  if (!latest) return "No confirmed personal attempt yet";
  if (!baseline) return "Only one confirmed personal attempt";
  const latestValue = metricValue(latest, metric);
  const baselineValue = metricValue(baseline, metric);
  if (latestValue === null) return `${METRIC_LABELS[metric]} was not recorded for the latest attempt`;
  if (baselineValue === null) return `${METRIC_LABELS[metric]} was not recorded for ${baselineLabel}`;
  const difference = latestValue - baselineValue;
  if (metric === "time") {
    if (Math.abs(difference) < 0.5) return `Matched ${baselineLabel}`;
    return `${formatDuration(Math.abs(difference))} ${difference < 0 ? "faster" : "slower"} than ${baselineLabel}`;
  }
  if (Math.abs(difference) < 0.5) return `Matched ${baselineLabel}`;
  const unit = metric === "power" ? "W" : "bpm";
  return `${Math.abs(Math.round(difference))} ${unit} ${difference > 0 ? "higher" : "lower"} than ${baselineLabel}`;
}

function sourceLabel(source: ComparisonEffortSource): string {
  if (source === "fit-derived") return "FIT-derived";
  if (source === "strava-reported") return "Strava-reported";
  if (source === "published-reviewed") return "Reviewed publication";
  return "Manual entry";
}

function effortSourceSummary(effort: ComparisonEffort): string {
  const label = sourceLabel(effort.source);
  if (!effort.coverage || effort.source !== "fit-derived") return label;
  const coverage = [
    ["power", effort.coverage.power],
    ["HR", effort.coverage.heartRate],
    ["cadence", effort.coverage.cadence],
  ] as const;
  const recorded = coverage.filter(([, value]) => value > 0);
  if (!recorded.length) return `${label} · time only`;
  return `${label} · ${recorded.map(([metric, value]) => `${metric} ${Math.round(value * 100)}%`).join(" · ")}`;
}

function changeCell(latest: ComparisonEffort, baseline: ComparisonEffort | null, metric: ComparisonMetric): string {
  if (!baseline) return "Not comparable";
  const latestValue = metricValue(latest, metric);
  const baselineValue = metricValue(baseline, metric);
  if (latestValue === null || baselineValue === null) return "Not comparable";
  const difference = latestValue - baselineValue;
  if (metric === "time") {
    if (Math.abs(difference) < 0.5) return "No change";
    return `${formatDuration(Math.abs(difference))} ${difference < 0 ? "faster" : "slower"}`;
  }
  return `${signedNumber(difference)} ${metric === "power" ? "W" : "bpm"}`;
}

function baselineFor(summary: SegmentComparisonSummary, baseline: ComparisonBaseline): ComparisonEffort | null {
  return baseline === "best" ? summary.priorBest : summary.previous;
}

function metricHasComparison(summary: SegmentComparisonSummary, metric: ComparisonMetric): boolean {
  return summary.personalAttempts.filter((effort) => metricValue(effort, metric) !== null).length >= 2;
}

function createMetricToggle(
  state: ComparisonViewState,
  summary: SegmentComparisonSummary,
  onSelect: (metric: ComparisonMetric) => void,
): HTMLElement {
  const group = node("div", "comparison-metric-toggle");
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", "Comparison metric");
  (["time", "power", "heart-rate"] as ComparisonMetric[]).forEach((metric) => {
    const item = control("comparison-chip", METRIC_LABELS[metric]);
    item.dataset.metric = metric;
    item.setAttribute("aria-pressed", String(state.metric === metric));
    const available = metric === "time" || metricHasComparison(summary, metric);
    item.disabled = !available;
    if (!available) item.title = `At least two attempts with ${METRIC_LABELS[metric].toLowerCase()} are required.`;
    item.addEventListener("click", () => onSelect(metric));
    group.append(item);
  });
  return group;
}

function createTimeline(summary: SegmentComparisonSummary, metric: ComparisonMetric): HTMLElement {
  const wrapper = node("section", "comparison-timeline-block");
  const heading = node("div", "comparison-section-heading");
  heading.append(node("h4", "", `${METRIC_LABELS[metric]} over time`));
  heading.append(node("span", "", metric === "time" ? "Lower is faster" : "Recorded average"));
  wrapper.append(heading);
  const points = summary.personalAttempts
    .map((effort) => ({ effort, value: metricValue(effort, metric) }))
    .filter((entry): entry is { effort: ComparisonEffort; value: number } => entry.value !== null);
  if (points.length < 2) {
    wrapper.append(node("p", "comparison-inline-empty", `At least two attempts with ${METRIC_LABELS[metric].toLowerCase()} are needed for a trend.`));
    return wrapper;
  }

  const width = 640;
  const height = 190;
  const inset = { top: 27, right: 42, bottom: 43, left: 42 };
  const values = points.map((entry) => entry.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const spread = Math.max(1, max - min);
  const dates = points.map((entry) => validDateValue(entry.effort.activityDate));
  const firstDate = Math.min(...dates);
  const lastDate = Math.max(...dates);
  const dateSpread = Math.max(1, lastDate - firstDate);
  const x = (entry: { effort: ComparisonEffort }, index: number) => {
    const date = validDateValue(entry.effort.activityDate);
    const ratio = date && firstDate !== lastDate ? (date - firstDate) / dateSpread : index / Math.max(1, points.length - 1);
    return inset.left + ratio * (width - inset.left - inset.right);
  };
  const y = (value: number) => {
    const ratio = (value - min) / spread;
    // Shorter time belongs higher on the time chart; larger recorded values
    // belong higher for power and heart rate.
    const visualRatio = metric === "time" ? ratio : 1 - ratio;
    return inset.top + visualRatio * (height - inset.top - inset.bottom);
  };

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("class", "comparison-timeline");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `${summary.segment.campLabel} ${METRIC_LABELS[metric].toLowerCase()} across ${points.length} confirmed personal attempts.`);

  const polyline = document.createElementNS(svg.namespaceURI, "polyline");
  polyline.setAttribute("points", points.map((entry, index) => `${x(entry, index)},${y(entry.value)}`).join(" "));
  polyline.setAttribute("class", "comparison-timeline-line");
  svg.append(polyline);

  points.forEach((entry, index) => {
    const group = document.createElementNS(svg.namespaceURI, "g");
    group.setAttribute("class", index === points.length - 1 ? "comparison-timeline-point is-latest" : "comparison-timeline-point");
    const circle = document.createElementNS(svg.namespaceURI, "circle");
    circle.setAttribute("cx", String(x(entry, index)));
    circle.setAttribute("cy", String(y(entry.value)));
    circle.setAttribute("r", index === points.length - 1 ? "6.5" : "5");
    const value = document.createElementNS(svg.namespaceURI, "text");
    value.setAttribute("x", String(x(entry, index)));
    value.setAttribute("y", String(Math.max(13, y(entry.value) - 12)));
    value.setAttribute("text-anchor", "middle");
    value.setAttribute("class", "comparison-timeline-value");
    value.textContent = formatMetric(entry.value, metric);
    const date = document.createElementNS(svg.namespaceURI, "text");
    date.setAttribute("x", String(x(entry, index)));
    date.setAttribute("y", String(height - 15));
    date.setAttribute("text-anchor", "middle");
    date.setAttribute("class", "comparison-timeline-date");
    date.textContent = formatDate(entry.effort.activityDate, true);
    group.append(circle, value, date);
    svg.append(group);
  });
  wrapper.append(svg);
  return wrapper;
}

function createMetricLedger(summary: SegmentComparisonSummary, baseline: ComparisonEffort | null, baselineName: string): HTMLElement {
  const wrapper = node("section", "comparison-ledger-block");
  wrapper.append(node("h4", "comparison-section-title", "Latest attempt, side by side"));
  if (!summary.latest) return wrapper;
  const tableWrap = node("div", "comparison-table-wrap");
  const table = node("table", "comparison-metric-table");
  const caption = node("caption", "comparison-sr-only", `${summary.segment.campLabel} latest attempt compared with ${baselineName}`);
  const header = node("thead");
  const headerRow = node("tr");
  ["Metric", "Latest", baselineName, "Change"].forEach((label) => headerRow.append(node("th", "", label)));
  header.append(headerRow);
  const body = node("tbody");
  (["time", "power", "heart-rate"] as ComparisonMetric[]).forEach((metric) => {
    const row = node("tr");
    row.append(
      node("th", "", METRIC_LABELS[metric]),
      node("td", "", formatMetric(metricValue(summary.latest!, metric), metric)),
      node("td", "", baseline ? formatMetric(metricValue(baseline, metric), metric) : "—"),
      node("td", "comparison-change", changeCell(summary.latest!, baseline, metric)),
    );
    body.append(row);
  });
  table.append(caption, header, body);
  tableWrap.append(table);
  wrapper.append(tableWrap);
  return wrapper;
}

function rankText(rank: ComparisonRankSnapshot): string {
  const scope = rank.scope?.trim() ? ` · ${rank.scope.trim()}` : "";
  const captured = rank.capturedDate?.trim() ? ` · captured ${formatDate(rank.capturedDate)}` : "";
  return `Reported rank ${rank.position} of ${rank.fieldSize}${scope}${captured}`;
}

function createAttemptLedger(summary: SegmentComparisonSummary): HTMLElement {
  const wrapper = node("section", "comparison-attempts-block");
  const heading = node("div", "comparison-section-heading");
  heading.append(node("h4", "", "Confirmed personal attempts"), node("span", "", `${summary.personalAttempts.length} total`));
  wrapper.append(heading);
  const list = node("ol", "comparison-attempt-list");
  [...summary.personalAttempts].reverse().forEach((effort, index) => {
    const item = node("li", index === 0 ? "is-latest" : "");
    const top = node("div", "comparison-attempt-topline");
    top.append(node("strong", "", formatDate(effort.activityDate)));
    if (index === 0) top.append(node("span", "comparison-current-badge", "Latest"));
    const metrics = node("dl", "comparison-attempt-metrics");
    const values: Array<[string, string]> = [
      ["Time", formatDuration(effort.elapsedSeconds)],
      ["Power", formatMetric(effort.averagePowerW, "power")],
      ["HR", formatMetric(effort.averageHeartRateBpm, "heart-rate")],
    ];
    values.forEach(([label, value]) => {
      const entry = node("div");
      entry.append(node("dt", "", label), node("dd", "", value));
      metrics.append(entry);
    });
    item.append(top, metrics, node("p", "comparison-source", effortSourceSummary(effort)));
    if (effort.rankSnapshot) item.append(node("p", "comparison-rank", rankText(effort.rankSnapshot)));
    list.append(item);
  });
  wrapper.append(list);
  return wrapper;
}

function createReferencePanel(
  summary: SegmentComparisonSummary,
  onAdopt?: (effortId: string) => void | Promise<void>,
): HTMLElement | null {
  const reference = summary.referenceAttempts.at(-1);
  if (!reference) return null;
  const panel = node("aside", "comparison-reference-panel");
  panel.append(
    node("p", "comparison-kicker", "Published reference · separate rider scope"),
    node("h4", "", reference.label?.trim() || `Published ${formatDate(reference.activityDate, true)} effort`),
    node("p", "comparison-reference-copy", "This is not included in your personal trend or improvement headline."),
  );
  const metrics = node("dl", "comparison-reference-metrics");
  [["Time", formatDuration(reference.elapsedSeconds)], ["Power", formatMetric(reference.averagePowerW, "power")], ["HR", formatMetric(reference.averageHeartRateBpm, "heart-rate")]].forEach(([label, value]) => {
    const entry = node("div");
    entry.append(node("dt", "", label), node("dd", "", value));
    metrics.append(entry);
  });
  panel.append(metrics);
  if (onAdopt) {
    const adopt = control("comparison-link-button", "This published effort is mine…");
    adopt.addEventListener("click", () => void onAdopt(reference.effortId));
    panel.append(adopt);
  }
  return panel;
}

function createReviewNotice(dataset: ComparisonDataset, onReview?: () => void): HTMLElement | null {
  const provisional = dataset.efforts.filter((effort) => effort.scope === "personal" && effort.matchStatus === "provisional").length;
  const unmatched = dataset.efforts.filter((effort) => effort.scope === "personal" && effort.matchStatus === "unmatched").length;
  const reportedProvisional = dataset.importState?.provisionalCount ?? provisional;
  const reportedUnmatched = dataset.importState?.unmatchedCount ?? unmatched;
  if (!reportedProvisional && !reportedUnmatched && dataset.importState?.status !== "review") return null;
  const notice = node("aside", "comparison-review-notice");
  if (reportedProvisional) {
    const unresolvedCopy = reportedUnmatched ? ` · ${reportedUnmatched} ${reportedUnmatched === 1 ? "file added nothing" : "files added nothing"}` : "";
    notice.append(
      node("strong", "", "Some matches need review"),
      node("p", "", `${reportedProvisional} likely ${reportedProvisional === 1 ? "match" : "matches"}${unresolvedCopy}. Likely matches are excluded from comparison headlines until confirmed.`),
    );
  } else {
    const unmatchedCopy = reportedUnmatched === 1
      ? "The selected file either contained no confirmed match to the current climb catalog or was not a cycling activity. Nothing from it was added."
      : `${reportedUnmatched} selected files either contained no confirmed match to the current climb catalog or were not cycling activities. Nothing from them was added.`;
    notice.append(
      node("strong", "", "No comparison added"),
      node("p", "", unmatchedCopy),
    );
  }
  if (onReview && reportedProvisional) {
    const review = control("comparison-secondary-button", `Review ${reportedProvisional} ${reportedProvisional === 1 ? "match" : "matches"}`);
    review.addEventListener("click", onReview);
    notice.append(review);
  }
  return notice;
}

function createImportControls(
  dataset: ComparisonDataset,
  inputId: string,
  callbacks: Pick<ComparisonControllerOptions, "onFilesSelected" | "onForgetHistory" | "onPersistenceChange">,
): HTMLElement {
  const wrapper = node("section", "comparison-import-controls");
  const copy = node("div", "comparison-import-copy");
  copy.append(node("strong", "", "Your history stays local"), node("p", "", "Past ride files are processed in this browser. Imported personal efforts remain separate from the published reference."));
  wrapper.append(copy);

  const actions = node("div", "comparison-import-actions");
  const fileInput = node("input", "comparison-file-input");
  fileInput.type = "file";
  fileInput.id = inputId;
  fileInput.multiple = true;
  fileInput.accept = ".fit,application/vnd.ant.fit";
  const importButton = control("comparison-primary-button", dataset.efforts.some((effort) => effort.scope === "personal") ? "Import more" : "Add past rides");
  importButton.disabled = !callbacks.onFilesSelected;
  if (!callbacks.onFilesSelected) importButton.title = "Connect a local import handler to enable file selection.";
  importButton.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    const files = [...(fileInput.files ?? [])];
    fileInput.value = "";
    if (files.length && callbacks.onFilesSelected) void callbacks.onFilesSelected(files);
  });
  actions.append(fileInput, importButton);

  const personalCount = dataset.efforts.filter((effort) => effort.scope === "personal").length;
  if (personalCount && callbacks.onForgetHistory) {
    const forget = control("comparison-link-button comparison-forget-button", "Forget imported history…");
    forget.addEventListener("click", () => {
      const confirmed = window.confirm("Forget imported comparison history on this device? The public atlas will not be changed.");
      if (confirmed) void callbacks.onForgetHistory?.();
    });
    actions.append(forget);
  }
  wrapper.append(actions);

  if (callbacks.onPersistenceChange) {
    const persistence = node("label", "comparison-persistence");
    const checkbox = node("input");
    checkbox.type = "checkbox";
    checkbox.checked = Boolean(dataset.importState?.rememberedOnDevice);
    checkbox.addEventListener("change", () => void callbacks.onPersistenceChange?.(checkbox.checked));
    persistence.append(checkbox, document.createTextNode(" Remember on this device"));
    wrapper.append(persistence);
  }

  const status = dataset.importState;
  if (status && status.status !== "idle") {
    const statusNode = node("div", `comparison-import-status is-${status.status}`);
    statusNode.setAttribute("role", "status");
    if (status.status === "parsing") {
      statusNode.textContent = `Reading ${status.filesProcessed ?? 0} ${status.filesProcessed === 1 ? "file" : "files"} locally…`;
    } else if (status.status === "review") {
      statusNode.textContent = `${status.exactCount ?? 0} exact · ${status.confirmedCount ?? 0} confirmed · ${status.provisionalCount ?? 0} need review`;
    } else if (status.status === "ready") {
      statusNode.textContent = `${personalCount} personal ${personalCount === 1 ? "effort" : "efforts"} available${status.rememberedOnDevice ? " on this device" : " in this tab"}.`;
    } else {
      statusNode.textContent = status.errorMessages?.[0] ?? "One or more files could not be imported. Existing comparisons remain available.";
    }
    wrapper.append(statusNode);
    const detailMessages = status.status === "error" ? status.errorMessages?.slice(1) : status.errorMessages;
    if (detailMessages?.length) {
      const warnings = node("ul", "comparison-import-warnings");
      for (const message of detailMessages) warnings.append(node("li", "", message));
      wrapper.append(warnings);
    }
  }
  return wrapper;
}

function overviewDelta(summary: SegmentComparisonSummary): string {
  if (!summary.latest || !summary.previous) return "One confirmed attempt";
  return formatComparisonDelta(summary.latest, summary.previous, "time", "last time");
}

function createSummaryList(
  title: string,
  summaries: SegmentComparisonSummary[],
  onSelect: (segmentId: string) => void,
): HTMLElement {
  const section = node("section", "comparison-summary-section");
  const heading = node("div", "comparison-section-heading");
  heading.append(node("h3", "", title), node("span", "", String(summaries.length).padStart(2, "0")));
  section.append(heading);
  const list = node("ol", "comparison-summary-list");
  summaries.forEach((summary) => {
    const item = node("li");
    const button = control("comparison-summary-row", "");
    button.dataset.segmentId = summary.segment.segmentId;
    button.setAttribute("aria-label", `${summary.segment.campLabel}, ${summary.personalAttempts.length} attempts, ${overviewDelta(summary)}`);
    const titleBlock = node("span", "comparison-summary-copy");
    const attemptCount = `${summary.personalAttempts.length} ${summary.personalAttempts.length === 1 ? "attempt" : "attempts"}`;
    titleBlock.append(
      node("strong", "", summary.segment.campLabel),
      node("small", "", summary.segment.stageLabel ? `${summary.segment.stageLabel} · ${attemptCount}` : attemptCount),
    );
    const values = node("span", "comparison-summary-values");
    values.append(node("strong", "", summary.latest ? formatDuration(summary.latest.elapsedSeconds) : "—"), node("small", "", overviewDelta(summary)));
    button.append(node("span", "comparison-summary-marker", "↗"), titleBlock, values);
    button.addEventListener("click", () => onSelect(summary.segment.segmentId));
    item.append(button);
    list.append(item);
  });
  section.append(list);
  return section;
}

function createOverview(
  dataset: ComparisonDataset,
  state: ComparisonViewState,
  inputId: string,
  options: ComparisonControllerOptions,
  selectSegment: (segmentId: string) => void,
): HTMLElement {
  const root = node("div", "comparison-shell comparison-overview");
  const summaries = summarizeComparisonDataset(dataset);
  const repeated = summaries.filter((summary) => summary.personalAttempts.length >= 2);
  const singles = summaries.filter((summary) => summary.personalAttempts.length === 1);
  const acceptedCount = summaries.reduce((sum, summary) => sum + summary.personalAttempts.length, 0);
  const hero = node("header", "comparison-hero");
  hero.append(
    node("p", "comparison-kicker", "Climb history"),
    node("h3", "", repeated.length ? `${repeated.length} repeated ${repeated.length === 1 ? "climb" : "climbs"}` : "Compare your camps"),
    node("p", "comparison-deck", repeated.length
      ? "Latest versus previous comes first. Open a climb for its full dated history and metric context."
      : "Add your own past camp files to find repeat efforts. Published atlas data stays separate from your personal history."),
  );
  const summaryStrip = node("dl", "comparison-overview-counts");
  [["Repeated", repeated.length], ["Single attempt", singles.length], ["Confirmed efforts", acceptedCount]].forEach(([label, value]) => {
    const entry = node("div");
    entry.append(node("dt", "", String(label)), node("dd", "", String(value)));
    summaryStrip.append(entry);
  });
  hero.append(summaryStrip);
  root.append(hero);

  const review = createReviewNotice(dataset, options.onReviewMatches);
  if (review) root.append(review);
  if (repeated.length) root.append(createSummaryList("Repeated climbs", repeated, selectSegment));
  if (!repeated.length && acceptedCount) {
    root.append(node("p", "comparison-inline-empty comparison-inline-empty--prominent", "No repeated catalog climb is confirmed yet. Single attempts are listed below."));
  }
  if (singles.length) {
    const disclosure = node("details", "comparison-singles");
    disclosure.open = state.showSingleAttempts;
    const summary = node("summary", "", `Single attempts (${singles.length})`);
    disclosure.append(summary, createSummaryList("Available once", singles, selectSegment));
    disclosure.addEventListener("toggle", () => {
      state.showSingleAttempts = disclosure.open;
      options.onStateChange?.({ ...state });
    });
    root.append(disclosure);
  }
  root.append(createImportControls(dataset, inputId, options));
  return root;
}

function createDetail(
  dataset: ComparisonDataset,
  state: ComparisonViewState,
  summary: SegmentComparisonSummary,
  inputId: string,
  options: ComparisonControllerOptions,
  updateState: (patch: Partial<ComparisonViewState>) => void,
): HTMLElement {
  const root = node("div", "comparison-shell comparison-detail");
  const back = control("comparison-back-button", "← All repeated climbs");
  back.addEventListener("click", () => updateState({ selectedSegmentId: null }));
  root.append(back);
  const baseline = baselineFor(summary, state.baseline);
  const baselineName = state.baseline === "best" ? "previous best" : "previous attempt";
  const hero = node("header", "comparison-hero comparison-hero--detail");
  hero.append(
    node("p", "comparison-kicker", summary.segment.stageLabel ?? "Climb history"),
    node("h3", "", summary.segment.campLabel),
    node("p", "comparison-claim", formatComparisonDelta(summary.latest, baseline, state.metric, baselineName)),
    node("p", "comparison-deck", `${summary.personalAttempts.length} confirmed personal ${summary.personalAttempts.length === 1 ? "attempt" : "attempts"}. Published references are shown separately.`),
  );
  root.append(hero);

  const review = createReviewNotice(dataset, options.onReviewMatches);
  if (review) root.append(review);

  if (summary.personalAttempts.length) {
    const controls = node("div", "comparison-view-controls");
    controls.append(createMetricToggle(state, summary, (metric) => updateState({ metric })));
    const baselineLabel = node("label", "comparison-baseline-label");
    baselineLabel.append(document.createTextNode("Compare with"));
    const select = node("select", "comparison-baseline-select");
    const previousOption = node("option", "", "Previous attempt");
    previousOption.value = "previous";
    const bestOption = node("option", "", "Previous personal best");
    bestOption.value = "best";
    select.append(previousOption, bestOption);
    select.value = state.baseline;
    select.disabled = summary.personalAttempts.length < 2;
    select.addEventListener("change", () => updateState({ baseline: select.value as ComparisonBaseline }));
    baselineLabel.append(select);
    controls.append(baselineLabel);
    root.append(controls, createTimeline(summary, state.metric), createMetricLedger(summary, baseline, baselineName), createAttemptLedger(summary));
  } else {
    const empty = node("section", "comparison-empty-state");
    empty.append(
      node("p", "comparison-kicker", "No personal history on this device"),
      node("h4", "", `Add a past ${summary.segment.campLabel} effort`),
      node("p", "", "Only confirmed efforts on this exact segment boundary enter a personal comparison."),
    );
    root.append(empty);
  }

  const reference = createReferencePanel(summary, options.onAdoptPublishedReference);
  if (reference) root.append(reference);
  root.append(createImportControls(dataset, inputId, options));
  return root;
}

export function createComparisonController(options: ComparisonControllerOptions): ComparisonController {
  const inputId = `comparison-files-${++comparisonInstance}`;
  let dataset = options.dataset;
  const state: ComparisonViewState = { ...DEFAULT_STATE, ...options.initialState };
  let destroyed = false;

  const emitState = () => options.onStateChange?.({ ...state });
  const render = () => {
    if (destroyed) return;
    const summaries = summarizeComparisonDataset(dataset);
    const selected = summaries.find((summary) => summary.segment.segmentId === state.selectedSegmentId) ?? null;
    const updateState = (patch: Partial<ComparisonViewState>) => {
      Object.assign(state, patch);
      render();
      emitState();
      if (Object.hasOwn(patch, "selectedSegmentId")) options.onSegmentSelect?.(state.selectedSegmentId);
    };
    const content = selected
      ? createDetail(dataset, state, selected, inputId, options, updateState)
      : createOverview(dataset, state, inputId, options, (segmentId) => updateState({ selectedSegmentId: segmentId }));
    options.root.replaceChildren(content);
  };

  const controller: ComparisonController = {
    getState: () => ({ ...state }),
    setState: (patch, notify = false) => {
      Object.assign(state, patch);
      render();
      if (notify) emitState();
    },
    setDataset: (nextDataset) => {
      dataset = nextDataset;
      if (state.selectedSegmentId && !dataset.segments.some((segment) => segment.segmentId === state.selectedSegmentId)) {
        state.selectedSegmentId = null;
      }
      render();
    },
    selectSegment: (segmentId, notify = false) => {
      state.selectedSegmentId = segmentId;
      render();
      if (notify) {
        emitState();
        options.onSegmentSelect?.(segmentId);
      }
    },
    render,
    destroy: () => {
      destroyed = true;
      options.root.replaceChildren();
    },
  };

  render();
  return controller;
}
