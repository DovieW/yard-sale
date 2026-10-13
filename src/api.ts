import type { AnalysisResponse, DetectedItem } from "./types";

export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export async function readApiResponse<T>(response: Response): Promise<T> {
  if (!response.headers.get("content-type")?.includes("application/json")) {
    throw new ApiError("Your sign-in may have expired. Reload the app to sign in again.", response.status);
  }
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new ApiError(body.error || `Request failed (${response.status}). Try again.`, response.status);
  return body;
}
export async function rerunSavedFrame(item: Pick<DetectedItem, "thumbnailUrl">, signal: AbortSignal): Promise<AnalysisResponse> {
  const imageResponse = await fetch(item.thumbnailUrl, { signal });
  if (!imageResponse.ok) await readApiResponse(imageResponse);
  if (!imageResponse.headers.get("content-type")?.startsWith("image/")) {
    throw new ApiError("Your sign-in may have expired. Reload the app to sign in again.", imageResponse.status);
  }
  const image = await imageResponse.blob();
  const sessionId = crypto.randomUUID();
  await readApiResponse(await fetch("/api/sessions", {
    method: "POST", signal, headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: sessionId, sourceType: "image", sourceName: "Re-run saved frame" }),
  }));
  const form = new FormData();
  form.set("sessionId", sessionId);
  form.set("capturedAt", new Date().toISOString());
  form.set("findCriteria", "");
  form.set("freshResearch", "true");
  form.set("image", image, image.type === "image/webp" ? "frame.webp" : "frame.jpg");
  return readApiResponse<AnalysisResponse>(await fetch("/api/analyze", { method: "POST", body: form, signal }));
}
