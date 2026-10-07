export function captureDimensions(width: number, height: number): { width: number; height: number } {
  if (width <= 0 || height <= 0) throw new Error("The camera is still warming up. Try again in a moment.");
  const scale = Math.min(1, 1600 / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export async function waitForVideoReady(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      window.clearTimeout(timer);
      video.removeEventListener("loadeddata", check);
      video.removeEventListener("resize", check);
      video.removeEventListener("error", fail);
    };
    const check = () => {
      if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
        cleanup();
        resolve();
      }
    };
    const fail = () => { cleanup(); reject(new Error("The camera preview could not start. Try reopening the camera.")); };
    const timer = window.setTimeout(fail, 8_000);
    video.addEventListener("loadeddata", check);
    video.addEventListener("resize", check);
    video.addEventListener("error", fail);
    check();
  });
}
