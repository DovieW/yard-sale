import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setTracingDisabled } from "@openai/agents";
import { analyzeFrame } from "./agent";
import { MAX_WEB_SEARCH_CALLS } from "./search-budget";

const candidate = {
  fingerprint: "sculptural armchair", name: "Sculptural armchair", category: "chair",
  brand: null, model: null, description: "Curved translucent chair with open arms.",
};
const finalOutput = { summary: "The chair needs a maker's mark to confirm its identity.", emptyReason: "unclear", items: [] };

function response(output: unknown[], id: string) {
  return Response.json({
    id, object: "response", created_at: 0, model: "gpt-6-luna", status: "completed",
    output, usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
  });
}

function searchCalls(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `ws-${index}`, type: "web_search_call", status: "completed",
    action: { type: "search", query: "sculptural chair manufacturer" },
    results: [{ type: "image_result", image_url: "https://example.com/chair.jpg", source_website_url: "https://example.com/chair", caption: "Product reference" }],
  }));
}

function completedMessage() {
  return { id: "message", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify(finalOutput), annotations: [] }] };
}

describe("agent Responses API integration", () => {
  const requests: Array<Record<string, any>> = [];
  let searchesInFirstResponse = 1;
  let history: unknown[] = [];
  let skippedSearch = false;

  beforeEach(() => {
    setTracingDisabled(true);
    requests.length = 0;
    searchesInFirstResponse = 1;
    history = [];
    skippedSearch = false;
    vi.stubGlobal("fetch", vi.fn(async (_input, init: RequestInit) => {
      requests.push(JSON.parse(init.body as string));
      return requests.length % 2 === 1
        ? response([
          ...searchCalls(searchesInFirstResponse),
          ...(skippedSearch ? [{ id: "skipped-search", type: "web_search_call", status: "searching", action: { type: "search", query: "not executed" }, results: null }] : []),
          { id: "lookup", type: "function_call", call_id: "history-call", name: "check_previous_scans", arguments: JSON.stringify({ candidates: [candidate] }), status: "completed" },
        ], `response-${requests.length}`)
        : response([completedMessage()], `response-${requests.length}`);
    }));
  });

  afterEach(() => { vi.unstubAllGlobals(); setTracingDisabled(false); });

  function analyze(freshResearch = false) {
    const database = { select: () => ({ from: () => ({ orderBy: () => ({ limit: async () => history }) }) }) };
    return analyzeFrame({
      apiKey: "test-key", model: "gpt-6-luna", imageDataUrl: "data:image/jpeg;base64,AAAA",
      db: database as unknown as Parameters<typeof analyzeFrame>[0]["db"], sessionId: "test-session", findCriteria: "", freshResearch,
    });
  }

  it("sends high reasoning, high search context, image results, and source includes through the real SDK", async () => {
    const result = await analyze();
    expect(result.analysis).toEqual(finalOutput);
    expect(result.searchesPerformed).toBe(1);
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.model).toBe("gpt-6-luna");
      expect(request.reasoning.effort).toBe("high");
      expect(request.service_tier).toBe("priority");
      expect(request.include).toEqual(expect.arrayContaining(["web_search_call.results", "web_search_call.action.sources"]));
      expect(request.tools.find((tool: { type: string }) => tool.type === "web_search")).toMatchObject({
        search_context_size: "high", search_content_types: ["text", "image"],
        image_settings: { max_results: 3, caption: true }, external_web_access: true,
      });
    }
    expect(requests.map((request) => request.max_tool_calls)).toEqual([MAX_WEB_SEARCH_CALLS, MAX_WEB_SEARCH_CALLS - 1]);
    const search = result.audit.events.find((event) => event.title === "Web search");
    expect(JSON.stringify(search)).toContain("image_result");
    expect(JSON.stringify(result.audit)).not.toContain("test-key");
  });

  it("removes hosted search after the total allowance is consumed, while allowing history and the final answer", async () => {
    searchesInFirstResponse = MAX_WEB_SEARCH_CALLS;
    skippedSearch = true;
    const result = await analyze();
    expect(result.searchesPerformed).toBe(MAX_WEB_SEARCH_CALLS);
    expect(requests[0].max_tool_calls).toBe(MAX_WEB_SEARCH_CALLS);
    expect(requests[1].tools.some((tool: { type: string }) => tool.type === "web_search")).toBe(false);
    expect(requests[1].tools.some((tool: { name?: string }) => tool.name === "check_previous_scans")).toBe(true);
    expect(result.analysis).toEqual(finalOutput);
    await analyze();
    expect(requests[2].max_tool_calls).toBe(MAX_WEB_SEARCH_CALLS);
    expect(requests[2].tools.some((tool: { type: string }) => tool.type === "web_search")).toBe(true);
  });

  it("keeps old physical-item matches while withholding unresolved prices from the model's context", async () => {
    history = [
      { ...candidate, id: "unresolved-chair", scanSessionId: "test-session", lastSeenAt: "2026-10-12", seenCount: 2, retailPriceCents: 18478, estimatedLowCents: 6000, estimatedHighCents: 14000, valueSummary: "Old unsupported cheap-chair estimate" },
      { ...candidate, id: "resolved-chair", brand: "Named maker", model: "Named product", scanSessionId: "test-session", lastSeenAt: "2026-10-12", seenCount: 1, retailPriceCents: 70000, estimatedLowCents: 20000, estimatedHighCents: 40000, valueSummary: "Product-specific valuation" },
    ];
    await analyze();
    const toolResult = requests[1].input.find((item: { type: string }) => item.type === "function_call_output");
    const context = JSON.parse(toolResult.output);
    expect(context.recentCandidates[0]).toMatchObject({ id: "unresolved-chair", name: candidate.name, valuationReusable: false, retailPriceCents: null, estimatedLowCents: null, estimatedHighCents: null });
    expect(context.recentCandidates[1]).toMatchObject({ id: "resolved-chair", valuationReusable: true, retailPriceCents: 70000 });
    expect(toolResult.output).not.toContain("Old unsupported cheap-chair estimate");
  });

  it("requests fresh research for a new job even when the saved product already has a model and valuation", async () => {
    history = [{ ...candidate, id: "resolved-chair", brand: "Named maker", model: "Named product", retailPriceCents: 70000, valueSummary: "Earlier valuation" }];
    await analyze(true);
    expect(requests[0].input[0].content[0].text).toContain("new analysis job requested for a saved image");
    const toolResult = requests[1].input.find((item: { type: string }) => item.type === "function_call_output");
    expect(JSON.parse(toolResult.output).recentCandidates[0]).toMatchObject({ id: "resolved-chair", brand: "Named maker", valuationReusable: false, retailPriceCents: null });
    expect(toolResult.output).not.toContain("Earlier valuation");
  });
});
