import * as maplibregl from "maplibre-gl";
import type { ExpressionSpecification, MapLayerMouseEvent, MapMouseEvent } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import { MALLORCA_SUMMITS } from "./mountains";
import type { MountainSummit } from "./mountains";
import type { AtlasData, AtlasState, Bounds, CameraState, Position, Ride, Segment, TelemetrySample, TerrainMode } from "./types";

// MapLibre's ESM build otherwise derives a sibling worker name from the
// Vite-hashed application chunk. Emitting and binding the worker explicitly
// keeps the renderer functional from a GitHub Pages subpath and under CSPs
// that disallow blob workers.
maplibregl.setWorkerUrl(maplibreWorkerUrl);

const OPENFREEMAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";
const MAPTERHORN_TILEJSON = "https://tiles.mapterhorn.com/tilejson.json";
const MAX_BOUNDS: [[number, number], [number, number]] = [[2.14, 39.10], [3.70, 40.10]];

type JsonProperties = Record<string, string | number | boolean | null>;
type GeoFeature = {
  type: "Feature";
  id?: string | number;
  properties: JsonProperties;
  geometry: { type: string; coordinates: unknown };
};
type FeatureCollection = { type: "FeatureCollection"; features: GeoFeature[] };

export interface ReliefMapEvents {
  onReady: () => void;
  onStatus: (message: string, kind?: "quiet" | "warning" | "error") => void;
  onRideClick: (rideId: string, position: Position) => void;
  onSegmentClick: (segmentId: string) => void;
  onPointClick: (pointId: string) => void;
  onSummitClick: (summitId: string) => void;
  onCameraChange: () => void;
}

function rideFeatures(data: AtlasData): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: data.rides.map((ride) => ({
      type: "Feature",
      id: ride.rideId,
      properties: { rideId: ride.rideId, label: ride.label, color: ride.color },
      geometry: ride.route,
    })),
  };
}

function segmentFeatures(data: AtlasData): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: data.segments
      .filter((segment) => segment.matched && segment.geometry)
      .map((segment) => ({
        type: "Feature",
        id: segment.segmentId,
        properties: { segmentId: segment.segmentId, rideId: segment.rideId, label: segment.campLabel },
        geometry: segment.geometry!,
      })),
  };
}

function segmentStartFeatures(data: AtlasData): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: data.segments
      .filter((segment) => segment.matched && segment.startPoint)
      .map((segment) => ({
        type: "Feature",
        id: segment.segmentId,
        properties: { segmentId: segment.segmentId, rideId: segment.rideId, label: segment.campLabel },
        geometry: { type: "Point", coordinates: segment.startPoint! },
      })),
  };
}

function pointFeatures(data: AtlasData): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: data.rides.flatMap((ride) =>
      ride.telemetrySamples.map((point) => ({
        type: "Feature" as const,
        id: point.sampleId,
        properties: {
          pointId: point.sampleId,
          rideId: ride.rideId,
          distanceKm: point.distanceKm,
          altitudeM: point.recordedAltitudeM,
          powerW: point.powerMeanW,
          heartRateBpm: point.heartRateMeanBpm,
        },
        geometry: { type: "Point", coordinates: point.coordinate },
      })),
    ),
  };
}

function longestLineMidpoint(ride: Ride): Position | null {
  const line = [...ride.route.coordinates].sort((a, b) => b.length - a.length)[0];
  return line?.[Math.floor(line.length * 0.54)] ?? null;
}

function labelFeatures(data: AtlasData): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: data.rides.flatMap((ride) => {
      const coordinate = ride.labelCoordinate ?? longestLineMidpoint(ride);
      if (!coordinate) return [];
      return [{
        type: "Feature" as const,
        id: ride.rideId,
        properties: { rideId: ride.rideId, label: ride.label, color: ride.color },
        geometry: { type: "Point", coordinates: coordinate },
      }];
    }),
  };
}

