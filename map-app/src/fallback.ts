import type { AtlasData, AtlasState, Bounds, Position, RouteGeometry } from "./types";
import { MALLORCA_SUMMITS } from "./mountains";

const SVG_NS = "http://www.w3.org/2000/svg";
const VIEWBOX_WIDTH = 1000;
const VIEWBOX_HEIGHT = 680;
const PADDING = 42;

type SelectionHandler = (kind: "ride" | "segment" | "summit", id: string) => void;

function svgElement<K extends keyof SVGElementTagNameMap>(name: K, attributes: Record<string, string> = {}): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  return element;
}

function projection(bounds: Bounds) {
  const [west, south, east, north] = bounds;
  const sourceWidth = east - west;
  const sourceHeight = north - south;
  const targetWidth = VIEWBOX_WIDTH - PADDING * 2;
  const targetHeight = VIEWBOX_HEIGHT - PADDING * 2;
  const scale = Math.min(targetWidth / sourceWidth, targetHeight / sourceHeight);
  const drawnWidth = sourceWidth * scale;
  const drawnHeight = sourceHeight * scale;
  const offsetX = (VIEWBOX_WIDTH - drawnWidth) / 2;
  const offsetY = (VIEWBOX_HEIGHT - drawnHeight) / 2;
  return ([longitude, latitude]: Position): Position => [
    offsetX + (longitude - west) * scale,
    offsetY + (north - latitude) * scale,
  ];
}

