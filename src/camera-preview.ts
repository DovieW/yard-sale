export const CAMERA_STALL_MS = 5_000;

export type CameraPreview = ReturnType<typeof watchCameraPreview>;

// A live MediaStreamTrack can outlive a paused or disconnected video element.
// Watch frames reaching the compositor, not just permission or track state:
// https://wicg.github.io/video-rvfc/
export function watchCameraPreview(
  video: HTMLVideoElement,
  stream: MediaStream,
  callbacks: { isVisible: () => boolean; onReady: () => void; onInterrupted: () => void },
) {
  let stopped = false;
  let healthy = false;
  let interrupted = false;
  let visible = callbacks.isVisible();
  let startedAt = performance.now();
  let lastFrameAt: number | null = null;
  let lastVideoTime = video.currentTime;
  let frameCallback: number | null = null;
  const waiters = new Set<{ resolve: () => void; reject: (error: Error) => void }>();
  const hasFrameCallback = typeof video.requestVideoFrameCallback === "function";
  const playable = () => video.srcObject === stream && !video.paused && !video.ended
    && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0
    && stream.getVideoTracks().some((track) => track.readyState === "live" && !track.muted);
  const isHealthy = () => !stopped && callbacks.isVisible() && healthy && playable()
    && lastFrameAt !== null && performance.now() - lastFrameAt < CAMERA_STALL_MS;
  const reset = () => {
    healthy = false;
    interrupted = false;
    lastFrameAt = null;
    lastVideoTime = video.currentTime;
    startedAt = performance.now();
  };
  const receivedFrame = () => {
    if (stopped || !callbacks.isVisible() || !playable()) return;
    lastFrameAt = performance.now();
    interrupted = false;
    if (!healthy) {
      healthy = true;
      callbacks.onReady();
    }
    for (const waiter of waiters) waiter.resolve();
  };
  const requestFrame = () => {
    frameCallback = video.requestVideoFrameCallback(() => {
      receivedFrame();
      if (!stopped) requestFrame();
    });
  };
  if (hasFrameCallback) requestFrame();
  const timer = window.setInterval(() => {
    const nowVisible = callbacks.isVisible();
    if (!nowVisible) {
      visible = false;
      reset();
      return;
    }
    if (!visible) { visible = true; reset(); }
    if (!hasFrameCallback && video.currentTime !== lastVideoTime) receivedFrame();
    lastVideoTime = video.currentTime;
    if (isHealthy()) return;
    if (performance.now() - (lastFrameAt ?? startedAt) < CAMERA_STALL_MS) return;
    healthy = false;
    if (!interrupted) {
      interrupted = true;
      callbacks.onInterrupted();
    }
  }, 500);

  return {
    isHealthy,
    reset,
    waitForFrame(timeoutMs = 8_000): Promise<void> {
      if (isHealthy()) return Promise.resolve();
      if (stopped) return Promise.reject(new Error("Camera preview was closed."));
      return new Promise((resolve, reject) => {
        const finish = (error?: Error) => {
          window.clearTimeout(timeout);
          waiters.delete(waiter);
          if (error) reject(error); else resolve();
        };
        const waiter = { resolve: () => finish(), reject: (error: Error) => finish(error) };
        const timeout = window.setTimeout(() => finish(new Error("No camera frames are arriving. Select a camera to try again.")), timeoutMs);
        waiters.add(waiter);
      });
    },
    stop() {
      stopped = true;
      window.clearInterval(timer);
      if (frameCallback !== null) video.cancelVideoFrameCallback(frameCallback);
      for (const waiter of waiters) waiter.reject(new Error("Camera preview was closed."));
    },
  };
}
