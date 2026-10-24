import type { AtlasData, AtlasState, Bounds, Position, RouteGeometry } from "./types";

const SVG_NS = "http://www.w3.org/2000/svg";
const VIEWBOX_WIDTH = 1000;
const VIEWBOX_HEIGHT = 680;
const PADDING = 42;

type SelectionHandler = (kind: "ride" | "segment", id: string) => void;

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
      "The northwest Serra de Tramuntana appears as schematic relief. Route lines and verified segment traces remain selectable using the ride guide.";
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
    const sea = svgElement("rect", {
      x: "0",
      y: "0",
      width: String(VIEWBOX_WIDTH),
      height: String(VIEWBOX_HEIGHT),
      fill: "url(#fallback-sea)",
    });
    this.svg.append(title, description, defs, sea);

    const boundaryGroup = svgElement("g", { class: "fallback-boundary", filter: "url(#fallback-shadow)" });
    const paths = boundaryPaths(this.data, this.project);
    if (paths.length) {
      for (const pathValue of paths) {
        boundaryGroup.append(svgElement("path", { d: pathValue, fill: "url(#fallback-land)", stroke: "#80927a", "stroke-width": "1.4" }));
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

    const relief = svgElement("g", { class: "fallback-relief", "aria-hidden": "true" });
    [0, 1, 2, 3, 4].forEach((index) => {
      relief.append(
        svgElement("path", {
          d: `M${125 + index * 16} ${246 + index * 22} C220 ${151 + index * 15}, 355 ${132 + index * 15}, ${506 + index * 18} ${178 + index * 13}`,
          fill: "none",
          stroke: index % 2 ? "#a8bd93" : "#d7ce9c",
          "stroke-opacity": String(0.15 - index * 0.015),
          "stroke-width": String(10 - index),
          "stroke-linecap": "round",
        }),
      );
    });
    this.svg.append(relief);

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
    this.svg.append(svgElement("g", { class: "fallback-point-layer" }));
  }

  update(state: AtlasState): void {
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
