import { afterEach, describe, expect, it, vi } from "vitest";
import { readApiResponse, rerunSavedFrame } from "./api";

describe("API responses", () => {
  it("explains an Access sign-in page instead of a JSON parsing error", async () => {
    await expect(readApiResponse(new Response("<html>Sign in</html>", { headers: { "content-type": "text/html" } }))).rejects.toThrow("sign-in may have expired");
  });
  it("keeps the usage-limit message and status", async () => {
    await expect(readApiResponse(Response.json({ error: "Image upload limit reached." }, { status: 429 }))).rejects.toMatchObject({ status: 429, message: "Image upload limit reached." });
  });
});

describe("new jobs from saved images", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("creates separate sessions and submits the unchanged original image for every new job", async () => {
    const originalBytes = new Uint8Array([255, 216, 255, 10, 20, 30]);
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      if (url.startsWith("/api/thumbnails/")) return new Response(originalBytes, { headers: { "content-type": "image/jpeg" } });
      if (url === "/api/sessions") return Response.json({ id: JSON.parse(init!.body as string).id }, { status: 201 });
      return Response.json({ frameId: crypto.randomUUID(), items: [] });
    }));
    const signal = new AbortController().signal;
    const first = await rerunSavedFrame({ thumbnailUrl: "/api/thumbnails/original.jpg" }, signal);
    const second = await rerunSavedFrame({ thumbnailUrl: "/api/thumbnails/original.jpg" }, signal);
    expect(first.frameId).not.toBe(second.frameId);
    const sessions = requests.filter((request) => request.url === "/api/sessions").map((request) => JSON.parse(request.init!.body as string));
    expect(sessions[0].id).not.toBe(sessions[1].id);
    expect(sessions[0]).toMatchObject({ sourceType: "image", sourceName: "Re-run saved frame" });
    const submissions = requests.filter((request) => request.url === "/api/analyze");
    for (const [index, request] of submissions.entries()) {
      const form = request.init!.body as FormData;
      expect(form.get("sessionId")).toBe(sessions[index].id);
      expect(form.get("freshResearch")).toBe("true");
      expect(form.get("findCriteria")).toBe("");
      const image = form.get("image") as File;
      expect(new Uint8Array(await image.arrayBuffer())).toEqual(originalBytes);
      expect(image.type).toBe("image/jpeg");
      expect(request.init!.signal).toBe(signal);
    }
    expect(requests.some((request) => request.init?.method === "DELETE" || request.init?.method === "PUT")).toBe(false);
  });

  it("does not create a job when the original image cannot be read", async () => {
    const fetcher = vi.fn(async () => Response.json({ error: "Image read limit reached." }, { status: 429 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(rerunSavedFrame({ thumbnailUrl: "/api/thumbnails/original.jpg" }, new AbortController().signal)).rejects.toMatchObject({ status: 429, message: "Image read limit reached." });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
