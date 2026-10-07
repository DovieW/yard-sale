import type { BoundingBox } from "../src/types";

export function usableDetection(candidate: { name: string; confidence: number; boundingBox: BoundingBox }): boolean {
  const box = candidate.boundingBox;
  return candidate.name.trim().length > 1 && candidate.confidence >= 0.7
    && box.xMin < box.xMax && box.yMin < box.yMax;
}

export function compatibleIdentity(candidate: { brand: string | null; model: string | null }, saved: { brand: string | null; model: string | null }): boolean {
  const normalized = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (["brand", "model"] as const).every((key) => !candidate[key] || !saved[key] || normalized(candidate[key]!) === normalized(saved[key]!));
}
