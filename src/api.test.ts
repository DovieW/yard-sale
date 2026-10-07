import { describe, expect, it } from "vitest";
import { readApiResponse } from "./api";

describe("API responses", () => {
  it("explains an Access sign-in page instead of a JSON parsing error", async () => {
    await expect(readApiResponse(new Response("<html>Sign in</html>", { headers: { "content-type": "text/html" } }))).rejects.toThrow("sign-in may have expired");
  });
  it("keeps the usage-limit message and status", async () => {
    await expect(readApiResponse(Response.json({ error: "Image upload limit reached." }, { status: 429 }))).rejects.toMatchObject({ status: 429, message: "Image upload limit reached." });
  });
});
