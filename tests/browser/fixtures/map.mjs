import { readFile } from "node:fs/promises";

const flatTile = await readFile(new URL("./flat-tile.png", import.meta.url));
const tileHost = "https://atlas-tiles.example";
const style = {
  version: 8,
  sources: { base: { type: "raster", tiles: [tileHost + "/base/{z}/{x}/{y}.png"], tileSize: 256 } },
  layers: [
    { id: "background", type: "background", paint: { "background-color": "#153036" } },
    { id: "base", type: "raster", source: "base" },
  ],
};

const roadStyle = {
  version: 8,
  sources: { base: { type: "vector", tiles: [tileHost + "/base/{z}/{x}/{y}.pbf"] } },
  layers: [style.layers[0], { id: "roads", type: "line", source: "base", "source-layer": "roads" }],
};

// Two synthetic MVTs with the same source layer. The second has no features.
export const roadTile = Buffer.from("Ghx4AgoFcm9hZHMogCASDhIAGAIiCAkAAAqAQIBA", "base64");
export const emptyRoadTile = Buffer.from("Ggx4AgoFcm9hZHMogCA=", "base64");

// Serve every remote map dependency locally while retaining the real renderer,
// bundled worker, selection data and geographic tile boundaries.
export async function serveMap(page, { baseTile, styleRequest, vector = false } = {}) {
  const baseStyle = vector ? roadStyle : style;
  await page.route("https://tiles.openfreemap.org/styles/liberty", (route) =>
    styleRequest ? styleRequest(route, baseStyle) : route.fulfill({ json: baseStyle }));
  await page.route("https://tiles.mapterhorn.com/tilejson.json", (route) =>
    route.fulfill({ json: { tilejson: "3.0.0", tiles: [tileHost + "/dem/{z}/{x}/{y}.png"], minzoom: 0, maxzoom: 6 } }));
  await page.route(tileHost + "/**", (route) => {
    const isBase = route.request().url().includes("/base/");
    const respond = () => vector && isBase
      ? route.fulfill({ contentType: "application/x-protobuf", body: roadTile })
      : route.fulfill({ contentType: "image/png", body: flatTile });
    if (baseTile && isBase) return baseTile(route, respond);
    return respond();
  });
}
