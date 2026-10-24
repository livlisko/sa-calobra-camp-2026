export type Position = [number, number];
export type Bounds = [number, number, number, number];

export type LineString = {
  type: "LineString";
  coordinates: Position[];
};

export type MultiLineString = {
  type: "MultiLineString";
  coordinates: Position[][];
};

export type Polygon = {
  type: "Polygon" | "MultiPolygon";
  coordinates: unknown;
};

export type RouteGeometry = LineString | MultiLineString;

export interface RideSummary {
  distanceKm: number | null;
  ascentM: number | null;
  movingSeconds: number | null;
  averagePowerW: number | null;
  normalizedPowerW: number | null;
  trainingLoad: number | null;
}

export interface TelemetrySample {
  sampleId: string;
  rideId: string;
  movingSeconds: number;
  distanceKm: number;
  coordinate: Position;
  recordedAltitudeM: number | null;
  powerMeanW: number | null;
  powerMaxW: number | null;
  heartRateMeanBpm: number | null;
  cadenceMeanRpm: number | null;
  recordedTemperatureC: number | null;
  speedMeanKmh: number | null;
  gradePct: number | null;
  segmentId: string | null;
  label: string | null;
}

export interface Ride {
  rideId: string;
  date: string;
  label: string;
  subtitle: string | null;
  color: string;
  summary: RideSummary;
  route: MultiLineString;
  boundsWsen: Bounds;
  labelCoordinate: Position | null;
  telemetrySamples: TelemetrySample[];
  note: string | null;
}

export interface SegmentStats {
  elapsedSeconds: number | null;
  distanceKm: number | null;
  elevationGainM: number | null;
  averageGradePct: number | null;
  averagePowerW: number | null;
  averageHeartRateBpm: number | null;
}

export interface Segment {
  segmentId: string;
  rideId: string;
  campLabel: string;
  currentStravaTitle: string | null;
  stravaSegmentId: number | string | null;
  stravaUrl: string | null;
  matched: boolean;
  geometry: RouteGeometry | null;
  startPoint: Position | null;
  endPoint: Position | null;
  stats: SegmentStats;
  confidence: string | null;
  boundaryBasis: string | null;
  note: string | null;
}

export interface Place {
  id: string;
  name: string;
  kind: string;
  coordinates: Position;
  region: string | null;
  shortOrientationNote: string | null;
  approximate: boolean;
}

export interface AtlasData {
  schemaVersion: string;
  generatedAt: string | null;
  map: {
    crs: string;
    islandBoundsWsen: Bounds;
    islandBoundary: Polygon | null;
    boundaryAttribution: string;
  };
  rides: Ride[];
  segments: Segment[];
  places: Place[];
  provenance: Record<string, string>;
  sourceNotes: string[];
}

export type GuideTab = "island" | "rides" | "segments" | "point";
export type TerrainMode = "3d" | "2d";

export interface CameraState {
  longitude: number;
  latitude: number;
  zoom: number;
  bearing: number;
  pitch: number;
}

export interface AtlasState {
  selectedRideId: string | null;
  selectedSegmentId: string | null;
  selectedPointId: string | null;
  previewRideId: string | null;
  terrain: TerrainMode;
  tab: GuideTab;
  camera: CameraState | null;
}
