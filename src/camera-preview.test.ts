// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAMERA_STALL_MS, watchCameraPreview, type CameraPreview } from "./camera-preview";

describe("camera preview health", () => {
  let preview: CameraPreview;
  let visible: boolean;
  let frame: VideoFrameRequestCallback | undefined;
  let video: HTMLVideoElement;
  let stream: MediaStream;
  let track: { readyState: string; muted: boolean };
  let onReady: ReturnType<typeof vi.fn>;
  let onInterrupted: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"] });
    visible = true;
    frame = undefined;
    track = { readyState: "live", muted: false };
    stream = { getVideoTracks: () => [track] } as unknown as MediaStream;
    video = {
      srcObject: stream, paused: false, ended: false, readyState: 2,
      videoWidth: 1920, videoHeight: 1080, currentTime: 0,
      requestVideoFrameCallback: vi.fn((callback: VideoFrameRequestCallback) => { frame = callback; return 1; }),
      cancelVideoFrameCallback: vi.fn(),
    } as unknown as HTMLVideoElement;
    onReady = vi.fn();
    onInterrupted = vi.fn();
  });
  afterEach(() => { preview?.stop(); vi.useRealTimers(); });

  const watch = () => watchCameraPreview(video, stream, { isVisible: () => visible, onReady, onInterrupted });
  const presentFrame = () => frame?.(performance.now(), {} as VideoFrameCallbackMetadata);

  it("requires a presented frame even when the track is live and dimensions are known", async () => {
    preview = watch();
    const ready = preview.waitForFrame();
    expect(preview.isHealthy()).toBe(false);
    expect(onReady).not.toHaveBeenCalled();
    presentFrame();
    await ready;
    expect(preview.isHealthy()).toBe(true);
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it("detects frozen frames with a live track and accepts newly presented frames", () => {
    preview = watch();
    presentFrame();
    vi.advanceTimersByTime(CAMERA_STALL_MS + 1_000);
    expect(track.readyState).toBe("live");
    expect(preview.isHealthy()).toBe(false);
    expect(onInterrupted).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2_000);
    expect(onInterrupted).toHaveBeenCalledTimes(1);
    presentFrame();
    expect(preview.isHealthy()).toBe(true);
    expect(onReady).toHaveBeenCalledTimes(2);
  });

  it("ignores background suspension and requires fresh frames after return", async () => {
    preview = watch();
    presentFrame();
    visible = false;
    vi.advanceTimersByTime(60_000);
    expect(onInterrupted).not.toHaveBeenCalled();
    visible = true;
    vi.advanceTimersByTime(500);
    expect(preview.isHealthy()).toBe(false);
    const ready = preview.waitForFrame();
    presentFrame();
    await ready;
    expect(preview.isHealthy()).toBe(true);
  });

  it("rejects stale frames from a disconnected or muted source", () => {
    preview = watch();
    presentFrame();
    video.srcObject = null;
    expect(preview.isHealthy()).toBe(false);
    vi.advanceTimersByTime(CAMERA_STALL_MS);
    expect(onInterrupted).toHaveBeenCalledTimes(1);
    video.srcObject = stream;
    track.muted = true;
    presentFrame();
    expect(preview.isHealthy()).toBe(false);
    track.muted = false;
    presentFrame();
    expect(preview.isHealthy()).toBe(true);
  });

  it("uses playback progress when video-frame callbacks are unavailable", () => {
    Object.assign(video, { requestVideoFrameCallback: undefined });
    preview = watch();
    vi.advanceTimersByTime(500);
    expect(preview.isHealthy()).toBe(false);
    video.currentTime = 0.5;
    vi.advanceTimersByTime(500);
    expect(preview.isHealthy()).toBe(true);
    vi.advanceTimersByTime(CAMERA_STALL_MS);
    expect(onInterrupted).toHaveBeenCalledTimes(1);
  });

  it("times out missing frames and cancels pending work when the camera closes", async () => {
    preview = watch();
    const timeout = expect(preview.waitForFrame(1_000)).rejects.toThrow("No camera frames");
    vi.advanceTimersByTime(1_000);
    await timeout;
    const closed = expect(preview.waitForFrame()).rejects.toThrow("closed");
    preview.stop();
    await closed;
    expect(video.cancelVideoFrameCallback).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
