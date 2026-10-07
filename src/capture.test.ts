import { describe, expect, it } from "vitest";
import { captureDimensions } from "./capture";
import { ScanWork } from "./scan-work";

describe("full-frame capture", () => {
  it("retains portrait and landscape aspect ratios without cropping", () => {
    expect(captureDimensions(1920, 1080)).toEqual({ width: 1600, height: 900 });
    expect(captureDimensions(1080, 1920)).toEqual({ width: 900, height: 1600 });
    expect(captureDimensions(640, 480)).toEqual({ width: 640, height: 480 });
  });
  it("rejects a camera that has no image yet", () => {
    expect(() => captureDimensions(0, 1080)).toThrow("warming up");
  });
});

describe("scan work", () => {
  it("blocks overlapping captures, including when a replaced source is still pending", () => {
    const work = new ScanWork();
    const first = work.acquire()!;
    expect(work.acquire()).toBeNull();
    work.invalidate();
    expect(work.isCurrent(first)).toBe(false);
    expect(work.acquire()).toBeNull();
    work.release();
    const next = work.acquire()!;
    expect(work.isCurrent(next)).toBe(true);
    expect(next).not.toBe(first);
  });
});