function linePath(coordinates: Position[], project: (position: Position) => Position): string {
  return coordinates
    .map((coordinate, index) => {
      const [x, y] = project(coordinate);
      return `${index ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

function routePath(geometry: RouteGeometry, project: (position: Position) => Position): string {
  const lines = geometry.type === "LineString" ? [geometry.coordinates] : geometry.coordinates;
  return lines.map((line) => linePath(line, project)).join(" ");
}

function boundaryPaths(data: AtlasData, project: (position: Position) => Position): string[] {
  const boundary = data.map.islandBoundary;
  if (!boundary) return [];
  const raw = boundary.coordinates as unknown[];
  const rings = boundary.type === "Polygon" ? [raw[0]] : raw.map((polygon) => (Array.isArray(polygon) ? polygon[0] : null));
  return rings
    .filter(Array.isArray)
    .map((ring) => linePath((ring as unknown[]).map((value) => value as Position), project) + " Z");
}

function routeLabelCoordinate(geometry: RouteGeometry): Position | null {
  const lines = geometry.type === "LineString" ? [geometry.coordinates] : geometry.coordinates;
  const line = [...lines].sort((a, b) => b.length - a.length)[0];
  return line?.[Math.floor(line.length * 0.54)] ?? null;
}

export class StaticMapFallback {
  private svg: SVGSVGElement;
  private project: (position: Position) => Position;

  constructor(
    private readonly host: HTMLElement,
    private readonly data: AtlasData,
    private readonly onSelect: SelectionHandler,
  ) {
    this.project = projection(data.map.islandBoundsWsen);
    this.host.replaceChildren();
    const status = document.createElement("p");
    status.className = "fallback-kicker";
    status.textContent = "Same routes · lighter map";
    this.svg = svgElement("svg", {
      class: "fallback-map",
      viewBox: `0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`,
      role: "img",
      "aria-labelledby": "fallback-title fallback-description",
      preserveAspectRatio: "xMidYMid meet",
    });
    this.renderBase();
    this.host.append(status, this.svg);
  }

  private renderBase(): void {
    const title = svgElement("title", { id: "fallback-title" });
    title.textContent = "Static relief overview of Mallorca and the six camp routes";
    const description = svgElement("desc", { id: "fallback-description" });
    description.textContent =
      "A terrain-derived hillshade shows the Serra de Tramuntana and Mallorca's lower plains. Route lines, named summits, and verified segment traces remain selectable.";
    const defs = svgElement("defs");
    defs.innerHTML = `
      <linearGradient id="fallback-sea" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#0a292d"/><stop offset="1" stop-color="#061316"/>
      </linearGradient>
      <linearGradient id="fallback-land" x1="0" y1="0" x2=".8" y2="1">
        <stop offset="0" stop-color="#596d50"/><stop offset=".52" stop-color="#344c3f"/><stop offset="1" stop-color="#203832"/>
      </linearGradient>
      <filter id="fallback-shadow" x="-20%" y="-20%" width="140%" height="150%">
        <feDropShadow dx="0" dy="12" stdDeviation="14" flood-color="#02090a" flood-opacity=".62"/>
      </filter>
      <filter id="fallback-glow" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="5" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>`;
    const paths = boundaryPaths(this.data, this.project);
    if (paths.length) {
      const clip = svgElement("clipPath", { id: "fallback-island-clip" });
      for (const pathValue of paths) clip.append(svgElement("path", { d: pathValue }));
      defs.append(clip);
    }
    const sea = svgElement("rect", {
      x: "0",
      y: "0",
      width: String(VIEWBOX_WIDTH),
      height: String(VIEWBOX_HEIGHT),
      fill: "url(#fallback-sea)",
    });
    this.svg.append(title, description, defs, sea);

    const boundaryGroup = svgElement("g", { class: "fallback-boundary", filter: "url(#fallback-shadow)" });
    if (paths.length) {
      for (const pathValue of paths) {
        boundaryGroup.append(svgElement("path", { d: pathValue, fill: "url(#fallback-land)" }));
      }
    } else {
      boundaryGroup.append(
        svgElement("path", {
          d: "M115 335 C138 210 284 115 487 106 C664 96 865 161 916 283 C948 358 854 452 736 489 C581 540 409 567 249 514 C133 476 84 405 115 335 Z",
          fill: "url(#fallback-land)",
          stroke: "#80927a",
          "stroke-width": "1.4",
        }),
      );
    }
    this.svg.append(boundaryGroup);

    if (paths.length) {
      const [left, top] = this.project([this.data.map.islandBoundsWsen[0], this.data.map.islandBoundsWsen[3]]);
      const [right, bottom] = this.project([this.data.map.islandBoundsWsen[2], this.data.map.islandBoundsWsen[1]]);
      this.svg.append(svgElement("image", {
        href: "./assets/mallorca-relief.webp",
        x: left.toFixed(2),
        y: top.toFixed(2),
        width: (right - left).toFixed(2),
        height: (bottom - top).toFixed(2),
        preserveAspectRatio: "none",
        class: "fallback-terrain",
        "clip-path": "url(#fallback-island-clip)",
        "aria-hidden": "true",
      }));
      const outline = svgElement("g", { class: "fallback-boundary-outline", "aria-hidden": "true" });
      for (const pathValue of paths) {
        outline.append(svgElement("path", { d: pathValue, fill: "none", stroke: "#8ba18b", "stroke-width": "1.35" }));
      }
      this.svg.append(outline);
    }

    const routeGroup = svgElement("g", { class: "fallback-routes" });
    for (const ride of this.data.rides) {
      const casing = svgElement("path", {
        d: routePath(ride.route, this.project),
        class: "fallback-route-casing",
        "data-ride-id": ride.rideId,
      });
      const route = svgElement("path", {
        d: routePath(ride.route, this.project),
        class: "fallback-route",
        stroke: ride.color,
        "data-ride-id": ride.rideId,
        tabindex: "0",
        role: "button",
        "aria-label": `Select ${ride.label}`,
      });
      route.addEventListener("click", () => this.onSelect("ride", ride.rideId));
      route.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          this.onSelect("ride", ride.rideId);
        }
      });
      routeGroup.append(casing, route);
    }
    this.svg.append(routeGroup);

    const segmentGroup = svgElement("g", { class: "fallback-segments" });
    for (const segment of this.data.segments.filter((entry) => entry.matched && entry.geometry)) {
      const segmentPath = svgElement("path", {
        d: routePath(segment.geometry!, this.project),
        class: "fallback-segment",
        "data-segment-id": segment.segmentId,
        tabindex: "0",
        role: "button",
        "aria-label": `Select ${segment.campLabel} segment`,
      });
      segmentPath.addEventListener("click", () => this.onSelect("segment", segment.segmentId));
      segmentPath.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          this.onSelect("segment", segment.segmentId);
        }
      });
      segmentGroup.append(segmentPath);
    }
    this.svg.append(segmentGroup);

    const labels = svgElement("g", { class: "fallback-labels", "aria-hidden": "true" });
    for (const ride of this.data.rides) {
      const coordinate = ride.labelCoordinate ?? routeLabelCoordinate(ride.route);
      if (!coordinate) continue;
      const [x, y] = this.project(coordinate);
      const label = svgElement("text", { x: x.toFixed(1), y: y.toFixed(1), "data-ride-label": ride.rideId });
      label.textContent = ride.label;
      labels.append(label);
    }
    for (const place of this.data.places.filter((entry) => entry.kind === "region" || entry.kind === "orientation")) {
      const [x, y] = this.project(place.coordinates);
      const label = svgElement("text", { x: x.toFixed(1), y: y.toFixed(1), class: "fallback-region-label" });
      label.textContent = place.name;
      labels.append(label);
    }
    this.svg.append(labels);

    const summitGroup = svgElement("g", { class: "fallback-summits" });
    for (const summit of MALLORCA_SUMMITS) {
      const [x, y] = this.project(summit.coordinates);
      const [labelDx, labelDy] = summit.id === "puig-major" ? [-12, -17]
        : summit.id === "puig-tomir" ? [10, -10]
        : summit.id === "puig-de-galatzo" ? [10, -2]
        : [10, -2];
      const textAnchor = labelDx < 0 ? "end" : "start";
      const group = svgElement("g", {
        class: `fallback-summit${summit.id === "puig-major" || summit.id === "puig-tomir" || summit.id === "puig-de-galatzo" ? " is-primary" : ""}`,
        "data-summit-id": summit.id,
        tabindex: "0",
        role: "button",
        "aria-label": `Open ${summit.name}, ${summit.elevationM.toLocaleString("en")} metres`,
      });
      const halo = svgElement("circle", { cx: x.toFixed(1), cy: y.toFixed(1), r: "9", class: "fallback-summit-halo" });
      const peak = svgElement("path", {
        d: `M${(x - 5).toFixed(1)} ${(y + 4).toFixed(1)} L${x.toFixed(1)} ${(y - 5).toFixed(1)} L${(x + 5).toFixed(1)} ${(y + 4).toFixed(1)} Z`,
        class: "fallback-summit-peak",
      });
      const name = svgElement("text", { x: (x + labelDx).toFixed(1), y: (y + labelDy).toFixed(1), class: "fallback-summit-name", "text-anchor": textAnchor });
      name.textContent = summit.name;
      const elevation = svgElement("text", { x: (x + labelDx).toFixed(1), y: (y + labelDy + 13).toFixed(1), class: "fallback-summit-elevation", "text-anchor": textAnchor });
      elevation.textContent = `${summit.elevationM.toLocaleString("en")} m`;
      group.append(halo, peak, name, elevation);
      group.addEventListener("click", () => this.onSelect("summit", summit.id));
      group.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          this.onSelect("summit", summit.id);
        }
      });
      summitGroup.append(group);
    }
    this.svg.append(summitGroup);
    this.svg.append(svgElement("g", { class: "fallback-point-layer" }));
  }

  update(state: AtlasState, selectedSummitId: string | null = null): void {
    this.svg.querySelectorAll<SVGElement>("[data-ride-id]").forEach((element) => {
      const rideId = element.dataset.rideId;
      element.classList.toggle("is-selected", Boolean(state.selectedRideId && rideId === state.selectedRideId));
      element.classList.toggle("is-dimmed", Boolean(state.selectedRideId && rideId !== state.selectedRideId));
    });
    this.svg.querySelectorAll<SVGElement>("[data-segment-id]").forEach((element) => {
      const segmentId = element.dataset.segmentId;
      const segment = this.data.segments.find((entry) => entry.segmentId === segmentId);
      element.classList.toggle("is-selected", Boolean(state.selectedSegmentId && segmentId === state.selectedSegmentId));
      element.classList.toggle("is-dimmed", Boolean(state.selectedRideId && segment?.rideId !== state.selectedRideId));
    });
    this.svg.querySelectorAll<SVGElement>("[data-ride-label]").forEach((element) => {
      element.classList.toggle("is-dimmed", Boolean(state.selectedRideId && element.dataset.rideLabel !== state.selectedRideId));
    });
    this.svg.querySelectorAll<SVGElement>("[data-summit-id]").forEach((element) => {
      element.classList.toggle("is-selected", element.dataset.summitId === selectedSummitId);
      element.setAttribute("aria-pressed", String(element.dataset.summitId === selectedSummitId));
    });
    const pointLayer = this.svg.querySelector<SVGGElement>(".fallback-point-layer");
    if (!pointLayer) return;
    pointLayer.replaceChildren();
    if (!state.selectedPointId) return;
    const point = this.data.rides.flatMap((ride) => ride.telemetrySamples).find((entry) => entry.sampleId === state.selectedPointId);
    if (!point) return;
    const [x, y] = this.project(point.coordinate);
    pointLayer.append(
      svgElement("circle", { cx: x.toFixed(1), cy: y.toFixed(1), r: "11", class: "fallback-selected-point-halo" }),
      svgElement("circle", { cx: x.toFixed(1), cy: y.toFixed(1), r: "4", class: "fallback-selected-point" }),
    );
  }
}
