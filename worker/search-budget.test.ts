import { describe, expect, it, vi } from "vitest";
import { Usage, type Model, type ModelRequest } from "@openai/agents";
import { MAX_WEB_SEARCH_CALLS, withWebSearchBudget } from "./search-budget";

describe("streamed hosted search budget", () => {
  it("counts completed streamed actions and keeps the allowance scoped to each frame", async () => {
    const request: ModelRequest = {
      input: "Identify this object", modelSettings: { providerData: { service_tier: "priority" } },
      tools: [{ type: "hosted_tool", name: "web_search", providerData: { type: "web_search" } }],
      handoffs: [], tracing: false, outputType: "text",
    };
    const output = Array.from({ length: MAX_WEB_SEARCH_CALLS }, (_, index) => ({
      id: `ws-${index}`, type: "hosted_tool_call" as const, name: "web_search_call", status: "completed" as const,
    }));
    const base: Model = {
      getResponse: vi.fn(async () => ({ output: [], usage: new Usage() })),
      getStreamedResponse: vi.fn(async function* () {
        yield { type: "response_done" as const, response: { id: "response", output, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } } };
      }),
    };
    const frame = withWebSearchBudget(base);
    for await (const event of frame.getStreamedResponse(request)) expect(event.type).toBe("response_done");
    await frame.getResponse(request);
    expect(base.getResponse).toHaveBeenLastCalledWith(expect.objectContaining({ tools: [] }));
    await withWebSearchBudget(base).getResponse(request);
    expect(base.getResponse).toHaveBeenLastCalledWith(expect.objectContaining({
      tools: request.tools, modelSettings: { providerData: { service_tier: "priority", max_tool_calls: MAX_WEB_SEARCH_CALLS } },
    }));
  });
});
