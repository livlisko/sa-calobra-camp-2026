import { FitBaseType, FitEncoder } from "fit-file-parser/encoder";

// Small synthetic activity following the public Sa Calobra segment geometry.
export function encodeSegmentFit(segment, startedAt, sport = 2) {
  const coordinates = segment.geometry.type === "LineString" ? segment.geometry.coordinates : segment.geometry.coordinates.flat();
  const encoder = new FitEncoder();
  const semicircles = (degrees) => Math.round(degrees * 2 ** 31 / 180);
  encoder.writeMessage(0, [
    { number: 0, size: 1, baseType: FitBaseType.Enum, value: 4 },
    { number: 1, size: 2, baseType: FitBaseType.Uint16, value: 1 },
    { number: 4, size: 4, baseType: FitBaseType.Uint32, value: FitEncoder.toFitTimestamp(startedAt) },
  ]);
  coordinates.forEach(([longitude, latitude], index) => {
    const fraction = index / (coordinates.length - 1);
    const timestamp = new Date(startedAt.valueOf() + index * 5000);
    encoder.writeMessage(20, [
      { number: 0, size: 4, baseType: FitBaseType.Sint32, value: semicircles(latitude) },
      { number: 1, size: 4, baseType: FitBaseType.Sint32, value: semicircles(longitude) },
      { number: 2, size: 2, baseType: FitBaseType.Uint16, value: Math.round((100 + fraction * 660 + 500) * 5) },
      { number: 3, size: 1, baseType: FitBaseType.Uint8, value: 155 },
      { number: 4, size: 1, baseType: FitBaseType.Uint8, value: 80 },
      { number: 5, size: 4, baseType: FitBaseType.Uint32, value: Math.round(fraction * 9410 * 100) },
      { number: 7, size: 2, baseType: FitBaseType.Uint16, value: 220 },
      { number: 253, size: 4, baseType: FitBaseType.Uint32, value: FitEncoder.toFitTimestamp(timestamp) },
    ], 1);
  });
  const durationSeconds = (coordinates.length - 1) * 5;
  encoder.writeMessage(18, [
    { number: 2, size: 4, baseType: FitBaseType.Uint32, value: FitEncoder.toFitTimestamp(startedAt) },
    { number: 5, size: 1, baseType: FitBaseType.Enum, value: sport },
    { number: 7, size: 4, baseType: FitBaseType.Uint32, value: durationSeconds * 1000 },
    { number: 8, size: 4, baseType: FitBaseType.Uint32, value: durationSeconds * 1000 },
    { number: 253, size: 4, baseType: FitBaseType.Uint32, value: FitEncoder.toFitTimestamp(new Date(startedAt.valueOf() + durationSeconds * 1000)) },
  ], 2);
  return encoder.close();
}
