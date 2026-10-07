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
    const first = work.acquire(1)!;
    expect(work.acquire(1)).toBeNull();
    work.invalidate();
    expect(work.isCurrent(first)).toBe(false);
    expect(work.acquire(1)).toBeNull();
    work.release(first);
    const next = work.acquire(1)!;
    expect(work.isCurrent(next)).toBe(true);
    expect(next).not.toBe(first);
  });
  it("releases only the completed request's slot when parallel work finishes out of order", () => {
    const work = new ScanWork();
    const first = work.acquire(2)!;
    const second = work.acquire(2)!;
    expect(work.acquire(2)).toBeNull();
    work.release(second);
    const third = work.acquire(2)!;
    work.release(second);
    expect(work.acquire(2)).toBeNull();
    expect(work.isCurrent(first)).toBe(true);
    expect(work.isCurrent(third)).toBe(true);
    work.invalidate();
    work.release(first);
    const replacement = work.acquire(2)!;
    work.release(first);
    expect(work.acquire(2)).toBeNull();
    expect(work.isCurrent(third)).toBe(false);
    expect(work.isCurrent(replacement)).toBe(true);
  });
  it("drains existing work before admitting a request under a lower limit", () => {
    const work = new ScanWork();
    const first = work.acquire(2)!;
    const second = work.acquire(2)!;
    expect(work.acquire(1)).toBeNull();
    work.release(first);
    expect(work.acquire(1)).toBeNull();
    work.release(second);
    expect(work.acquire(1)).not.toBeNull();
  });
});
