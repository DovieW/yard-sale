import type { Model, ModelRequest } from "@openai/agents";

export const MAX_WEB_SEARCH_CALLS = 8;

export function isExecutedWebSearchCall(item: { type?: string; name?: string; status?: string }): boolean {
  return item.type === "hosted_tool_call" && Boolean(item.name?.startsWith("web_search"))
    && (item.status === "completed" || item.status === "failed");
}

// Hosted search can make several calls inside one model response. Keep the
// allowance cumulative across the existing agent run, rather than per turn.
export function withWebSearchBudget(model: Model): Model {
  let used = 0;
  const prepare = (request: ModelRequest): ModelRequest => {
    const remaining = Math.max(0, MAX_WEB_SEARCH_CALLS - used);
    return {
      ...request,
      tools: remaining > 0 ? request.tools : request.tools.filter((tool) =>
        tool.type !== "hosted_tool" || !tool.name.startsWith("web_search")),
      modelSettings: {
        ...request.modelSettings,
        providerData: {
          ...request.modelSettings.providerData,
          max_tool_calls: remaining || undefined,
        },
      },
    };
  };
  const count = (output: Array<{ type?: string; name?: string; status?: string }>) => {
    used += output.filter(isExecutedWebSearchCall).length;
  };
  return {
    supportsPromptModelSelection: model.supportsPromptModelSelection,
    getRetryAdvice: model.getRetryAdvice?.bind(model),
    async getResponse(request) {
      const response = await model.getResponse(prepare(request));
      count(response.output);
      return response;
    },
    async *getStreamedResponse(request) {
      for await (const event of model.getStreamedResponse(prepare(request))) {
        if (event.type === "response_done") count(event.response.output);
        yield event;
      }
    },
  };
}
