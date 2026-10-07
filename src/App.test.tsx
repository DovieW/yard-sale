// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { router } from "./router";

vi.mock("./app-updates", () => ({ APP_UPDATE_EVENT: "app-update-available", updateAvailable: false, installAppUpdate: vi.fn() }));

const stats = { framesProcessed: 0, itemsIdentified: 0, searchesPerformed: 0, modelCalls: 0, lastUpdated: null };
const result = { frameId: "frame", items: [], summary: "The frame is blurry. Move closer and hold steady.", emptyReason: "unclear", stats, run: { latencyMs: 500, modelCalls: 1, searchesPerformed: 0 } };

describe("scanner lifecycle", () => {
  let track: { readyState: string; muted: boolean; stop: ReturnType<typeof vi.fn>; onended: (() => void) | null };
  let getUserMedia: ReturnType<typeof vi.fn>;
  let analyze: ReturnType<typeof vi.fn>;
  let visibility = "visible";
  let deliveringFrames: boolean;
  let framePump: number;
  let playing: WeakSet<HTMLMediaElement>;

  beforeEach(() => {
    localStorage.clear();
    visibility = "visible";
    deliveringFrames = true;
    playing = new WeakSet();
    window.scrollTo = vi.fn();
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
    Object.defineProperty(HTMLMediaElement.prototype, "readyState", { configurable: true, get: () => 2 });
    Object.defineProperty(HTMLVideoElement.prototype, "videoWidth", { configurable: true, get: () => 1920 });
    Object.defineProperty(HTMLVideoElement.prototype, "videoHeight", { configurable: true, get: () => 1080 });
    Object.defineProperty(HTMLMediaElement.prototype, "paused", { configurable: true, get() { return !playing.has(this); } });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) { playing.add(this); return Promise.resolve(); });
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLMediaElement) { playing.delete(this); });
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.setAttribute("open", ""); } });
    let frameId = 0;
    const callbacks = new Map<number, { video: HTMLVideoElement; callback: VideoFrameRequestCallback }>();
    Object.defineProperty(HTMLVideoElement.prototype, "requestVideoFrameCallback", { configurable: true, value: function (callback: VideoFrameRequestCallback) { callbacks.set(++frameId, { video: this, callback }); return frameId; } });
    Object.defineProperty(HTMLVideoElement.prototype, "cancelVideoFrameCallback", { configurable: true, value: (id: number) => callbacks.delete(id) });
    framePump = window.setInterval(() => {
      if (!deliveringFrames || visibility !== "visible") return;
      for (const [id, { video, callback }] of [...callbacks]) {
        const cameraTrack = (video.srcObject as MediaStream | null)?.getVideoTracks()[0];
        if (!playing.has(video) || !cameraTrack || cameraTrack.muted || cameraTrack.readyState !== "live") continue;
        callbacks.delete(id);
        video.currentTime += 0.02;
        callback(performance.now(), {} as VideoFrameCallbackMetadata);
      }
    }, 20);
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => callback(new Blob(["frame"], { type: "image/jpeg" })));
    URL.createObjectURL = vi.fn(() => "blob:test-frame");
    URL.revokeObjectURL = vi.fn();
    track = { readyState: "live", muted: false, stop: vi.fn(), onended: null };
    const cameraTrack = Object.assign(track, { label: "camera 0, facing back", getSettings: () => ({ deviceId: "rear", width: 1920, height: 1080 }), getCapabilities: () => ({}), getConstraints: () => ({}) });
    getUserMedia = vi.fn(async () => ({ getVideoTracks: () => [cameraTrack], getTracks: () => [cameraTrack] }));
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia, enumerateDevices: async () => [{ kind: "videoinput", deviceId: "rear", label: "camera 0, facing back" }], addEventListener: vi.fn(), removeEventListener: vi.fn() } });
    analyze = vi.fn(async () => Response.json(result));
    vi.stubGlobal("fetch", vi.fn((input: string) => {
      if (input === "/api/analyze") return analyze();
      if (input === "/api/stats") return Promise.resolve(Response.json(stats));
      if (input.startsWith("/api/items")) return Promise.resolve(Response.json({ items: [], nextCursor: null }));
      return Promise.resolve(Response.json({ id: "session" }, { status: 201 }));
    }));
  });

  afterEach(() => { cleanup(); window.clearInterval(framePump); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  function mountApp() {
    const testRouter = createRouter({ ...router.options, history: createMemoryHistory({ initialEntries: ["/scan"] }), scrollRestoration: false });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    const rendered = render(<QueryClientProvider client={client}><RouterProvider router={testRouter} /></QueryClientProvider>);
    return { testRouter, ...rendered };
  }

  async function openApp() {
    const rendered = mountApp();
    fireEvent.click(await screen.findByRole("button", { name: "Select camera" }));
    fireEvent.click(screen.getByRole("button", { name: "Use rear camera" }));
    await screen.findByText("Ready", { exact: true });
    return rendered;
  }

  it("keeps the same camera and video element across Scan and History", async () => {
    const { testRouter, container } = await openApp();
    const video = container.querySelector("video")!;
    const stream = video.srcObject;
    expect(video.closest(".camera-stage")?.querySelector("button")).toBeNull();
    expect(screen.getByRole("region", { name: "Live processing statistics" })).toBeTruthy();
    expect(video.closest(".camera-stage")?.querySelector(".stats-ribbon")).toBeNull();
    await act(() => testRouter.navigate({ to: "/history" }));
    expect(track.stop).not.toHaveBeenCalled();
    expect(container.querySelector("video")).toBe(video);
    await act(() => testRouter.navigate({ to: "/scan" }));
    expect(video.srcObject).toBe(stream);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("explains empty results and blocks overlapping snapshots", async () => {
    const { container, testRouter } = await openApp();
    let complete!: (response: Response) => void;
    analyze.mockImplementation(() => new Promise<Response>((resolve) => { complete = resolve; }));
    const snap = screen.getByRole("button", { name: "Take snapshot" });
    fireEvent.click(snap);
    await waitFor(() => expect(analyze).toHaveBeenCalledTimes(1));
    expect(screen.getByText("1/1", { exact: true })).toBeTruthy();
    fireEvent.click(snap);
    expect(analyze).toHaveBeenCalledTimes(1);
    await act(async () => complete(Response.json(result)));
    await screen.findByText("0/1", { exact: true });
    expect(screen.queryByText(result.summary)).toBeNull();
    await act(() => testRouter.navigate({ to: "/history" }));
    await screen.findByText(result.summary);
    expect(container.querySelector("canvas")?.width).toBe(1600);
    expect(container.querySelector("canvas")?.height).toBe(900);
    expect(screen.getByRole("button", { name: "View full frame sent to AI" })).toBeTruthy();
  });

  it("pauses live work in the background and recovers an ended camera on return", async () => {
    const { container } = await openApp();
    fireEvent.click(screen.getByRole("button", { name: "Start live scanning" }));
    await waitFor(() => expect(analyze).toHaveBeenCalledTimes(1));
    expect(container.querySelector(".snapshot-flash")).toBeNull();
    visibility = "hidden";
    fireEvent(document, new Event("visibilitychange"));
    track.readyState = "ended";
    act(() => track.onended?.());
    visibility = "visible";
    getUserMedia.mockImplementation(async () => {
      track.readyState = "live";
      return { getTracks: () => [track], getVideoTracks: () => [track] };
    });
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));
    await screen.findByRole("button", { name: "Stop live scanning" });
  });

  it("pauses scanning on a usage limit while leaving the camera available", async () => {
    await openApp();
    analyze.mockResolvedValue(Response.json({ error: "Image upload limit reached." }, { status: 429 }));
    fireEvent.click(screen.getByRole("button", { name: "Start live scanning" }));
    await screen.findByText("Image upload limit reached.");
    expect(screen.getByRole("button", { name: "Start live scanning" })).toBeTruthy();
    expect(track.stop).not.toHaveBeenCalled();
    expect(analyze).toHaveBeenCalledTimes(1);
  });

  it("ignores a late result after the user turns the camera off", async () => {
    await openApp();
    let complete!: (response: Response) => void;
    analyze.mockImplementation(() => new Promise<Response>((resolve) => { complete = resolve; }));
    fireEvent.click(screen.getByRole("button", { name: "Take snapshot" }));
    await waitFor(() => expect(analyze).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText("Select camera"), { target: { value: "off" } });
    await act(async () => complete(Response.json(result)));
    expect(screen.queryByText(result.summary)).toBeNull();
    expect(screen.getByRole("button", { name: "Select camera" })).toBeTruthy();
  });

  it("announces an app update without stopping an active camera", async () => {
    await openApp();
    fireEvent(window, new Event("app-update-available"));
    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    expect(await screen.findByRole("button", { name: "Update app" })).toBeTruthy();
    expect(track.stop).not.toHaveBeenCalled();
  });

  it("shows a center camera selector initially and after Camera off", async () => {
    await openApp();
    fireEvent.change(screen.getByLabelText("Select camera"), { target: { value: "off" } });
    const centerButton = screen.getByRole("button", { name: "Select camera" });
    expect(centerButton.closest(".camera-empty")).toBeTruthy();
    fireEvent.click(centerButton);
    expect(screen.getByRole("dialog", { name: "Select camera" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Rear camera" }));
    await screen.findByText("Ready", { exact: true });
    expect(getUserMedia).toHaveBeenLastCalledWith({ audio: false, video: expect.objectContaining({ deviceId: { exact: "rear" } }) });
  });

  it("marks a frozen preview interrupted, pauses AI capture, and restarts the hardware", async () => {
    await openApp();
    fireEvent.click(screen.getByRole("button", { name: "Start live scanning" }));
    await waitFor(() => expect(analyze).toHaveBeenCalledTimes(1));
    deliveringFrames = false;
    const now = performance.now.bind(performance);
    vi.spyOn(performance, "now").mockImplementation(() => now() + 6_000);
    await screen.findByText("Camera preview stopped");
    expect(screen.getByText("Interrupted")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start live scanning" })).toBeTruthy();
    expect(track.readyState).toBe("live");
    expect(analyze).toHaveBeenCalledTimes(1);
    deliveringFrames = true;
    fireEvent.click(screen.getByRole("button", { name: "Restart camera" }));
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));
    expect(track.stop).toHaveBeenCalledTimes(1);
    await screen.findByRole("button", { name: "Stop live scanning" });
  });

  it("reattaches a disconnected preview on return even though its camera track is live", async () => {
    const { container } = await openApp();
    const video = container.querySelector("video")!;
    const stream = video.srcObject;
    visibility = "hidden";
    fireEvent(document, new Event("visibilitychange"));
    video.srcObject = null;
    playing.delete(video);
    visibility = "visible";
    fireEvent(document, new Event("visibilitychange"));
    await screen.findByText("Ready", { exact: true });
    expect(video.srcObject).toBe(stream);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(track.stop).not.toHaveBeenCalled();
  });

  it("releases an apparently live camera on Restart even if it still reports Ready", async () => {
    const { container } = await openApp();
    const previous = container.querySelector("video")!.srcObject;
    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Restart camera" }));
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    await screen.findByText("Ready", { exact: true });
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(container.querySelector("video")!.srcObject).not.toBe(previous);
  });

  it("reacquires a live but frozen stream automatically when returning to the app", async () => {
    const { container } = await openApp();
    const video = container.querySelector("video")!;
    const previous = video.srcObject;
    visibility = "hidden";
    fireEvent(document, new Event("visibilitychange"));
    deliveringFrames = false;
    const replacementTrack = { ...track, stop: vi.fn() };
    getUserMedia.mockImplementationOnce(async () => {
      deliveringFrames = true;
      return { getTracks: () => [replacementTrack], getVideoTracks: () => [replacementTrack] };
    });
    visibility = "visible";
    fireEvent(document, new Event("visibilitychange"));
    await screen.findByText("Opening", { exact: true });
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2), { timeout: 4_000 });
    await screen.findByText("Ready", { exact: true });
    expect(track.stop).toHaveBeenCalled();
    expect(replacementTrack.stop).not.toHaveBeenCalled();
    expect(video.srcObject).not.toBe(previous);
    expect(analyze).not.toHaveBeenCalled();
  });
});
