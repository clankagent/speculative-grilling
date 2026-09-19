import { expect, test, vi } from "vite-plus/test";
import { PiReasoningProvider } from "../src/providers.js";
import { GrillService } from "../src/storage.js";

test("the actual reasoning SDK requests OpenRouter JSON mode and reports provider usage", async () => {
  const service = new GrillService(":memory:");
  try {
    const access = service.start("Synthetic wire test");
    let request: Record<string, unknown> = {};
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      request = JSON.parse(
        init?.body ? String(init.body) : _url instanceof Request ? await _url.text() : "{}",
      );
      const chunk = {
        id: "synthetic",
        object: "chat.completion.chunk",
        created: 1,
        model: "anthropic/claude-haiku-4.5",
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              content: JSON.stringify({ summary: "No more decisions", decisions: [] }),
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const provider = new PiReasoningProvider(
      "openrouter",
      "anthropic/claude-haiku-4.5",
      "synthetic-key",
      3000,
      fetcher,
    );
    const output = await provider.expand(
      service.read(access),
      "root",
      new AbortController().signal,
    );
    expect(request["response_format"]).toEqual({ type: "json_object" });
    expect(output.decisions).toEqual([]);
    expect(output.usage?.inputTokens).toBe(100);
    expect(output.usage?.outputTokens).toBe(20);
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally {
    service.close();
  }
});
