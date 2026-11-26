import "./map.css";
import { loadAtlasData, sampledSegmentExtents } from "./data";
import { StaticMapFallback } from "./fallback";
import { createLocalHistoryExperience } from "./local-history";
import { ReliefMap } from "./map";
import { MALLORCA_SUMMITS } from "./mountains";
import { cameraFromMap, defaultState, normalizeSelection, stateFromHash, terrainLabel, writeStateToHash } from "./state";
import type { AtlasData, AtlasState, GuideTab, Ride, Segment, TelemetrySample } from "./types";

const app = document.querySelector<HTMLElement>("#app") ?? (() => {
  throw new Error("Missing application mount point.");
})();

const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function element<K extends keyof HTMLElementTagNameMap>(name: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(name);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className: string, text: string, label?: string): HTMLButtonElement {
  const node = element("button", className, text);
  node.type = "button";
  if (label) node.setAttribute("aria-label", label);
  return node;
}

function metric(label: string, value: string): HTMLElement {
  const wrapper = element("div", "metric");
  wrapper.append(element("dt", "metric-label", label), element("dd", "metric-value", value));
  return wrapper;
}

function numberValue(value: number | null, digits = 0): string {
  return value === null ? "—" : value.toLocaleString("en", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

function duration(seconds: number | null): string {
  if (seconds === null) return "—";
  const rounded = Math.max(0, Math.round(seconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const secondsPart = rounded % 60;
  return hours ? `${hours}h ${String(minutes).padStart(2, "0")}m` : `${minutes}:${String(secondsPart).padStart(2, "0")}`;
}

function shortDate(value: string): string {
  if (!value) return "Camp ride";
  const date = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" }).format(date);
}

function distanceSquared(a: [number, number], b: [number, number]): number {
  const latitudeScale = Math.cos(((a[1] + b[1]) * Math.PI) / 360);
  const longitudeDifference = (a[0] - b[0]) * latitudeScale;
  const latitudeDifference = a[1] - b[1];
  return longitudeDifference * longitudeDifference + latitudeDifference * latitudeDifference;
}

function nearestPoint(ride: Ride, coordinate: [number, number]): TelemetrySample | null {
  let best: TelemetrySample | null = null;
  let bestDistance = Infinity;
  for (const point of ride.telemetrySamples) {
    const currentDistance = distanceSquared(point.coordinate, coordinate);
    if (currentDistance < bestDistance) {
      best = point;
      bestDistance = currentDistance;
    }
  }
  return best;
}

function shell(): void {
  app.innerHTML = `
    <div class="atlas-app">
      <header class="masthead">
        <div class="masthead-copy">
          <p class="eyebrow">Sa Calobra Cycling Club · Mallorca 2026</p>
          <h1>Mallorca<br><em>in six rides</em></h1>
          <p class="lede">A relief atlas of the island, the week’s roads and the climbs that gave each day its shape.</p>
        </div>
        <div class="masthead-actions" aria-label="Map controls">
          <button class="utility-button" id="terrain-toggle" type="button" aria-pressed="true">
            <span class="utility-icon" aria-hidden="true">⌁</span><span>3D relief</span>
          </button>
          <button class="utility-button" id="reset-map" type="button">
            <span class="utility-icon" aria-hidden="true">↺</span><span>Reset</span>
          </button>
        </div>
      </header>

      <section class="atlas-stage" aria-label="Interactive Mallorca ride atlas">
        <section class="map-panel" id="map-panel" aria-label="Relief map">
          <div id="map" class="live-map" aria-label="Interactive 3D map of Mallorca and the six camp routes" inert></div>
          <div id="fallback" class="fallback-host" aria-label="Static Mallorca route map"></div>
          <div class="map-vignette" aria-hidden="true"></div>
          <div class="map-heading" aria-hidden="true">
            <span>39.70° N · Mediterranean</span>
            <strong>ISLA DE MALLORCA</strong>
          </div>
          <div class="relief-key" aria-label="Elevation range shown by the relief map">
            <span>Sea level</span><i aria-hidden="true"></i><strong>Puig Major · 1,445 m</strong>
          </div>
          <div class="route-key" id="route-key" aria-label="Ride colors"></div>
          <div class="map-status" id="map-status" role="status">
            <span class="status-dot" aria-hidden="true"></span><span id="map-status-text">Preparing route atlas…</span>
          </div>
          <p class="gesture-hint">Click a route for its nearest 30-second sample · use two fingers to move the map</p>
        </section>

        <aside class="atlas-guide" id="atlas-guide" aria-label="Island and ride guide">
          <div class="sheet-handle" aria-hidden="true"></div>
          <div class="guide-topline">
            <div>
              <p class="guide-kicker">Field guide</p>
              <h2 id="guide-title">Read the island</h2>
            </div>
            <span class="guide-count" id="guide-count">06 rides</span>
          </div>
          <div class="guide-tabs" role="tablist" aria-label="Atlas guide sections">
            <button type="button" role="tab" data-tab="island">Island</button>
            <button type="button" role="tab" data-tab="rides">Rides</button>
            <button type="button" role="tab" data-tab="segments">Climbs</button>
            <button type="button" role="tab" data-tab="point">Point</button>
            <button type="button" role="tab" data-tab="compare">Compare</button>
          </div>
          <div class="guide-scroll">
            <section class="guide-content" id="guide-content" role="tabpanel" tabindex="0"></section>
            <section class="profile-panel" id="profile-panel" aria-label="Elevation profile"></section>
            <footer class="guide-footer">
              <p><strong>Privacy:</strong> repeated camp-base approach and departure geometry is clipped. Ride totals still describe each full FIT file.</p>
              <p><strong>Past-ride imports:</strong> FIT files are decoded in a same-origin browser worker. Raw bytes, routes and filenames are discarded; optional device storage contains derived segment summaries only.</p>
              <p>Orientation regions are approximate, not official boundaries. This is a ride-exploration view, not turn-by-turn navigation.</p>
              <p class="source-line">Road and summit positions © OpenStreetMap contributors · summit elevations <a href="https://www.caib.es/" target="_blank" rel="noreferrer">Govern de les Illes Balears</a> · tiles by OpenFreeMap · terrain <a href="https://mapterhorn.com/attribution" target="_blank" rel="noreferrer">© Mapterhorn</a></p>
            </footer>
          </div>
        </aside>
      </section>
      <div id="live-region" class="sr-only" aria-live="polite"></div>
    </div>`;
}

function renderLoadingError(error: unknown): void {
  app.setAttribute("aria-busy", "false");
  app.replaceChildren();
  const panel = element("main", "load-error");
  panel.append(
    element("p", "eyebrow", "Mallorca relief atlas"),
    element("h1", "", "The map data did not load."),
    element("p", "", error instanceof Error ? error.message : "An unexpected data error occurred."),
  );
  const link = element("a", "primary-link", "Reload the relief atlas");
  link.href = "./";
  panel.append(link);
  app.append(panel);
}

function bootstrapGuide(data: AtlasData, state: AtlasState, mapRef: { current: ReliefMap | null }): void {
  const guideContent = document.querySelector<HTMLElement>("#guide-content")!;
  const guideScroll = document.querySelector<HTMLElement>(".guide-scroll")!;
  const atlasGuide = document.querySelector<HTMLElement>("#atlas-guide")!;
  const profilePanel = document.querySelector<HTMLElement>("#profile-panel")!;
  const guideTitle = document.querySelector<HTMLElement>("#guide-title")!;
  const guideCount = document.querySelector<HTMLElement>("#guide-count")!;
  const liveRegion = document.querySelector<HTMLElement>("#live-region")!;
  const terrainToggle = document.querySelector<HTMLButtonElement>("#terrain-toggle")!;
  const reduceMotion = prefersReducedMotion();

  const rideById = (id: string | null) => data.rides.find((ride) => ride.rideId === id) ?? null;
  const segmentById = (id: string | null) => data.segments.find((segment) => segment.segmentId === id) ?? null;
  const pointsById = new Map(data.rides.flatMap(ride => ride.telemetrySamples.map(point => [point.sampleId, point] as const)));
  const pointById = (id: string | null) => id ? pointsById.get(id) ?? null : null;
  const summitById = (id: string | null) => MALLORCA_SUMMITS.find((summit) => summit.id === id) ?? null;

  const announce = (message: string) => {
    liveRegion.textContent = "";
    window.setTimeout(() => { liveRegion.textContent = message; }, 20);
  };

  let selectionHash = window.location.hash;
  const commit = (mode: "push" | "replace" = "push") => {
    writeStateToHash(state, mode);
    selectionHash = window.location.hash;
  };

  const updateMapSelection = () => {
    mapRef.current?.updateSelection(state);
    mapRef.current?.selectSummit(state.selectedSummitId, false);
    fallback.update(state, state.selectedSummitId);
  };

  let restoringCamera = false;
  const withoutCameraWrites = (action: () => void) => {
    restoringCamera = true;
    try {
      action();
    } finally {
      restoringCamera = false;
    }
  };

  const frameSelection = (animate: boolean) => {
    const map = mapRef.current;
    if (!map) return;
    const point = pointById(state.selectedPointId);
    const segment = segmentById(state.selectedSegmentId);
    const ride = rideById(state.selectedRideId);
    if (state.camera) map.restoreCamera(state.camera);
    else if (point) map.focusPoint(point, animate);
    else if (segment) map.fitSegment(segment, animate);
    else if (state.selectedSummitId) map.selectSummit(state.selectedSummitId, true, animate);
    else if (ride) map.fitRide(ride, animate);
    else map.showIsland(animate);
  };

  const restoreView = () => withoutCameraWrites(() => {
    mapRef.current?.getCamera().stop();
    updateMapSelection();
    mapRef.current?.setTerrain(state.terrain, false);
    frameSelection(false);
  });

  type GuideFocus = "detail" | "previous" | "next" | "profile";
  const focusGuide = (focus: GuideFocus) => {
    if (focus !== "detail") {
      const target = focus === "profile" ? profilePanel.querySelector<SVGSVGElement>(".profile-chart")
        : guideContent.querySelector<HTMLButtonElement>(`[data-step="${focus}"]`);
      target?.focus({ preventScroll: true });
      return;
    }
    const heading = guideContent.querySelector<HTMLElement>(".selection-card--segment h3") ??
      guideContent.querySelector<HTMLElement>(".selection-card h3, .comparison-hero h3");
    if (heading) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
      heading.scrollIntoView({ block: "nearest", behavior: "instant" });
    } else {
      document.querySelector<HTMLButtonElement>('[role=tab][aria-selected="true"]')?.focus({ preventScroll: true });
    }
  };

  const navigate = (selection: Parameters<typeof normalizeSelection>[1], tab: GuideTab, focus: GuideFocus = "detail") => {
    // stop() can synchronously emit moveend for the previous animation.
    withoutCameraWrites(() => mapRef.current?.getCamera().stop());
    const previousTab = state.tab;
    Object.assign(state, normalizeSelection(data, selection), { tab, camera: null, previewRideId: null });
    commit();
    updateMapSelection();
    if (tab === "compare" && previousTab === "compare") {
      guideTitle.textContent = segmentById(state.selectedSegmentId)?.campLabel ?? "Compare past climbs";
      guideCount.textContent = `${historyExperience.personalEffortCount()} local`;
      focusGuide("detail");
    } else {
      render();
      focusGuide(focus);
      if (focus === "profile" && previousTab !== "point") profilePanel.scrollIntoView({ block: "nearest", behavior: "instant" });
    }
    frameSelection(!reduceMotion);
  };

  const selectRide = (rideId: string) => {
    const ride = rideById(rideId);
    if (!ride) return;
    navigate({ selectedRideId: rideId }, "rides");
    announce(`${ride.label} selected.`);
  };

  const selectSegment = (segmentId: string) => {
    const segment = segmentById(segmentId);
    if (!segment?.matched) return;
    navigate({ selectedSegmentId: segmentId }, state.tab === "rides" ? "rides" : "segments");
    announce(`${segment.campLabel} segment selected.`);
  };

  const selectPoint = (pointId: string, focus: GuideFocus = "detail") => {
    const point = pointById(pointId);
    if (!point) return;
    navigate({ selectedPointId: point.sampleId }, "point", focus);
    const ride = rideById(point.rideId);
    announce(`${ride?.label ?? "Ride"} point at ${numberValue(point.distanceKm, 1)} kilometres selected.`);
  };

  const stepPoint = (direction: -1 | 1, focus: GuideFocus) => {
    const ride = rideById(state.selectedRideId);
    if (!ride?.telemetrySamples.length) return;
    const currentIndex = ride.telemetrySamples.findIndex((point) => point.sampleId === state.selectedPointId);
    const nextIndex = Math.max(0, Math.min(ride.telemetrySamples.length - 1, currentIndex < 0 ? 0 : currentIndex + direction));
    if (nextIndex !== currentIndex) selectPoint(ride.telemetrySamples[nextIndex].sampleId, focus);
  };

  const reset = () => {
    navigate({}, "island");
    announce("Map reset to the whole island and all six rides.");
  };

  const selectSummit = (summitId: string) => {
    const summit = summitById(summitId);
    if (!summit) return;
    navigate({ selectedSummitId: summit.id }, "island");
    announce(`${summit.name}, ${summit.elevationM.toLocaleString("en")} metres, selected.`);
  };

  const historyExperience = createLocalHistoryExperience({
    data,
    announce,
    onSummaryChange: ({ personalEffortCount }) => {
      if (state.tab === "compare") guideCount.textContent = `${personalEffortCount} local`;
    },
    onSegmentSelect: (segmentId) => navigate({ selectedSegmentId: segmentId }, "compare"),
  });

  const renderIsland = (): void => {
    const selectedSummit = summitById(state.selectedSummitId);
    guideTitle.textContent = selectedSummit?.name ?? "Read the island";
    guideCount.textContent = selectedSummit ? `${selectedSummit.elevationM.toLocaleString("en")} m` : "06 rides";
    if (selectedSummit) {
      const card = element("article", "selection-card selection-card--summit");
      card.append(
        element("p", "card-kicker", "Named summit · Serra de Tramuntana"),
        element("h3", "", selectedSummit.name),
        element("p", "summit-height", `${selectedSummit.elevationM.toLocaleString("en")} m`),
        element("p", "selection-copy", selectedSummit.orientation),
      );
      const source = element("a", "summit-source", "Elevation source · Govern de les Illes Balears ↗");
      source.href = selectedSummit.sources.elevation.url;
      source.target = "_blank";
      source.rel = "noreferrer";
      const coordinates = element("a", "summit-source", "Summit position · OpenStreetMap ↗");
      coordinates.href = selectedSummit.sources.coordinates.url;
      coordinates.target = "_blank";
      coordinates.rel = "noreferrer";
      card.append(source, coordinates);
      guideContent.append(card);
    }
    const totalDistance = data.rides.reduce((sum, ride) => sum + (ride.summary.distanceKm ?? 0), 0);
    const totalAscent = data.rides.reduce((sum, ride) => sum + (ride.summary.ascentM ?? 0), 0);
    const intro = element("div", "editorial-intro");
    intro.append(
      element("p", "dropcap", "Start with the northwest. The Serra de Tramuntana is Mallorca’s raised spine; most of the week’s decisive climbing stacks along it. The centre opens into the lower Pla, while Llevant sits softer and more isolated to the east."),
    );
    const weekMetrics = element("dl", "metric-grid metric-grid--week");
    weekMetrics.append(
      metric("Week distance", `${numberValue(totalDistance, 0)} km`),
      metric("Recorded ascent", `${numberValue(totalAscent, 0)} m`),
      metric("Verified climbs", String(data.segments.filter(segment => segment.matched).length)),
      metric("Ride days", String(data.rides.length)),
    );
    const summitTitle = element("h3", "section-title", "Tramuntana summits");
    const summitList = element("div", "summit-index");
    for (const summit of MALLORCA_SUMMITS) {
      const control = button("summit-row", "");
      control.dataset.summitId = summit.id;
      control.setAttribute("aria-pressed", String(summit.id === state.selectedSummitId));
      control.append(
        element("span", "summit-row-mark", "▲"),
        element("strong", "", summit.name),
        element("span", "summit-row-height", `${summit.elevationM.toLocaleString("en")} m`),
      );
      summitList.append(control);
    }
    const regionsTitle = element("h3", "section-title", "Orientation regions");
    const regions = element("div", "region-list");
    const regionData = [
      ["01", "Serra de Tramuntana", "The steep northwest ridge: Puig Major, Lluc and Sa Calobra."],
      ["02", "Formentor · north", "A narrow limestone peninsula of rollers, sea cliffs and exposed turns."],
      ["03", "Pla de Mallorca", "The lower central plain—the island’s connective tissue between ridges."],
      ["04", "Llevant · east", "Quieter eastern hills, including Betlem and the isolated Sant Salvador finish."],
      ["05", "Palma · southwest", "Urban and coastal context south of the week’s northern base area."],
    ];
    for (const [index, name, copy] of regionData) {
      const row = element("article", "region-row");
      row.append(element("span", "region-index", index), element("h4", "", name), element("p", "", copy));
      regions.append(row);
    }
    const note = element("details", "method-note");
    const summary = element("summary", "", "How to read this map");
    const copy = element("div", "method-copy");
    copy.append(
      element("p", "", "Terrain is drawn from a live elevation model for orientation. Heights in the point inspector come from the rider’s Garmin FIT file and may differ from the terrain surface."),
      element("p", "", "Route lines are privacy-trimmed and simplified. Gold lines are the rider’s verified FIT trace through matched camp-posted Strava segments—not Strava’s canonical segment polyline."),
      element("p", "", "Point grade is derived from neighbouring published FIT altitude and distance samples. It is smoothed for orientation and is not an instantaneous gradient."),
    );
    note.append(summary, copy);
    guideContent.append(intro, weekMetrics, summitTitle, summitList, regionsTitle, regions, note);
  };

  const renderRides = (): void => {
    guideTitle.textContent = state.selectedRideId ? "One ride, in context" : "The week on the road";
    guideCount.textContent = `${String(data.rides.length).padStart(2, "0")} rides`;
    const selectedRide = rideById(state.selectedRideId);
    if (selectedRide) {
      const selected = element("article", "selection-card");
      const accent = element("span", "selection-accent");
      accent.style.background = selectedRide.color;
      selected.append(accent, element("p", "card-kicker", shortDate(selectedRide.date)), element("h3", "", selectedRide.label));
      if (selectedRide.subtitle) selected.append(element("p", "selection-copy", selectedRide.subtitle));
      const metrics = element("dl", "metric-grid");
      metrics.append(
        metric("Distance", `${numberValue(selectedRide.summary.distanceKm, 1)} km`),
        metric("Ascent", `${numberValue(selectedRide.summary.ascentM, 0)} m`),
        metric("Moving", duration(selectedRide.summary.movingSeconds)),
        metric("Avg power", `${numberValue(selectedRide.summary.averagePowerW, 0)} W`),
      );
      selected.append(metrics);
      if (selectedRide.note) selected.append(element("p", "data-caveat", selectedRide.note));
      const group = segmentGroup(selectedRide, true);
      guideContent.append(selected, group);
      const segment = segmentById(state.selectedSegmentId);
      if (segment) guideContent.append(segmentCard(segment));
      guideContent.append(profilePanel);
    } else {
      guideContent.append(element("p", "guide-prompt", "Select a route to bring its line forward, open its profile and reveal the published 30-second telemetry samples."));
    }
    const list = element("ol", "ride-list");
    for (const [index, ride] of data.rides.entries()) {
      const item = element("li", "");
      const control = button("ride-card", "");
      control.dataset.rideId = ride.rideId;
      control.setAttribute("aria-pressed", String(ride.rideId === state.selectedRideId));
      const color = element("span", "ride-swatch");
      color.style.background = ride.color;
      const ordinal = element("span", "ride-ordinal", String(index + 1).padStart(2, "0"));
      const copy = element("span", "ride-card-copy");
      copy.append(element("strong", "", ride.label), element("small", "", `${shortDate(ride.date)} · ${numberValue(ride.summary.distanceKm, 0)} km · ${numberValue(ride.summary.ascentM, 0)} m`));
      control.append(color, ordinal, copy, element("span", "ride-arrow", "↗"));
      item.append(control);
      list.append(item);
    }
    if (selectedRide) guideContent.append(element("h3", "section-title", "All rides"));
    guideContent.append(list);
  };

  const segmentMetricGrid = (segment: Segment): HTMLElement => {
    const metrics = element("dl", "metric-grid");
    metrics.append(
      metric("Time", duration(segment.stats.elapsedSeconds)),
      metric("Distance", `${numberValue(segment.stats.distanceKm, 2)} km`),
      metric("Gain", `${numberValue(segment.stats.elevationGainM, 0)} m`),
      metric("Avg grade", `${numberValue(segment.stats.averageGradePct, 1)}%`),
      metric("Avg power", `${numberValue(segment.stats.averagePowerW, 0)} W`),
      metric("Avg HR", `${numberValue(segment.stats.averageHeartRateBpm, 0)} bpm`),
    );
    return metrics;
  };

  const segmentCard = (selectedSegment: Segment): HTMLElement => {
    const card = element("article", "selection-card selection-card--segment");
    card.append(element("p", "card-kicker", rideById(selectedSegment.rideId)?.label ?? "Verified climb"), element("h3", "", selectedSegment.campLabel));
    if (selectedSegment.currentStravaTitle && selectedSegment.currentStravaTitle !== selectedSegment.campLabel) {
      card.append(element("p", "segment-subtitle", `Currently on Strava: ${selectedSegment.currentStravaTitle}`));
    }
    card.append(segmentMetricGrid(selectedSegment));
    const basis = element("p", "data-caveat", selectedSegment.boundaryBasis === "exact_fit_timestamp"
      ? "Boundary: exact reviewed FIT time window."
      : "Boundary: rider FIT window reconciled to the segment’s distance, gain, power and heart rate.");
    card.append(basis);
    if (selectedSegment.stravaUrl) {
      card.append(stravaLink(selectedSegment.stravaUrl, selectedSegment.campLabel));
    }
    return card;
  };

  const stravaLink = (url: string, label: string, rowText?: string): HTMLAnchorElement => {
    const link = element("a", rowText ? "strava-link strava-link--row" : "strava-link",
      rowText ? `${rowText} ↗` : "Open this segment on Strava ↗");
    link.href = url;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.setAttribute("aria-label", `Open ${label} on Strava (opens in a new tab)`);
    return link;
  };

  const segmentGroup = (ride: Ride, showResults = false): HTMLElement => {
    const rideSegments = data.segments.filter((segment) => segment.rideId === ride.rideId);
    const group = element("section", showResults ? "segment-group ride-climbs" : "segment-group");
    const label = showResults ? "Climbs on this ride" : ride.label;
    const heading = element("div", "segment-group-heading");
    const swatch = element("span", "mini-swatch");
    swatch.style.background = ride.color;
    heading.append(swatch, element("h3", "", label), element("span", "", rideSegments.length ? `${rideSegments.filter((segment) => segment.matched).length}/${rideSegments.length}` : "—"));
    group.append(heading);
    if (!rideSegments.length) {
      group.append(element("p", "no-segments", "No official camp KOM segment for this ride."));
    } else {
      const list = element("ul", "segment-list");
      for (const segment of rideSegments) {
        const item = element("li", segment.matched ? "" : "is-unmatched");
        const control = segment.matched ? button("segment-row", "") : element("span", "segment-row segment-row--unridden");
        if (segment.matched) {
          control.dataset.segmentId = segment.segmentId;
          control.setAttribute("aria-pressed", String(segment.segmentId === state.selectedSegmentId));
        }
        const result = showResults ? segment.reportedResult : null;
        const originalDiffers = result !== null && result.stravaSegmentId !== String(segment.stravaSegmentId);
        let stat = "Posted · not ridden";
        if (segment.matched) {
          const time = duration(segment.stats.elapsedSeconds);
          const distance = `${numberValue(segment.stats.distanceKm, 2)} km`;
          const timeLabel = originalDiffers ? "Mapped segment time" : "Strava time";
          stat = showResults ? `${timeLabel} ${time} · ${distance}` : `${distance} · ${time}`;
        }
        const marker = element("span", segment.matched ? "segment-marker" : "segment-marker segment-marker--empty", segment.matched ? "↗" : "×");
        marker.setAttribute("aria-hidden", "true");
        control.append(marker, element("strong", "", segment.campLabel), element("span", "segment-stat", stat));
        item.append(control);
        if (showResults && segment.stravaUrl) {
          const name = originalDiffers ? `${segment.campLabel} mapped segment` : segment.campLabel;
          item.append(stravaLink(segment.stravaUrl, name, originalDiffers ? "Mapped segment" : "Strava"));
        }
        if (result) {
          const scope = result.scope ? ` · ${result.scope}` : "";
          const rankLabel = result.source === "camp-report" ? "Reported Strava rank" : "Recorded Strava rank";
          const rank = element("span", "camp-rank",
            `${rankLabel} ${numberValue(result.position)} of ${numberValue(result.fieldSize)}${scope}`);
          if (originalDiffers) {
            const original = element("div", "original-camp-result");
            const description = element("div", "original-camp-copy");
            description.append(element("span", "original-camp-label", "Original camp segment (retired)"), rank);
            original.append(description, stravaLink(`https://www.strava.com/segments/${result.stravaSegmentId}`,
              `${segment.campLabel} original camp segment`, "Original segment"));
            item.append(original);
          } else {
            control.append(rank);
          }
        }
        list.append(item);
      }
      group.append(list);
    }
    return group;
  };

  const renderSegments = (): void => {
    const selectedSegment = segmentById(state.selectedSegmentId);
    guideTitle.textContent = selectedSegment ? selectedSegment.campLabel : "The week’s key climbs";
    guideCount.textContent = `${data.segments.filter(segment => segment.matched).length} / ${data.segments.length} matched`;
    if (selectedSegment) guideContent.append(segmentCard(selectedSegment));
    const groups = element("div", "segment-groups");
    for (const ride of data.rides) groups.append(segmentGroup(ride));
    guideContent.append(groups);
  };

  const renderPoint = (): void => {
    const point = pointById(state.selectedPointId);
    const ride = rideById(state.selectedRideId);
    guideTitle.textContent = point ? `At ${numberValue(point.distanceKm, 1)} km` : "Inspect the ride";
    guideCount.textContent = point ? duration(point.movingSeconds) : "30 sec samples";
    if (!ride) {
      guideContent.append(element("p", "guide-prompt", "Choose a ride first. Its sampled telemetry appears from a useful zoom level, and every point also has previous/next controls here."));
      const shortcut = button("primary-button", "Choose a ride");
      shortcut.addEventListener("click", () => navigate({}, "rides"));
      guideContent.append(shortcut);
      return;
    }
    if (!point) {
      guideContent.append(element("p", "guide-prompt", `Click along ${ride.label}, choose a point on its elevation profile, or start with its first published sample.`));
      const start = button("primary-button", "Start at the first sample");
      start.addEventListener("click", () => {
        const first = ride.telemetrySamples[0];
        if (first) selectPoint(first.sampleId);
      });
      guideContent.append(start);
      return;
    }
    const card = element("article", "selection-card selection-card--point");
    card.append(element("p", "card-kicker", ride.label), element("h3", "", point.label ?? `${numberValue(point.distanceKm, 1)} km into the ride`));
    const metrics = element("dl", "metric-grid metric-grid--point");
    metrics.append(
      metric("Moving time", duration(point.movingSeconds)),
      metric("FIT altitude", `${numberValue(point.recordedAltitudeM, 0)} m`),
      metric("30s power", `${numberValue(point.powerMeanW, 0)} W`),
      metric("Heart rate", `${numberValue(point.heartRateMeanBpm, 0)} bpm`),
      metric("Cadence", `${numberValue(point.cadenceMeanRpm, 0)} rpm`),
      metric("Speed", `${numberValue(point.speedMeanKmh, 1)} km/h`),
      metric("Smoothed grade", `${numberValue(point.gradePct, 1)}%`),
      metric("Garmin-recorded temp.", `${numberValue(point.recordedTemperatureC, 0)}°C`),
    );
    card.append(metrics);
    if (ride.rideId === "ride-3") card.append(element("p", "data-caveat", "This ride’s barometric altitude has a known baseline offset; terrain shape is more reliable than the absolute FIT height."));
    card.append(element("p", "data-caveat", "Temperature is recorded by the Garmin device and is not a calibrated ambient-weather measurement."));
    const controls = element("div", "point-controls");
    const previous = button("step-button", "← Previous", "Previous published telemetry sample");
    const next = button("step-button", "Next →", "Next published telemetry sample");
    previous.dataset.step = "previous";
    next.dataset.step = "next";
    previous.addEventListener("click", () => stepPoint(-1, "previous"));
    next.addEventListener("click", () => stepPoint(1, "next"));
    controls.append(previous, next);
    card.append(controls);
    guideContent.append(card);
  };

  const renderProfile = (): void => {
    profilePanel.replaceChildren();
    const ride = rideById(state.selectedRideId);
    const heading = element("div", "profile-heading");
    heading.append(element("p", "profile-kicker", "Recorded profile"), element("span", "profile-unit", "FIT altitude · metres"));
    profilePanel.append(heading);
    if (!ride || ride.telemetrySamples.length < 2) {
      profilePanel.append(element("p", "profile-empty", "Select a ride to open its linked elevation profile."));
      return;
    }
    const points = ride.telemetrySamples.filter((point) => point.recordedAltitudeM !== null && Number.isFinite(point.distanceKm));
    if (points.length < 2) {
      profilePanel.append(element("p", "profile-empty", "No profile samples are available for this ride."));
      return;
    }
    const width = 640;
    const height = 156;
    const inset = { top: 16, right: 12, bottom: 30, left: 42 };
    const distanceMax = Math.max(...ride.telemetrySamples.map((point) => point.distanceKm), 1);
    const altitudeMin = Math.min(...points.map((point) => point.recordedAltitudeM!));
    const altitudeMax = Math.max(...points.map((point) => point.recordedAltitudeM!));
    const altitudeRange = Math.max(1, altitudeMax - altitudeMin);
    const x = (value: number) => inset.left + (value / distanceMax) * (width - inset.left - inset.right);
    const y = (value: number) => inset.top + (1 - (value - altitudeMin) / altitudeRange) * (height - inset.top - inset.bottom);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("class", "profile-chart");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", `${ride.label} recorded elevation profile. Click or use left and right arrow keys to inspect points.`);
    svg.setAttribute("tabindex", "0");
    const path = points.map((point, index) => `${index ? "L" : "M"}${x(point.distanceKm).toFixed(1)},${y(point.recordedAltitudeM!).toFixed(1)}`).join(" ");
    const baseline = height - inset.bottom;
    const selectedSegment = segmentById(state.selectedSegmentId);
    if (selectedSegment?.rideId === ride.rideId) {
      const extents = sampledSegmentExtents(ride, selectedSegment.segmentId);
      for (const [startKm, endKm] of extents) {
        const band = document.createElementNS(svg.namespaceURI, startKm === endKm ? "line" : "rect");
        band.setAttribute("class", "profile-segment-band");
        if (startKm === endKm) {
          band.setAttribute("x1", String(x(startKm)));
          band.setAttribute("x2", String(x(startKm)));
          band.setAttribute("y1", String(inset.top));
          band.setAttribute("y2", String(baseline));
        } else {
          band.setAttribute("x", String(x(startKm)));
          band.setAttribute("y", String(inset.top));
          band.setAttribute("width", String(x(endKm) - x(startKm)));
          band.setAttribute("height", String(baseline - inset.top));
        }
        svg.append(band);
      }
      const observed = extents.map(([start, end]) => start === end
        ? `${numberValue(start, 2)} km` : `${numberValue(start, 2)}–${numberValue(end, 2)} km`);
      profilePanel.append(element("p", "profile-segment-caption", observed.length
        ? `${selectedSegment.campLabel} · sampled at ${observed.join(", ")}`
        : `${selectedSegment.campLabel} has no tagged profile samples.`));
    }
    const area = document.createElementNS(svg.namespaceURI, "path");
    area.setAttribute("d", `${path} L${x(points.at(-1)!.distanceKm).toFixed(1)},${baseline} L${x(points[0].distanceKm).toFixed(1)},${baseline} Z`);
    area.setAttribute("class", "profile-area");
    const line = document.createElementNS(svg.namespaceURI, "path");
    line.setAttribute("d", path);
    line.setAttribute("class", "profile-line");
    line.setAttribute("style", `stroke:${ride.color}`);
    svg.append(area, line);
    const selectedPoint = pointById(state.selectedPointId);
    if (selectedPoint?.rideId === ride.rideId && selectedPoint.recordedAltitudeM !== null) {
      const cursor = document.createElementNS(svg.namespaceURI, "g");
      cursor.setAttribute("class", "profile-cursor");
      const cursorX = x(selectedPoint.distanceKm);
      const vertical = document.createElementNS(svg.namespaceURI, "line");
      vertical.setAttribute("x1", String(cursorX));
      vertical.setAttribute("x2", String(cursorX));
      vertical.setAttribute("y1", String(inset.top));
      vertical.setAttribute("y2", String(baseline));
      const dot = document.createElementNS(svg.namespaceURI, "circle");
      dot.setAttribute("cx", String(cursorX));
      dot.setAttribute("cy", String(y(selectedPoint.recordedAltitudeM)));
      dot.setAttribute("r", "4.5");
      cursor.append(vertical, dot);
      svg.append(cursor);
    }
    const axis = document.createElementNS(svg.namespaceURI, "g");
    axis.setAttribute("class", "profile-axis");
    const labels: Array<[number, number, string]> = [
      [inset.left, baseline + 19, "0 km"],
      [width - inset.right, baseline + 19, `${numberValue(distanceMax, 0)} km`],
      [inset.left - 7, inset.top + 4, `${numberValue(altitudeMax, 0)} m`],
      [inset.left - 7, baseline, `${numberValue(altitudeMin, 0)} m`],
    ];
    labels.forEach(([labelX, labelY, value], index) => {
      const node = document.createElementNS(svg.namespaceURI, "text");
      node.setAttribute("x", String(labelX));
      node.setAttribute("y", String(labelY));
      node.setAttribute("text-anchor", index === 1 ? "end" : index > 1 ? "end" : "start");
      node.textContent = value;
      axis.append(node);
    });
    svg.append(axis);
    svg.addEventListener("click", (event) => {
      const matrix = svg.getScreenCTM();
      if (!matrix) return;
      const local = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
      const ratio = Math.max(0, Math.min(1, (local.x - inset.left) / (width - inset.left - inset.right)));
      const desiredDistance = ratio * distanceMax;
      const point = points.reduce((best, candidate) => Math.abs(candidate.distanceKm - desiredDistance) < Math.abs(best.distanceKm - desiredDistance) ? candidate : best, points[0]);
      selectPoint(point.sampleId);
    });
    svg.addEventListener("keydown", (event) => {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        stepPoint(event.key === "ArrowLeft" ? -1 : 1, "profile");
      } else if (event.key === "Home") {
        event.preventDefault();
        selectPoint(points[0].sampleId, "profile");
      } else if (event.key === "End") {
        event.preventDefault();
        selectPoint(points.at(-1)!.sampleId, "profile");
      }
    });
    profilePanel.append(svg);
  };

  let renderedViewKey = "";
  const viewKey = (): string => [
    state.tab,
    state.selectedRideId ?? "",
    state.tab === "segments" || state.tab === "rides" ? state.selectedSegmentId ?? "" : "",
    state.tab === "island" ? state.selectedSummitId ?? "" : "",
  ].join(":");

  const resetGuidePosition = (): void => {
    guideScroll.scrollTop = 0;
    if (!window.matchMedia("(max-width: 840px) and (orientation: portrait)").matches) return;
    const guideTop = Math.max(0, atlasGuide.getBoundingClientRect().top + window.scrollY);
    if (window.scrollY > guideTop + 8) window.scrollTo({ top: guideTop, behavior: "auto" });
  };

  const render = (): void => {
    const nextViewKey = viewKey();
    const shouldResetGuide = nextViewKey !== renderedViewKey;
    const scrollTop = guideScroll.scrollTop;
    const windowTop = window.scrollY;
    historyExperience.unmount();
    guideContent.replaceChildren();
    guideContent.after(profilePanel);
    document.querySelectorAll<HTMLButtonElement>("[role=tab][data-tab]").forEach((tab) => {
      const active = tab.dataset.tab === state.tab;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
    });
    terrainToggle.setAttribute("aria-pressed", String(state.terrain === "3d"));
    terrainToggle.querySelector("span:last-child")!.textContent = terrainLabel(state.terrain);
    profilePanel.hidden = state.tab === "compare";
    if (state.tab === "island") renderIsland();
    if (state.tab === "rides") renderRides();
    if (state.tab === "segments") renderSegments();
    if (state.tab === "point") renderPoint();
    if (state.tab === "compare") {
      guideTitle.textContent = segmentById(state.selectedSegmentId)?.campLabel ?? "Compare past climbs";
      guideCount.textContent = `${historyExperience.personalEffortCount()} local`;
      historyExperience.mount(guideContent, state.selectedSegmentId);
    } else {
      renderProfile();
    }
    if (shouldResetGuide) resetGuidePosition();
    else if (state.tab === "point") {
      guideScroll.scrollTop = scrollTop;
      if (window.scrollY !== windowTop) window.scrollTo({ top: windowTop, behavior: "instant" });
    }
    renderedViewKey = nextViewKey;
  };

  const fallback = new StaticMapFallback(document.querySelector<HTMLElement>("#fallback")!, data, (kind, id) => {
    if (kind === "ride") selectRide(id);
    else if (kind === "segment") selectSegment(id);
    else selectSummit(id);
  });

  document.querySelector<HTMLElement>("#route-key")!.replaceChildren(...data.rides.map((ride) => {
    const item = element("span", "key-item");
    const swatch = element("i", "");
    swatch.style.background = ride.color;
    item.append(swatch, document.createTextNode(ride.label));
    return item;
  }));

  guideContent.addEventListener("click", (event) => {
    if (state.tab === "compare") return;
    const target = event.target instanceof Element ? event.target : null;
    const rideControl = target?.closest<HTMLButtonElement>("[data-ride-id]");
    if (rideControl?.dataset.rideId) selectRide(rideControl.dataset.rideId);
    const segmentControl = target?.closest<HTMLButtonElement>("[data-segment-id]");
    if (segmentControl?.dataset.segmentId) selectSegment(segmentControl.dataset.segmentId);
    const summitControl = target?.closest<HTMLButtonElement>("[data-summit-id]");
    if (summitControl?.dataset.summitId) selectSummit(summitControl.dataset.summitId);
  });

  const tabs = [...document.querySelectorAll<HTMLButtonElement>("[role=tab][data-tab]")];
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => {
      const nextTab = tab.dataset.tab as GuideTab;
      if (state.tab === nextTab) return;
      if (state.selectedSummitId && nextTab !== "island") {
        navigate({}, nextTab);
        return;
      }
      state.tab = nextTab;
      commit();
      render();
    });
    tab.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const offset = event.key === "ArrowRight" ? 1 : -1;
      tabs[(index + offset + tabs.length) % tabs.length].click();
      tabs[(index + offset + tabs.length) % tabs.length].focus();
    });
  });

  terrainToggle.addEventListener("click", () => {
    withoutCameraWrites(() => mapRef.current?.getCamera().stop());
    state.terrain = state.terrain === "3d" ? "2d" : "3d";
    state.camera = null;
    commit();
    mapRef.current?.setTerrain(state.terrain, !reduceMotion);
    render();
    announce(`${terrainLabel(state.terrain)} enabled.`);
  });
  document.querySelector<HTMLButtonElement>("#reset-map")!.addEventListener("click", () => reset());

  const statusText = document.querySelector<HTMLElement>("#map-status-text")!;
  const statusHost = document.querySelector<HTMLElement>("#map-status")!;
  const mapPanel = document.querySelector<HTMLElement>("#map-panel")!;
  const updateStatus = (message: string, kind: "quiet" | "warning" | "error" = "quiet") => {
    statusText.textContent = message;
    statusHost.dataset.kind = kind;
  };

  try {
    mapRef.current = new ReliefMap(document.querySelector<HTMLElement>("#map")!, data, state, {
      onViewInit: restoreView,
      onAvailabilityChange: (available) => {
        const liveMap = document.querySelector<HTMLElement>("#map")!;
        const fallbackHost = document.querySelector<HTMLElement>("#fallback")!;
        const wasFocused = (available ? fallbackHost : liveMap).contains(document.activeElement);
        mapPanel.dataset.mapReady = String(available);
        liveMap.inert = !available;
        fallbackHost.inert = available;
        fallbackHost.setAttribute("aria-hidden", String(available));
        if (wasFocused) {
          const next = available ? liveMap.querySelector<HTMLElement>(".maplibregl-canvas")
            : fallbackHost.querySelector<SVGElement>('[aria-pressed="true"]') ?? fallbackHost.querySelector<SVGElement>('[role="button"]');
          next?.focus({ preventScroll: true });
        }
      },
      onStatus: updateStatus,
      onRideClick: (rideId, coordinate) => {
        const ride = rideById(rideId);
        if (!ride) return;
        const point = nearestPoint(ride, coordinate);
        if (point) selectPoint(point.sampleId);
        else selectRide(rideId);
      },
      onSegmentClick: (segmentId) => selectSegment(segmentId),
      onPointClick: (pointId) => selectPoint(pointId),
      onSummitClick: (summitId) => selectSummit(summitId),
      onCameraChange: () => {
        if (restoringCamera || !mapRef.current || window.location.hash !== selectionHash || mapRef.current.getCamera().isMoving()) return;
        state.camera = cameraFromMap(mapRef.current.getCamera());
        commit("replace");
      },
    });
  } catch (error) {
    updateStatus("WebGL is unavailable. The static route map remains fully usable.", "warning");
    console.warn("Mallorca relief map fell back to SVG.", error);
  }

  const restoreFromHistory = () => {
    const restored = stateFromHash(data, defaultState());
    const samePointView = state.tab === "point" && restored.tab === "point" && state.selectedRideId === restored.selectedRideId;
    let focus: GuideFocus = "detail";
    if (samePointView && document.activeElement?.matches(".profile-chart")) focus = "profile";
    const step = (document.activeElement as HTMLElement | null)?.dataset?.step;
    if (samePointView && (step === "previous" || step === "next")) focus = step;
    Object.assign(state, restored);
    commit("replace");
    restoreView();
    render();
    focusGuide(focus);
  };
  window.history.scrollRestoration = "manual";
  window.addEventListener("popstate", restoreFromHistory);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) mapRef.current?.resize();
  });
  window.addEventListener("resize", () => mapRef.current?.resize(), { passive: true });

  if (window.location.hash) commit("replace");
  fallback.update(state, state.selectedSummitId);
  render();
}

async function start(): Promise<void> {
  shell();
  const controller = new AbortController();
  try {
    const data = await loadAtlasData(controller.signal);
    const state = stateFromHash(data, defaultState());
    const mapRef: { current: ReliefMap | null } = { current: null };
    bootstrapGuide(data, state, mapRef);
    app.setAttribute("aria-busy", "false");
  } catch (error) {
    renderLoadingError(error);
  }
}

void start();
