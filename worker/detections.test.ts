import { describe, expect, it } from "vitest";
import { compatibleIdentity, usableDetection } from "./detections";

describe("saved detections", () => {
  const candidate = { name: "Ceramic mug", confidence: 0.85, boundingBox: { xMin: 100, yMin: 100, xMax: 600, yMax: 700 } };
  it("rejects uncertain and invalid object locations", () => {
    expect(usableDetection(candidate)).toBe(true);
    expect(usableDetection({ ...candidate, confidence: 0.4 })).toBe(false);
    expect(usableDetection({ ...candidate, boundingBox: { ...candidate.boundingBox, xMax: 50 } })).toBe(false);
  });
  it("does not merge a different brand or model into an earlier find", () => {
    expect(compatibleIdentity({ brand: "Sony", model: "WH-1000XM4" }, { brand: "Sony", model: "WH1000XM4" })).toBe(true);
    expect(compatibleIdentity({ brand: "Sony", model: "WH-1000XM5" }, { brand: "Sony", model: "WH1000XM4" })).toBe(false);
    expect(compatibleIdentity({ brand: "Bose", model: null }, { brand: "Sony", model: null })).toBe(false);
  });
});
