import test from "node:test";
import assert from "node:assert/strict";

import {
  echoModelInObject,
  echoModelInSseLine,
  createModelEchoTransform,
  cloneResponseWithModel,
  cloneLoggedResponseWithModel,
  clonePipelineClientStreamChunks,
} from "../../open-sse/services/responseModelEcho.ts";

// #1311: echo the requested alias/combo name back in the response model field so strict
// clients (Claude Desktop) that validate response.model === request.model stop 401-ing.

test("echoModelInObject rewrites a string model field", () => {
  const obj = { id: "x", model: "gpt-5.5", choices: [] };
  echoModelInObject(obj, "claude-sonnet-cx");
  assert.equal(obj.model, "claude-sonnet-cx");
});

test("echoModelInObject is a no-op when echoModel is falsy or model is absent", () => {
  const a = { model: "gpt-5.5" };
  echoModelInObject(a, null);
  assert.equal(a.model, "gpt-5.5");
  const b = { id: "x" } as Record<string, unknown>;
  echoModelInObject(b, "alias");
  assert.equal(b.model, undefined);
});

test("echoModelInSseLine rewrites a data chunk and leaves [DONE]/comments alone", () => {
  assert.equal(
    echoModelInSseLine('data: {"id":"1","model":"gpt-5.5","choices":[]}', "claude-sonnet-cx"),
    'data: {"id":"1","model":"claude-sonnet-cx","choices":[]}'
  );
  assert.equal(echoModelInSseLine("data: [DONE]", "claude-sonnet-cx"), "data: [DONE]");
  assert.equal(echoModelInSseLine(": keep-alive", "claude-sonnet-cx"), ": keep-alive");
  assert.equal(echoModelInSseLine("", "claude-sonnet-cx"), "");
});

test("createModelEchoTransform rewrites model across a streamed SSE response", async () => {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const input = new ReadableStream({
    start(controller) {
      // split a frame across two chunks to exercise the cross-boundary buffer
      controller.enqueue(enc.encode('data: {"id":"1","model":"gpt-'));
      controller.enqueue(enc.encode('5.5","choices":[{"delta":{"content":"hi"}}]}\n\n'));
      controller.enqueue(enc.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  const out = input.pipeThrough(createModelEchoTransform("claude-sonnet-cx"));
  let text = "";
  for await (const chunk of out as unknown as AsyncIterable<Uint8Array>) {
    text += dec.decode(chunk, { stream: true });
  }
  assert.ok(text.includes('"model":"claude-sonnet-cx"'), text);
  assert.ok(!text.includes("gpt-5.5"), "upstream model name must be gone");
  assert.ok(text.includes("data: [DONE]"), "DONE sentinel preserved");
  assert.ok(text.includes('"content":"hi"'), "content preserved");
});

test("createModelEchoTransform with no echoModel passes bytes through unchanged", async () => {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const input = new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode('data: {"model":"gpt-5.5"}\n\n'));
      controller.close();
    },
  });
  const out = input.pipeThrough(createModelEchoTransform(null));
  let text = "";
  for await (const chunk of out as unknown as AsyncIterable<Uint8Array>) {
    text += dec.decode(chunk, { stream: true });
  }
  assert.ok(text.includes('"model":"gpt-5.5"'));
});

test("model presentation copies cache containers and preserves exact requested spelling", () => {
  const cached = {
    model: "gemini-flash-lite-latest",
    response: { model: "gemini-flash-lite-latest", output: [] },
    choices: [],
  };
  const first = cloneResponseWithModel(cached, "Gemini/Gemini-2.5-Pro");
  const second = cloneResponseWithModel(cached, "another-alias");
  assert.notEqual(first, cached);
  assert.notEqual(first.response, cached.response);
  assert.equal(first.choices, cached.choices, "unmodified payloads need not be deep cloned");
  assert.equal(first.model, "Gemini/Gemini-2.5-Pro");
  assert.equal(first.response.model, "Gemini/Gemini-2.5-Pro");
  assert.equal(second.model, "another-alias");
  assert.equal(cached.model, "gemini-flash-lite-latest");
  assert.equal(cached.response.model, "gemini-flash-lite-latest");
});

test("Anthropic message_start model is echoed without changing unrelated message models", () => {
  const source = { type: "message_start", message: { model: "upstream", content: [] } };
  const copy = cloneResponseWithModel(source, "original-name");
  assert.equal(copy.message.model, "original-name");
  assert.equal(source.message.model, "upstream");
  assert.notEqual(copy.message, source.message);
  const unrelated = { type: "tool_result", message: { model: "tool-data" } };
  echoModelInObject(unrelated, "original-name");
  assert.equal(unrelated.message.model, "tool-data");
});

test("SSE echo handles Anthropic and Responses events split inside UTF-8 data", async () => {
  const raw = [
    "event: message_start\r\n",
    'data: {"type":"message_start","message":{"model":"upstream","content":"中文"}}\r\n\r\n',
    'data: {"type":"response.completed","response":{"model":"upstream"}}\n\n',
    'data: {"type":"tool_result","message":{"model":"tool-data"}}\n\n',
    "data: [DONE]\n\n",
  ].join("");
  const bytes = new TextEncoder().encode(raw);
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let index = 0; index < bytes.length; index += 7) {
        controller.enqueue(bytes.slice(index, index + 7));
      }
      controller.close();
    },
  });
  const text = await new Response(input.pipeThrough(createModelEchoTransform("Gemini/Pro"))).text();
  assert.ok(text.includes('"message":{"model":"Gemini/Pro","content":"中文"}'));
  assert.ok(text.includes('"response":{"model":"Gemini/Pro"}'));
  assert.ok(text.includes('"message":{"model":"tool-data"}'));
  assert.ok(text.includes("event: message_start\r\n"));
  assert.ok(text.includes("data: [DONE]"));
});