function placeFeatures(data: AtlasData): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: data.places.map((place) => ({
      type: "Feature",
      id: place.id,
      properties: {
        id: place.id,
        name: place.name,
        kind: place.kind,
        region: place.region,
        approximate: place.approximate,
      },
      geometry: { type: "Point", coordinates: place.coordinates },
    })),
  };
}

function usesCompactMapLayout(): boolean {
  return window.matchMedia("(max-width: 760px), (max-width: 840px) and (orientation: portrait)").matches;
}

function mapPadding(): maplibregl.PaddingOptions {
  const narrow = usesCompactMapLayout();
  return narrow
    ? { top: 82, right: 28, bottom: 92, left: 28 }
    : { top: 100, right: 52, bottom: 88, left: 52 };
}

function safeFeatureId(event: MapLayerMouseEvent, key: string): string | null {
  const value = event.features?.[0]?.properties?.[key];
  return typeof value === "string" ? value : value == null ? null : String(value);
}

export class ReliefMap {
  private map: maplibregl.Map;
  private ready = false;
  private destroyed = false;
  private selectedRideId: string | null = null;
  private selectedSegmentId: string | null = null;
  private selectedPointId: string | null = null;
  private selectedSummitId: string | null = null;
  private summitMarkers = new Map<string, { marker: maplibregl.Marker; button: HTMLButtonElement }>();
  private liveCheckAttempts = 0;
  private loadTimeout: number;

  constructor(
    container: HTMLElement,
    private readonly data: AtlasData,
    initialState: AtlasState,
    private readonly events: ReliefMapEvents,
  ) {
    this.selectedSummitId = initialState.selectedSummitId;
    const camera = initialState.camera;
    this.map = new maplibregl.Map({
      container,
      style: OPENFREEMAP_STYLE,
      center: camera ? [camera.longitude, camera.latitude] : [2.88, 39.66],
      zoom: camera?.zoom ?? 8.45,
      bearing: camera?.bearing ?? -8,
      pitch: camera?.pitch ?? (initialState.terrain === "3d" ? 52 : 0),
      maxPitch: 74,
      maxBounds: MAX_BOUNDS,
      renderWorldCopies: false,
      canvasContextAttributes: { antialias: true },
      attributionControl: false,
      cooperativeGestures: true,
      fadeDuration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 200,
    });
    this.map.addControl(new maplibregl.NavigationControl({ showCompass: true, visualizePitch: true }), "top-right");
    this.map.addControl(new maplibregl.ScaleControl({ maxWidth: 110, unit: "metric" }), "bottom-left");
    this.map.addControl(
      new maplibregl.AttributionControl({
        compact: true,
        customAttribution: [
          '<a href="https://openfreemap.org/" target="_blank" rel="noreferrer">OpenFreeMap</a>',
          '<a href="https://mapterhorn.com/attribution" target="_blank" rel="noreferrer">© Mapterhorn</a>',
          "Ride traces: rider-supplied Garmin FIT",
        ],
      }),
      "bottom-right",
    );
    this.events.onStatus("Loading live terrain…", "quiet");
    this.loadTimeout = window.setTimeout(() => {
      if (!this.ready) this.events.onStatus("Live tiles are taking too long. The static route map remains available.", "warning");
    }, 12_000);
    this.map.once("load", () => this.onStyleLoad(initialState));
    this.map.on("error", (event) => this.onMapError(event.error));
    this.map.on("moveend", () => {
      this.updateSummitDensity();
      if (this.ready) this.events.onCameraChange();
    });
  }

