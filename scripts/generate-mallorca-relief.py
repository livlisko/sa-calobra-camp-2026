#!/usr/bin/env python3
"""Build a land-only Mallorca relief raster from Mapterhorn Terrarium tiles.

The output grid uses the exact WGS84 island bounds in the reviewed public map
snapshot and a linear longitude/latitude projection.  That matches the static
SVG renderer in ``map-app/src/fallback.ts``; the Mapterhorn Web Mercator tiles
are resampled onto that grid before hillshading.

Run from the repository root with Python 3:

    python3 scripts/generate-mallorca-relief.py

Only Pillow and NumPy are required. Downloaded source tiles are cached below
the repository's ignored ``work/`` directory.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Iterable

import numpy as np
from PIL import Image, ImageDraw


TILEJSON_URL = "https://tiles.mapterhorn.com/tilejson.json"
TERRARIUM_FORMULA = "elevation_m = red * 256 + green + blue / 256 - 32768"
DEFAULT_WIDTH = 1200
DEFAULT_ZOOM = 10
DEFAULT_QUALITY = 84
DEFAULT_MAX_BYTES = 700 * 1024
MASK_SUPERSAMPLE = 4
USER_AGENT = "sa-calobra-camp-2026-relief-builder/1.0"


def parse_args(repo_root: Path) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--width", type=int, default=DEFAULT_WIDTH, help="Output width in pixels (default: 1200).")
    parser.add_argument("--zoom", type=int, default=DEFAULT_ZOOM, help="Mapterhorn source zoom (default: 10).")
    parser.add_argument("--quality", type=int, default=DEFAULT_QUALITY, help="Lossy WebP RGB quality (default: 84).")
    parser.add_argument(
        "--snapshot",
        type=Path,
        default=repo_root / "map-app/public/data/mallorca-map.snapshot.json",
        help="Reviewed atlas snapshot containing the bounds and island polygon.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=repo_root / "map-app/public/assets/mallorca-relief.webp",
        help="Destination WebP path.",
    )
    parser.add_argument(
        "--cache-dir",
        type=Path,
        default=repo_root / "work/mapterhorn-terrain-cache",
        help="Ignored directory used to cache downloaded source tiles.",
    )
    parser.add_argument(
        "--max-bytes",
        type=int,
        default=DEFAULT_MAX_BYTES,
        help="Fail validation when the output exceeds this byte count.",
    )
    return parser.parse_args()


def fetch(url: str, destination: Path, attempts: int = 3) -> bytes:
    if destination.exists() and destination.stat().st_size > 0:
        return destination.read_bytes()

    destination.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json,image/webp,*/*"})
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                payload = response.read()
            if not payload:
                raise RuntimeError(f"Empty response from {url}")
            temporary = destination.with_suffix(destination.suffix + ".tmp")
            temporary.write_bytes(payload)
            os.replace(temporary, destination)
            return payload
        except (OSError, urllib.error.URLError, RuntimeError) as error:
            last_error = error
            if attempt < attempts:
                time.sleep(0.75 * attempt)
    raise RuntimeError(f"Could not download {url}: {last_error}")


def web_mercator_tile_position(longitude: float, latitude: float, zoom: int) -> tuple[float, float]:
    world_tiles = 2**zoom
    x = (longitude + 180.0) / 360.0 * world_tiles
    latitude_radians = math.radians(max(-85.05112878, min(85.05112878, latitude)))
    y = (1.0 - math.asinh(math.tan(latitude_radians)) / math.pi) / 2.0 * world_tiles
    return x, y


def tile_indices(bounds: tuple[float, float, float, float], zoom: int) -> tuple[int, int, int, int]:
    west, south, east, north = bounds
    west_x, south_y = web_mercator_tile_position(west, south, zoom)
    east_x, north_y = web_mercator_tile_position(east, north, zoom)
    return (
        math.floor(west_x),
        math.floor(math.nextafter(east_x, -math.inf)),
        math.floor(north_y),
        math.floor(math.nextafter(south_y, -math.inf)),
    )


def decode_terrarium(image: Image.Image) -> np.ndarray:
    rgb = np.asarray(image.convert("RGB"), dtype=np.float32)
    return rgb[:, :, 0] * 256.0 + rgb[:, :, 1] + rgb[:, :, 2] / 256.0 - 32768.0


def load_elevation_mosaic(
    bounds: tuple[float, float, float, float],
    zoom: int,
    tile_size: int,
    tile_template: str,
    cache_dir: Path,
) -> tuple[np.ndarray, tuple[int, int], list[str]]:
    x_min, x_max, y_min, y_max = tile_indices(bounds, zoom)
    mosaic = np.empty(((y_max - y_min + 1) * tile_size, (x_max - x_min + 1) * tile_size), dtype=np.float32)
    source_urls: list[str] = []

    for y in range(y_min, y_max + 1):
        for x in range(x_min, x_max + 1):
            url = tile_template.replace("{z}", str(zoom)).replace("{x}", str(x)).replace("{y}", str(y))
            suffix = Path(url.split("?", 1)[0]).suffix or ".tile"
            tile_path = cache_dir / f"z{zoom}" / f"{x}-{y}{suffix}"
            payload = fetch(url, tile_path)
            try:
                from io import BytesIO

                with Image.open(BytesIO(payload)) as tile:
                    if tile.size != (tile_size, tile_size):
                        raise ValueError(f"Tile {url} is {tile.size}, expected {(tile_size, tile_size)}")
                    elevation = decode_terrarium(tile)
            except Exception as error:
                tile_path.unlink(missing_ok=True)
                raise RuntimeError(f"Could not decode terrain tile {url}: {error}") from error

            row = (y - y_min) * tile_size
            column = (x - x_min) * tile_size
            mosaic[row : row + tile_size, column : column + tile_size] = elevation
            source_urls.append(url)

    return mosaic, (x_min, y_min), source_urls


def bilinear_sample_elevation(
    mosaic: np.ndarray,
    mosaic_origin: tuple[int, int],
    bounds: tuple[float, float, float, float],
    zoom: int,
    tile_size: int,
    width: int,
    height: int,
) -> np.ndarray:
    west, south, east, north = bounds
    longitudes = west + (np.arange(width, dtype=np.float64) + 0.5) / width * (east - west)
    latitudes = north - (np.arange(height, dtype=np.float64) + 0.5) / height * (north - south)
    world_pixels = float((2**zoom) * tile_size)

    source_x = (longitudes + 180.0) / 360.0 * world_pixels - mosaic_origin[0] * tile_size - 0.5
    latitude_radians = np.radians(latitudes)
    source_y = (
        (1.0 - np.arcsinh(np.tan(latitude_radians)) / math.pi) / 2.0 * world_pixels
        - mosaic_origin[1] * tile_size
        - 0.5
    )
    source_x = np.clip(source_x, 0.0, mosaic.shape[1] - 1.000001)
    source_y = np.clip(source_y, 0.0, mosaic.shape[0] - 1.000001)

    x0 = np.floor(source_x).astype(np.int32)
    y0 = np.floor(source_y).astype(np.int32)
    x1 = np.minimum(x0 + 1, mosaic.shape[1] - 1)
    y1 = np.minimum(y0 + 1, mosaic.shape[0] - 1)
    x_weight = (source_x - x0)[None, :]
    y_weight = (source_y - y0)[:, None]

    top = mosaic[np.ix_(y0, x0)] * (1.0 - x_weight) + mosaic[np.ix_(y0, x1)] * x_weight
    bottom = mosaic[np.ix_(y1, x0)] * (1.0 - x_weight) + mosaic[np.ix_(y1, x1)] * x_weight
    return (top * (1.0 - y_weight) + bottom * y_weight).astype(np.float32)


def iter_polygons(geometry: dict[str, Any]) -> Iterable[list[list[list[float]]]]:
    geometry_type = geometry.get("type")
    coordinates = geometry.get("coordinates")
    if geometry_type == "Polygon" and isinstance(coordinates, list):
        yield coordinates
    elif geometry_type == "MultiPolygon" and isinstance(coordinates, list):
        yield from coordinates
    else:
        raise ValueError(f"Expected a Polygon or MultiPolygon island boundary, received {geometry_type!r}")


def build_island_mask(
    geometry: dict[str, Any],
    bounds: tuple[float, float, float, float],
    width: int,
    height: int,
) -> np.ndarray:
    scale = MASK_SUPERSAMPLE
    west, south, east, north = bounds
    mask = Image.new("L", (width * scale, height * scale), 0)
    drawing = ImageDraw.Draw(mask)

    def project(ring: list[list[float]]) -> list[tuple[float, float]]:
        return [
            (
                (float(position[0]) - west) / (east - west) * width * scale,
                (north - float(position[1])) / (north - south) * height * scale,
            )
            for position in ring
        ]

    for polygon in iter_polygons(geometry):
        if not polygon:
            continue
        drawing.polygon(project(polygon[0]), fill=255)
        for hole in polygon[1:]:
            drawing.polygon(project(hole), fill=0)

    mask = mask.resize((width, height), Image.Resampling.LANCZOS)
    return np.asarray(mask, dtype=np.uint8)


def color_ramp(elevation: np.ndarray) -> np.ndarray:
    stops = np.array([0.0, 60.0, 180.0, 400.0, 700.0, 1000.0, 1450.0], dtype=np.float32)
    colors = np.array(
        [
            [24, 62, 58],
            [37, 76, 64],
            [55, 91, 68],
            [78, 105, 73],
            [111, 119, 78],
            [151, 139, 86],
            [218, 190, 118],
        ],
        dtype=np.float32,
    )
    clipped = np.clip(elevation, stops[0], stops[-1])
    return np.stack([np.interp(clipped, stops, colors[:, channel]) for channel in range(3)], axis=-1)


def hillshade(elevation: np.ndarray, bounds: tuple[float, float, float, float]) -> np.ndarray:
    west, south, east, north = bounds
    mean_latitude = math.radians((south + north) / 2.0)
    meters_per_degree_latitude = 111_132.0
    meters_per_degree_longitude = 111_320.0 * math.cos(mean_latitude)
    pixel_size_east = (east - west) * meters_per_degree_longitude / elevation.shape[1]
    pixel_size_south = (north - south) * meters_per_degree_latitude / elevation.shape[0]
    gradient_south, gradient_east = np.gradient(elevation, pixel_size_south, pixel_size_east)

    normal_east = -gradient_east
    normal_south = -gradient_south
    inverse_length = 1.0 / np.sqrt(normal_east * normal_east + normal_south * normal_south + 1.0)
    normal_east *= inverse_length
    normal_south *= inverse_length
    normal_up = inverse_length

    altitude = math.radians(42.0)

    def illumination(azimuth_degrees: float) -> np.ndarray:
        azimuth = math.radians(azimuth_degrees)
        sun_east = math.cos(altitude) * math.sin(azimuth)
        sun_south = -math.cos(altitude) * math.cos(azimuth)
        sun_up = math.sin(altitude)
        return np.clip(normal_east * sun_east + normal_south * sun_south + normal_up * sun_up, 0.0, 1.0)

    # A mostly northwestern light with two nearby fills preserves readable
    # slopes without the false hard-black shadows of a single light source.
    return 0.68 * illumination(315.0) + 0.20 * illumination(275.0) + 0.12 * illumination(350.0)


def render_relief(
    elevation: np.ndarray,
    alpha: np.ndarray,
    bounds: tuple[float, float, float, float],
) -> Image.Image:
    terrain = np.maximum(elevation, 0.0)
    shade = hillshade(terrain, bounds)
    base = color_ramp(terrain)
    lighting = np.clip(0.46 + 0.80 * shade, 0.43, 1.24)
    warm_highlight = np.maximum(shade - 0.68, 0.0)[:, :, None] * np.array([22.0, 18.0, 7.0], dtype=np.float32)
    rgb = np.clip(base * lighting[:, :, None] + warm_highlight, 0.0, 255.0).astype(np.uint8)
    rgb[alpha == 0] = 0
    rgba = np.dstack((rgb, alpha))
    return Image.fromarray(rgba, mode="RGBA")


def validate_output(path: Path, expected_size: tuple[int, int], max_bytes: int) -> dict[str, Any]:
    file_size = path.stat().st_size
    with Image.open(path) as image:
        image.load()
        rgba = image.convert("RGBA")
        if rgba.size != expected_size:
            raise RuntimeError(f"Output is {rgba.size}, expected {expected_size}")
        alpha = np.asarray(rgba, dtype=np.uint8)[:, :, 3]

    transparent = int(np.count_nonzero(alpha == 0))
    partial = int(np.count_nonzero((alpha > 0) & (alpha < 255)))
    opaque = int(np.count_nonzero(alpha == 255))
    corner_alpha = [int(alpha[0, 0]), int(alpha[0, -1]), int(alpha[-1, 0]), int(alpha[-1, -1])]
    if not transparent or any(corner_alpha):
        raise RuntimeError(f"Island alpha mask failed validation; corners={corner_alpha}, transparent={transparent}")
    if file_size > max_bytes:
        raise RuntimeError(f"Output is {file_size} bytes, over the {max_bytes}-byte limit")

    return {
        "dimensions": list(expected_size),
        "bytes": file_size,
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "alphaPixels": {"transparent": transparent, "partial": partial, "opaque": opaque},
        "cornerAlpha": corner_alpha,
    }


def main() -> None:
    repo_root = Path(__file__).resolve().parents[1]
    args = parse_args(repo_root)
    snapshot_path = args.snapshot.resolve()
    output_path = args.output.resolve()
    cache_dir = args.cache_dir.resolve()
    snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
    map_data = snapshot.get("map", {})
    raw_bounds = map_data.get("islandBoundsWsen")
    boundary = map_data.get("islandBoundary")
    if not isinstance(raw_bounds, list) or len(raw_bounds) != 4:
        raise ValueError("Snapshot map.islandBoundsWsen must contain west, south, east, north")
    if not isinstance(boundary, dict):
        raise ValueError("Snapshot map.islandBoundary is required to make the alpha mask")
    bounds = tuple(float(value) for value in raw_bounds)
    west, south, east, north = bounds
    if not (west < east and south < north):
        raise ValueError(f"Invalid island bounds: {bounds}")
    if args.width < 320:
        raise ValueError("Output width must be at least 320 pixels")
    if not (1 <= args.quality <= 100):
        raise ValueError("WebP quality must be between 1 and 100")

    height = round(args.width * (north - south) / (east - west))
    tilejson_path = cache_dir / "tilejson.json"
    tilejson = json.loads(fetch(TILEJSON_URL, tilejson_path).decode("utf-8"))
    if tilejson.get("encoding") != "terrarium":
        raise ValueError(f"Mapterhorn TileJSON encoding is {tilejson.get('encoding')!r}, expected 'terrarium'")
    tile_size = int(tilejson.get("tileSize", 512))
    tile_templates = tilejson.get("tiles")
    if not isinstance(tile_templates, list) or not tile_templates or not isinstance(tile_templates[0], str):
        raise ValueError("Mapterhorn TileJSON did not provide a usable tile template")
    tile_template = tile_templates[0]

    mosaic, mosaic_origin, tile_urls = load_elevation_mosaic(
        bounds, args.zoom, tile_size, tile_template, cache_dir
    )
    elevation = bilinear_sample_elevation(
        mosaic, mosaic_origin, bounds, args.zoom, tile_size, args.width, height
    )
    alpha = build_island_mask(boundary, bounds, args.width, height)

    image = render_relief(elevation, alpha, bounds)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_output = output_path.with_suffix(output_path.suffix + ".tmp")
    image.save(temporary_output, format="WEBP", quality=args.quality, method=6, exact=True)
    os.replace(temporary_output, output_path)

    land = alpha >= 128
    validation = validate_output(output_path, (args.width, height), args.max_bytes)
    validation.update(
        {
            "output": str(output_path),
            "boundsWsen": list(bounds),
            "projection": "linear longitude/latitude (EPSG:4326 bounds)",
            "tilejsonUrl": TILEJSON_URL,
            "tileTemplate": tile_template,
            "terrariumFormula": TERRARIUM_FORMULA,
            "sourceZoom": args.zoom,
            "sourceTileSize": tile_size,
            "sourceTileCount": len(tile_urls),
            "sourceTileRange": {
                "x": [min(int(url.split("/")[-2]) for url in tile_urls), max(int(url.split("/")[-2]) for url in tile_urls)],
                "y": [min(int(Path(url).stem) for url in tile_urls), max(int(Path(url).stem) for url in tile_urls)],
            },
            "landElevationMeters": {
                "minimum": round(float(np.min(elevation[land])), 2),
                "maximum": round(float(np.max(elevation[land])), 2),
            },
        }
    )
    print(json.dumps(validation, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