test("stream logs present the echoed summary and protocol events without mutating captured payloads", () => {
  const source = {
    _streamed: true,
    summary: { model: "upstream", choices: [] },
    events: [
      { event: "chunk", data: { model: "upstream", choices: [] } },
      {
        event: "response.completed",
        data: { type: "response.completed", response: { model: "upstream" } },
      },
      { event: "message_start", data: { type: "message_start", message: { model: "upstream" } } },
      {
        event: "tool_result",
        data: { type: "tool_result", message: { model: "tool-data" }, content: "model=upstream" },
      },
      { event: "done", data: "[DONE]" },
    ],
  };
  const presented = cloneLoggedResponseWithModel(source, "Gemini/Pro");
  const eventData = (payload: unknown) =>
    payload as {
      model?: string;
      response?: { model: string };
      message?: { model: string };
      content?: string;
    };
  assert.notEqual(presented, source);
  assert.equal(presented.summary.model, "Gemini/Pro");
  assert.equal(eventData(presented.events[0].data).model, "Gemini/Pro");
  assert.equal(eventData(presented.events[1].data).response?.model, "Gemini/Pro");
  assert.equal(eventData(presented.events[2].data).message?.model, "Gemini/Pro");
  assert.equal(eventData(presented.events[3].data).message?.model, "tool-data");
  assert.equal(eventData(presented.events[3].data).content, "model=upstream");
  assert.equal(presented.events[4].data, "[DONE]");
  assert.equal(source.summary.model, "upstream");
  assert.equal(eventData(source.events[0].data).model, "upstream");
  assert.equal(eventData(source.events[1].data).response?.model, "upstream");
  assert.equal(eventData(source.events[2].data).message?.model, "upstream");
});

test("log presentation does not reinterpret tool payload summary/events as protocol envelopes", () => {
  const toolData = {
    model: "upstream",
    summary: { model: "tool-summary" },
    events: [{ data: { model: "tool-event" } }],
  };
  const presented = cloneLoggedResponseWithModel(toolData, "client");
  assert.equal(presented.model, "client");
  assert.equal(presented.summary.model, "tool-summary");
  assert.equal(presented.events[0].data.model, "tool-event");
  assert.equal(toolData.model, "upstream");
});

test("pipeline log echo rewrites fragmented timestamped client SSE only", () => {
  const source = {
    streamChunks: {
      provider: ['data: {"model":"upstream"}\n\n'],
      openai: ['data: {"model":"upstream"}\n\n'],
      client: [
        ": keepalive\n\n",
        '[12:01:02.001] event: message_start\r\ndata: {"type":"message_start","message":{"model":"up',
        '[12:01:02.002] stream","content":"中文"}}\r\n\r\ndata: {"response":{"model":"upstream"}}\n\n',
        '[12:01:02.003] data: {"type":"tool_result","message":{"model":"tool-data"}}\n\ndata: [DONE]\n\n',
      ],
    },
    providerResponse: { model: "upstream" },
  };
  const original = structuredClone(source);
  const copy = clonePipelineClientStreamChunks(source, "Gemini/Pro");
  assert.notEqual(copy, source);
  assert.notEqual(copy.streamChunks, source.streamChunks);
  assert.equal(copy.streamChunks.provider, source.streamChunks.provider);
  assert.equal(copy.streamChunks.openai, source.streamChunks.openai);
  assert.equal(copy.providerResponse, source.providerResponse);
  assert.equal(copy.streamChunks.client.length, source.streamChunks.client.length);
  assert.ok(copy.streamChunks.client[1].startsWith("[12:01:02.001] "));
  assert.ok(copy.streamChunks.client[2].startsWith("[12:01:02.002] "));
  assert.ok(copy.streamChunks.client[3].startsWith("[12:01:02.003] "));
  const text = copy.streamChunks.client
    .map((chunk) => chunk.replace(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\] /, ""))
    .join("");
  assert.ok(text.includes('"message":{"model":"Gemini/Pro","content":"中文"}'));
  assert.ok(text.includes('"response":{"model":"Gemini/Pro"}'));
  assert.ok(text.includes('"message":{"model":"tool-data"}'));
  assert.ok(text.includes("data: [DONE]"));
  assert.deepEqual(source, original);
});

test("pipeline log echo is a strict no-op when disabled or no protocol model was captured", () => {
  const source = { streamChunks: { client: ["[12:01:02.001] : keepalive\n\n"] } };
  assert.equal(clonePipelineClientStreamChunks(source, null), source);
  assert.equal(clonePipelineClientStreamChunks(source, "client"), source);
  assert.equal(
    clonePipelineClientStreamChunks({ routeDecision: "safe" }, "client").routeDecision,
    "safe"
  );
});