  private onStyleLoad(initialState: AtlasState): void {
    if (this.destroyed) return;
    this.restyleBase();
    const styleLayers = this.map.getStyle().layers ?? [];
    const firstLabel = styleLayers.find((layer) => layer.type === "symbol" && Boolean(layer.layout?.["text-field"]))?.id;
    this.map.addSource("mallorca-terrain", {
      type: "raster-dem",
      url: MAPTERHORN_TILEJSON,
      tileSize: 512,
      encoding: "terrarium",
      attribution: '<a href="https://mapterhorn.com/attribution" target="_blank" rel="noreferrer">© Mapterhorn</a>',
    });
    this.map.addSource("mallorca-hillshade-dem", {
      type: "raster-dem",
      url: MAPTERHORN_TILEJSON,
      tileSize: 512,
      encoding: "terrarium",
      attribution: '<a href="https://mapterhorn.com/attribution" target="_blank" rel="noreferrer">© Mapterhorn</a>',
    });
    this.map.addLayer(
      {
        id: "mallorca-hillshade",
        type: "hillshade",
        source: "mallorca-hillshade-dem",
        paint: {
          "hillshade-shadow-color": "#092326",
          "hillshade-highlight-color": "#fff0c7",
          "hillshade-accent-color": "#6d866d",
          "hillshade-exaggeration": 0.58,
        },
      },
      firstLabel,
    );
    this.map.addSource("camp-routes", { type: "geojson", data: rideFeatures(this.data) as never, promoteId: "rideId" });
    this.map.addSource("camp-segments", { type: "geojson", data: segmentFeatures(this.data) as never, promoteId: "segmentId" });
    this.map.addSource("camp-segment-starts", { type: "geojson", data: segmentStartFeatures(this.data) as never, promoteId: "segmentId" });
    this.map.addSource("camp-points", { type: "geojson", data: pointFeatures(this.data) as never, promoteId: "pointId" });
    this.map.addSource("camp-labels", { type: "geojson", data: labelFeatures(this.data) as never, promoteId: "rideId" });
    this.map.addSource("island-places", { type: "geojson", data: placeFeatures(this.data) as never, promoteId: "id" });

    this.map.addLayer(
      {
        id: "camp-route-shadow",
        type: "line",
        source: "camp-routes",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#001114",
          "line-width": ["interpolate", ["linear"], ["zoom"], 7, 3.8, 10, 7.2, 13, 11],
          "line-opacity": ["case", ["boolean", ["feature-state", "dimmed"], false], 0.24, 0.72],
          "line-blur": 1.4,
        },
      },
      firstLabel,
    );
    this.map.addLayer(
      {
        id: "camp-routes-line",
        type: "line",
        source: "camp-routes",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": ["get", "color"],
          "line-width": [
            "interpolate", ["linear"], ["zoom"],
            7, ["case", ["boolean", ["feature-state", "selected"], false], 3.5, ["boolean", ["feature-state", "dimmed"], false], 1.3, 2.4],
            10, ["case", ["boolean", ["feature-state", "selected"], false], 6.2, ["boolean", ["feature-state", "dimmed"], false], 2.2, 4.2],
            13, ["case", ["boolean", ["feature-state", "selected"], false], 9, ["boolean", ["feature-state", "dimmed"], false], 3.3, 6],
          ],
          "line-opacity": [
            "case",
            ["boolean", ["feature-state", "selected"], false], 1,
            ["boolean", ["feature-state", "preview"], false], 0.98,
            ["boolean", ["feature-state", "dimmed"], false], 0.3,
            0.86,
          ],
        },
      },
      firstLabel,
    );
    this.map.addLayer(
      {
        id: "camp-segment-casing",
        type: "line",
        source: "camp-segments",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#061417",
          "line-width": ["interpolate", ["linear"], ["zoom"], 8, 4.5, 12, 10],
          "line-opacity": ["case", ["boolean", ["feature-state", "dimmed"], false], 0.05, 0.82],
        },
      },
      firstLabel,
    );
    this.map.addLayer(
      {
        id: "camp-segments-line",
        type: "line",
        source: "camp-segments",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": ["case", ["boolean", ["feature-state", "selected"], false], "#fff6cf", "#edc767"],
          "line-width": [
            "interpolate", ["linear"], ["zoom"],
            8, ["case", ["boolean", ["feature-state", "selected"], false], 4, 2.2],
            12, ["case", ["boolean", ["feature-state", "selected"], false], 8.5, 5],
          ],
          "line-opacity": ["case", ["boolean", ["feature-state", "dimmed"], false], 0.06, 0.96],
        },
      },
      firstLabel,
    );
    this.map.addLayer(
      {
        id: "camp-segment-starts",
        type: "circle",
        source: "camp-segment-starts",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 2.8, 12, 5.2],
          "circle-color": "#edc767",
          "circle-stroke-color": "#061417",
          "circle-stroke-width": 1.5,
          "circle-opacity": ["case", ["boolean", ["feature-state", "dimmed"], false], 0.06, 1],
        },
      },
      firstLabel,
    );
    this.map.addLayer({
      id: "camp-telemetry-halo",
      type: "circle",
      source: "camp-points",
      minzoom: 9,
      filter: ["==", ["get", "rideId"], "__none__"],
      paint: {
        "circle-radius": ["case", ["boolean", ["feature-state", "selected"], false], 9, 4.5],
        "circle-color": ["case", ["boolean", ["feature-state", "selected"], false], "#fff6cf", "#0c2225"],
        "circle-stroke-color": "#fff6cf",
        "circle-stroke-width": ["case", ["boolean", ["feature-state", "selected"], false], 3, 1],
        "circle-opacity": ["case", ["boolean", ["feature-state", "selected"], false], 1, 0.64],
      },
    });
    this.map.addLayer({
      id: "camp-telemetry-points",
      type: "circle",
      source: "camp-points",
      minzoom: 9,
      filter: ["==", ["get", "rideId"], "__none__"],
      paint: {
        "circle-radius": ["case", ["boolean", ["feature-state", "selected"], false], 4.5, 2.4],
        "circle-color": "#fff9e7",
        "circle-opacity": 0.96,
      },
    });
    this.map.addLayer({
      id: "orientation-regions",
      type: "symbol",
      source: "island-places",
      filter: ["match", ["get", "kind"], ["region", "orientation"], true, false],
      layout: {
        "text-field": ["get", "name"],
        "text-font": ["Noto Sans Regular"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 7, 10, 10, 14],
        "text-letter-spacing": 0.12,
        "text-transform": "uppercase",
        "text-allow-overlap": false,
      },
      paint: {
        "text-color": "#d4dcc7",
        "text-halo-color": "#153129",
        "text-halo-width": 1.3,
        "text-opacity": ["interpolate", ["linear"], ["zoom"], 7, 0.68, 11, 0.34],
      },
    });
    this.map.addLayer({
      id: "camp-route-labels",
      type: "symbol",
      source: "camp-labels",
      minzoom: 7.4,
      layout: {
        "text-field": ["get", "label"],
        "text-font": ["Noto Sans Bold"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 7, 10, 11, 13],
        "text-anchor": "bottom",
        "text-offset": [0, -0.7],
        "text-padding": 5,
        "text-optional": true,
      },
      paint: {
        "text-color": ["get", "color"],
        "text-halo-color": "#07191b",
        "text-halo-width": 2.2,
        "text-opacity": ["case", ["boolean", ["feature-state", "dimmed"], false], 0.18, 1],
      },
    });

    this.addSummitMarkers();

    this.bindInteractions();
    this.setTerrain(initialState.terrain, false);
    this.updateSelection(initialState);
    if (!initialState.camera) this.showIsland(false);
    this.map.once("idle", () => this.verifyLiveFrame());
  }

  private restyleBase(): void {
    for (const layer of this.map.getStyle().layers ?? []) {
      const sourceLayer = "source-layer" in layer ? layer["source-layer"] : undefined;
      try {
        if (layer.type === "background") this.map.setPaintProperty(layer.id, "background-color", "#0a2528");
        if (layer.type === "fill" && sourceLayer === "water") {
          this.map.setPaintProperty(layer.id, "fill-color", "#0a3035");
          this.map.setPaintProperty(layer.id, "fill-opacity", 0.96);
        }
        if (layer.type === "line" && sourceLayer === "waterway") {
          this.map.setPaintProperty(layer.id, "line-color", "#39777a");
        }
        if (layer.type === "fill" && sourceLayer === "park") {
          this.map.setPaintProperty(layer.id, "fill-color", "#41664d");
          this.map.setPaintProperty(layer.id, "fill-opacity", 0.42);
        }
        if (layer.type === "fill" && sourceLayer === "landcover" && /wood|forest/i.test(layer.id)) {
          this.map.setPaintProperty(layer.id, "fill-color", "#355d49");
          this.map.setPaintProperty(layer.id, "fill-opacity", 0.52);
        }
        if (
          layer.type === "line" &&
          sourceLayer === "transportation" &&
          /^(road|tunnel|bridge)_/i.test(layer.id) &&
          !/(rail|hatching|oneway)/i.test(layer.id)
        ) {
          const layerId = layer.id.toLowerCase();
          const isCasing = layerId.endsWith("_casing");
          const context = layerId.startsWith("tunnel_") ? "tunnel" : layerId.startsWith("bridge_") ? "bridge" : "road";
          const originalOpacity = this.map.getPaintProperty(layer.id, "line-opacity");
          const baseOpacity = typeof originalOpacity === "number"
            ? originalOpacity
            : Array.isArray(originalOpacity)
              ? originalOpacity as ExpressionSpecification
              : 1;

          if (isCasing) {
            const opacity = { road: 0.52, tunnel: 0.36, bridge: 0.58 }[context];
            this.map.setPaintProperty(layer.id, "line-color", "#153236");
            this.map.setPaintProperty(layer.id, "line-opacity", ["*", baseOpacity, opacity]);
          } else {
            const isMajor = /(?:motorway|trunk_primary)$/.test(layerId) && !/motorway_link$/.test(layerId);
            const isSecondary = /(?:secondary_tertiary|motorway_link|_link)$/.test(layerId);
            const color = isMajor ? "#a6b2ac" : isSecondary ? "#8d9e97" : "#738680";
            const opacity = isMajor
              ? { road: 0.48, tunnel: 0.32, bridge: 0.54 }[context]
              : isSecondary
                ? { road: 0.36, tunnel: 0.25, bridge: 0.42 }[context]
                : { road: 0.22, tunnel: 0.15, bridge: 0.27 }[context];
            this.map.setPaintProperty(layer.id, "line-color", color);
            this.map.setPaintProperty(layer.id, "line-opacity", ["*", baseOpacity, opacity]);
          }
        }
      } catch {
        // Some style layers do not expose every paint property across style versions.
      }
    }
  }

  private addSummitMarkers(): void {
    for (const summit of MALLORCA_SUMMITS) {
      const selected = summit.id === this.selectedSummitId;
      const button = document.createElement("button");
      button.type = "button";
      button.className = `summit-marker${summit.id === "puig-major" || summit.id === "puig-tomir" || summit.id === "puig-de-galatzo" ? " is-primary" : ""}${selected ? " is-selected" : ""}`;
      button.dataset.summitId = summit.id;
      button.setAttribute("aria-pressed", String(selected));
      button.setAttribute("aria-label", `Open ${summit.name}, ${summit.elevationM.toLocaleString("en")} metres`);
      const card = document.createElement("span");
      card.className = "summit-marker-card";
      const name = document.createElement("strong");
      name.textContent = summit.name;
      const elevation = document.createElement("small");
      elevation.textContent = `${summit.elevationM.toLocaleString("en")} m`;
      card.append(name, elevation);
      const stem = document.createElement("span");
      stem.className = "summit-marker-stem";
      stem.setAttribute("aria-hidden", "true");
      const anchor = document.createElement("span");
      anchor.className = "summit-marker-anchor";
      anchor.setAttribute("aria-hidden", "true");
      button.append(card, stem, anchor);
      button.addEventListener("click", () => this.events.onSummitClick(summit.id));
      const marker = new maplibregl.Marker({ element: button, anchor: "bottom", opacityWhenCovered: 0.18 })
        .setLngLat(summit.coordinates)
        .addTo(this.map);
      this.summitMarkers.set(summit.id, { marker, button });
    }
    this.updateSummitDensity();
  }

  private updateSummitDensity(): void {
    const threshold = usesCompactMapLayout() ? 10.2 : 9.45;
    const detailed = this.map.getZoom() >= threshold;
    for (const marker of this.summitMarkers.values()) marker.button.classList.toggle("is-detailed", detailed);
  }

  private bindInteractions(): void {
    ["camp-routes-line", "camp-segments-line", "camp-segment-starts", "camp-telemetry-halo", "camp-telemetry-points"].forEach((layer) => {
      this.map.on("mouseenter", layer, () => { this.map.getCanvas().style.cursor = "pointer"; });
      this.map.on("mouseleave", layer, () => { this.map.getCanvas().style.cursor = ""; });
    });
    this.map.on("click", (event: MapMouseEvent) => {
      const features = this.map.queryRenderedFeatures(event.point, {
        layers: ["camp-segment-starts", "camp-segments-line", "camp-telemetry-points", "camp-telemetry-halo", "camp-routes-line"],
      });
      const segment = features.find((feature) => feature.layer.id === "camp-segment-starts" || feature.layer.id === "camp-segments-line");
      const segmentId = segment?.properties?.segmentId;
      if (segmentId != null) {
        this.events.onSegmentClick(String(segmentId));
        return;
      }
      const point = features.find((feature) => feature.layer.id === "camp-telemetry-points" || feature.layer.id === "camp-telemetry-halo");
      const pointId = point?.properties?.pointId;
      if (pointId != null) {
        this.events.onPointClick(String(pointId));
        return;
      }
      const route = features.find((feature) => feature.layer.id === "camp-routes-line");
      const rideId = route?.properties?.rideId;
      if (rideId != null) this.events.onRideClick(String(rideId), [event.lngLat.lng, event.lngLat.lat]);
    });
    this.map.on("mousemove", "camp-routes-line", (event) => {
      const hovered = safeFeatureId(event, "rideId");
      for (const ride of this.data.rides) this.setFeatureState("camp-routes", ride.rideId, { preview: ride.rideId === hovered });
    });
    this.map.on("mouseleave", "camp-routes-line", () => {
      for (const ride of this.data.rides) this.setFeatureState("camp-routes", ride.rideId, { preview: false });
    });
  }

  private verifyLiveFrame(): void {
    if (this.destroyed || this.ready) return;
    this.map.triggerRepaint();
    window.requestAnimationFrame(() => {
      const canvas = this.map.getCanvas();
      const painter = (this.map as unknown as { painter?: { context?: { gl?: WebGLRenderingContext | WebGL2RenderingContext } } }).painter;
      const gl = painter?.context?.gl;
      let nonblank = false;
      if (gl && canvas.width > 0 && canvas.height > 0) {
        try {
          const width = Math.min(24, canvas.width);
          const height = Math.min(24, canvas.height);
          const x = Math.max(0, Math.floor(canvas.width / 2 - width / 2));
          const y = Math.max(0, Math.floor(canvas.height / 2 - height / 2));
          const pixels = new Uint8Array(width * height * 4);
          gl.readPixels(x, y, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
          nonblank = pixels.some((value, index) => index % 4 !== 3 && value > 2);
        } catch {
          nonblank = false;
        }
      }
      const sourceRideIds = new Set(
        this.map
          .querySourceFeatures("camp-routes")
          .map((feature) => feature.properties?.rideId)
          .filter((rideId): rideId is string => typeof rideId === "string"),
      );
      const renderedRoutes = this.map.queryRenderedFeatures({ layers: ["camp-routes-line"] });
      // `queryRenderedFeatures()` can report zero for terrain-draped GeoJSON
      // lines in some WebGL implementations even when the layer is visibly
      // drawn. Verify the complete source and its active style layer instead;
      // the canvas readback above still guards against a blank renderer.
      const sourceLoaded = this.map.isSourceLoaded("camp-routes");
      const routeLayerReady = Boolean(this.map.getLayer("camp-routes-line"));
      const routesReady = sourceRideIds.size === this.data.rides.length && sourceLoaded && routeLayerReady;
      if (nonblank && routesReady) {
        this.ready = true;
        window.clearTimeout(this.loadTimeout);
        this.events.onStatus("Live terrain ready", "quiet");
        this.events.onReady();
        return;
      }
      this.liveCheckAttempts += 1;
      if (this.liveCheckAttempts < 5) {
        window.setTimeout(() => this.verifyLiveFrame(), 500);
      } else {
        const campLayerIds = (this.map.getStyle().layers ?? []).map((layer) => layer.id).filter((id) => id.startsWith("camp-"));
        console.warn(
          `Mallorca live map verification did not pass: nonblank=${nonblank}, sourceRideCount=${sourceRideIds.size}, sourceLoaded=${sourceLoaded}, routeLayerReady=${routeLayerReady}, renderedRouteCount=${renderedRoutes.length}, campLayers=${campLayerIds.join(",")}.`,
        );
        this.events.onStatus("Live map could not be verified. The static route map remains available.", "warning");
      }
    });
  }

  private onMapError(error: { message?: string } | undefined): void {
    const message = error?.message ?? "Unknown map error";
    if (/camp-(?:routes|segments)-line/i.test(message)) console.warn(`Mallorca route layer error: ${message}`);
    if (/terrain|dem|mapterhorn/i.test(message)) console.warn(`Mallorca terrain error: ${message}`);
    if (/terrain|dem|mapterhorn/i.test(message) && this.map.isStyleLoaded()) {
      this.events.onStatus("Terrain tiles are unavailable; routes remain on the 2D map.", "warning");
      return;
    }
    if (!this.ready) this.events.onStatus("Live tiles are unavailable. The static route map remains available.", "warning");
  }

  private setFeatureState(source: string, id: string, state: Record<string, boolean>): void {
    if (!this.map.getSource(source)) return;
    try {
      this.map.setFeatureState({ source, id }, state);
    } catch {
      // Feature state can be skipped while a style reload is settling.
    }
  }

  updateSelection(state: AtlasState): void {
    if (!this.map.getSource("camp-routes")) return;
    for (const ride of this.data.rides) {
      this.setFeatureState("camp-routes", ride.rideId, {
        selected: ride.rideId === state.selectedRideId,
        dimmed: Boolean(state.selectedRideId && ride.rideId !== state.selectedRideId),
      });
      this.setFeatureState("camp-labels", ride.rideId, {
        selected: ride.rideId === state.selectedRideId,
        dimmed: Boolean(state.selectedRideId && ride.rideId !== state.selectedRideId),
      });
    }
    for (const segment of this.data.segments.filter((entry) => entry.matched)) {
      this.setFeatureState("camp-segments", segment.segmentId, {
        selected: segment.segmentId === state.selectedSegmentId,
        dimmed: Boolean(state.selectedRideId && segment.rideId !== state.selectedRideId),
      });
      this.setFeatureState("camp-segment-starts", segment.segmentId, {
        selected: segment.segmentId === state.selectedSegmentId,
        dimmed: Boolean(state.selectedRideId && segment.rideId !== state.selectedRideId),
      });
    }
    if (this.selectedPointId) this.setFeatureState("camp-points", this.selectedPointId, { selected: false });
    if (state.selectedPointId) this.setFeatureState("camp-points", state.selectedPointId, { selected: true });
    this.selectedRideId = state.selectedRideId;
    this.selectedSegmentId = state.selectedSegmentId;
    this.selectedPointId = state.selectedPointId;
    const filter = state.selectedRideId
      ? ["==", ["get", "rideId"], state.selectedRideId]
      : ["==", ["get", "rideId"], "__none__"];
    this.map.setFilter("camp-telemetry-halo", filter as never);
    this.map.setFilter("camp-telemetry-points", filter as never);
  }

  setTerrain(mode: TerrainMode, animate = true): void {
    if (!this.map.getSource("mallorca-terrain")) return;
    if (mode === "3d") {
      this.map.setTerrain({ source: "mallorca-terrain", exaggeration: 1.2 });
      this.moveCamera({ pitch: Math.max(48, this.map.getPitch()), bearing: this.map.getBearing() || -8 }, animate);
    } else {
      this.map.setTerrain(null);
      this.moveCamera({ pitch: 0, bearing: 0 }, animate);
    }
  }

  showIsland(animate = true): void {
    this.fitBounds(this.data.map.islandBoundsWsen, animate, true);
  }

  fitRide(ride: Ride, animate = true): void {
    this.fitBounds(ride.boundsWsen, animate, false);
  }

  fitSegment(segment: Segment, animate = true): void {
    if (!segment.geometry) return;
    const coordinates = segment.geometry.type === "LineString" ? segment.geometry.coordinates : segment.geometry.coordinates.flat();
    const bounds = coordinates.reduce<Bounds>(
      (result, [longitude, latitude]) => [
        Math.min(result[0], longitude), Math.min(result[1], latitude), Math.max(result[2], longitude), Math.max(result[3], latitude),
      ],
      [Infinity, Infinity, -Infinity, -Infinity],
    );
    this.fitBounds(bounds, animate, false, 13.2);
  }

  focusPoint(point: TelemetrySample, animate = true): void {
    this.moveCamera({ center: point.coordinate, zoom: Math.max(12.3, this.map.getZoom()), pitch: this.map.getTerrain() ? 58 : 0 }, animate);
  }

  selectSummit(summitId: string | null, focus = false, animate = true): void {
    this.selectedSummitId = summitId;
    for (const [id, marker] of this.summitMarkers) {
      const selected = id === summitId;
      marker.button.classList.toggle("is-selected", selected);
      marker.button.setAttribute("aria-pressed", String(selected));
    }
    if (!focus || !summitId) return;
    const summit: MountainSummit | undefined = MALLORCA_SUMMITS.find((entry) => entry.id === summitId);
    if (!summit) return;
    const mobile = usesCompactMapLayout();
    this.moveCamera({
      center: summit.coordinates,
      zoom: mobile ? 10.2 : 10.7,
      pitch: this.map.getTerrain() ? (mobile ? 54 : 64) : 0,
      bearing: this.map.getTerrain() ? 34 : 0,
      offset: mobile ? [0, -20] : [-110, 0],
    }, animate);
  }

  restoreCamera(camera: CameraState): void {
    this.map.jumpTo({
      center: [camera.longitude, camera.latitude],
      zoom: camera.zoom,
      bearing: camera.bearing,
      pitch: camera.pitch,
    });
  }

  private fitBounds(bounds: Bounds, animate: boolean, island: boolean, maxZoom = 11.8): void {
    const [west, south, east, north] = bounds;
    const options: maplibregl.FitBoundsOptions = {
      padding: mapPadding(),
      duration: this.motionDuration(animate),
      maxZoom,
      pitch: this.map.getTerrain() ? (island ? 48 : 56) : 0,
      bearing: this.map.getTerrain() ? (island ? -8 : this.map.getBearing()) : 0,
    };
    this.map.fitBounds([[west, south], [east, north]], options);
  }

  private moveCamera(options: maplibregl.EaseToOptions, animate: boolean): void {
    const duration = this.motionDuration(animate);
    this.map.easeTo({ ...options, duration, easing: (value) => 1 - Math.pow(1 - value, 3) });
  }

  private motionDuration(animate: boolean): number {
    return animate && !window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 820 : 0;
  }

  getCamera() {
    return this.map;
  }

  resize(): void {
    if (!this.destroyed) this.map.resize();
  }

  destroy(): void {
    this.destroyed = true;
    window.clearTimeout(this.loadTimeout);
    this.map.remove();
  }
}
