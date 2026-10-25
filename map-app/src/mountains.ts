import type { Position } from "./types";

export type MallorcaSummitId =
  | "puig-major"
  | "puig-de-massanella"
  | "puig-tomir"
  | "puig-de-lofre"
  | "puig-des-teix"
  | "puig-de-galatzo";

export interface SummitSourceReference {
  readonly publisher: string;
  readonly sourceId: string;
  readonly url: string;
}

export interface SummitCoordinateSource extends SummitSourceReference {
  readonly osmNodeId: number;
}

export interface MountainSummit {
  readonly id: MallorcaSummitId;
  readonly name: string;
  /** WGS84 longitude, latitude. */
  readonly coordinates: Position;
  /** Display elevation from the cited Govern de les Illes Balears source. */
  readonly elevationM: number;
  readonly orientation: string;
  readonly sources: {
    readonly elevation: SummitSourceReference;
    readonly coordinates: SummitCoordinateSource;
  };
}

export interface MountainSummitFeature {
  readonly type: "Feature";
  readonly id: MallorcaSummitId;
  readonly properties: {
    readonly id: MallorcaSummitId;
    readonly name: string;
    readonly label: string;
    readonly elevationM: number;
    readonly orientation: string;
    readonly elevationSourceId: string;
    readonly elevationSourceUrl: string;
    readonly osmNodeId: number;
    readonly coordinateSourceUrl: string;
  };
  readonly geometry: {
    readonly type: "Point";
    readonly coordinates: Position;
  };
}

export interface MountainSummitFeatureCollection {
  readonly type: "FeatureCollection";
  readonly features: MountainSummitFeature[];
}

const caibSource = (sourceId: string, url: string): SummitSourceReference => ({
  publisher: "Govern de les Illes Balears",
  sourceId,
  url,
});

const osmNodeSource = (osmNodeId: number): SummitCoordinateSource => ({
  publisher: "OpenStreetMap contributors",
  sourceId: `openstreetmap:node/${osmNodeId}`,
  url: `https://www.openstreetmap.org/node/${osmNodeId}`,
  osmNodeId,
});

// OSM supplies the WGS84 point locations only. Elevations intentionally follow
// the cited CAIB publications, including where an OSM `ele` tag differs.
export const MALLORCA_SUMMITS = [
  {
    id: "puig-major",
    name: "Puig Major",
    coordinates: [2.7940933, 39.8072082],
    elevationM: 1445,
    orientation: "The island high point and central Tramuntana skyline anchor above Cúber.",
    sources: {
      elevation: caibSource(
        "caib:geoturfront:point-of-interest-32",
        "https://intranet.caib.es/geoturfront/ca/puntos_interes/32/descripcion.html",
      ),
      coordinates: osmNodeSource(788275291),
    },
  },
  {
    id: "puig-de-massanella",
    name: "Puig de Massanella",
    coordinates: [2.8529508, 39.8060385],
    elevationM: 1364,
    orientation: "The long high ridge east of Puig Major, between Lluc and Caimari.",
    sources: {
      elevation: caibSource(
        "caib:IVPGDIF_CAST_abr2015:section-2.1.2.1",
        "https://www.caib.es/sites/xarxaforestal/es/d/iv_plan_general_de_defensa_contra_los_incendios_forestales_de_las_islas_baleares/",
      ),
      coordinates: osmNodeSource(26863660),
    },
  },
  {
    id: "puig-tomir",
    name: "Puig Tomir",
    coordinates: [2.9257245, 39.8432001],
    elevationM: 1103,
    orientation: "The isolated north-eastern summit above Lluc, facing Pollença and Alcúdia.",
    sources: {
      elevation: caibSource(
        "caib:espaisnaturalsprotegits:itinerary-1_02",
        "https://www.caib.es/sites/espaisnaturalsprotegits/ca/1_02_pujada_al_puig_tomir/",
      ),
      coordinates: osmNodeSource(485230586),
    },
  },
  {
    id: "puig-de-lofre",
    name: "Puig de l'Ofre",
    coordinates: [2.7670301, 39.7633676],
    elevationM: 1093,
    orientation: "The pyramidal summit south of Cúber at the head of the Biniaraix gorge.",
    sources: {
      elevation: caibSource(
        "caib:espaisnaturalsprotegits:publication-488037",
        "https://www.caib.es/sites/espaisnaturalsprotegits/ca/10_11_itinerari_de_cuber_a_biniarix/archivopub.do?ctrl=MCRST15886ZI488037&id=488037",
      ),
      coordinates: osmNodeSource(26783257),
    },
  },
  {
    id: "puig-des-teix",
    name: "Puig des Teix",
    coordinates: [2.6613627, 39.7312993],
    elevationM: 1064,
    orientation: "The western Tramuntana landmark above Deià and Valldemossa.",
    sources: {
      elevation: caibSource(
        "caib:PACES_DEIA_2030:page-7",
        "https://www.caib.es/sites/batles/ca/d/pla_daaccia_per_a_laenergia_sostenible_i_el_clima_paesc_-_deia/",
      ),
      coordinates: osmNodeSource(948801654),
    },
  },
  {
    id: "puig-de-galatzo",
    name: "Puig de Galatzó",
    coordinates: [2.48667, 39.633934],
    elevationM: 1026,
    orientation: "The isolated south-western sentinel above Estellencs and Calvià.",
    sources: {
      elevation: caibSource(
        "caib:espaisnaturalsprotegits:publication-488062",
        "https://www.caib.es/sites/espaisnaturalsprotegits/ca/6_02_itinerari_del_puig_de_galatzo_per_son_fortuny/archivopub.do?ctrl=MCRST15886ZI488062&id=488062",
      ),
      coordinates: osmNodeSource(26864368),
    },
  },
] as const satisfies readonly MountainSummit[];

export function mountainSummitsGeoJson(
  summits: readonly MountainSummit[] = MALLORCA_SUMMITS,
): MountainSummitFeatureCollection {
  return {
    type: "FeatureCollection",
    features: summits.map((summit) => ({
      type: "Feature",
      id: summit.id,
      properties: {
        id: summit.id,
        name: summit.name,
        label: `${summit.name} · ${summit.elevationM} m`,
        elevationM: summit.elevationM,
        orientation: summit.orientation,
        elevationSourceId: summit.sources.elevation.sourceId,
        elevationSourceUrl: summit.sources.elevation.url,
        osmNodeId: summit.sources.coordinates.osmNodeId,
        coordinateSourceUrl: summit.sources.coordinates.url,
      },
      geometry: { type: "Point", coordinates: summit.coordinates },
    })),
  };
}
