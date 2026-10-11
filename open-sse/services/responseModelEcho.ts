/**
 * #1311: echo the client-requested model/alias name back in the response.
 *
 * When a request uses an alias or combo (e.g. `claude-sonnet-cx` → `cx/gpt-5.5`),
 * OmniRoute forwards the upstream model name (`gpt-5.5`) in the response `model`
 * field. Strict clients (e.g. Claude Desktop) validate that the response model
 * matches the request and reject the mismatch with a 401. This opt-in helper
 * rewrites the `model` field back to the name the client asked for.
 *
 * The behavior is gated by a global setting (`echoRequestedModelName`, default off),
 * so the default response stays byte-for-byte unchanged.
 */

/**
 * Rewrite the top-level `model` field of a parsed response object (Chat Completions
 * JSON or an OpenAI SSE chunk) to `echoModel`. Mutates and returns `obj`. No-op when
 * `echoModel` is falsy or `obj` has no string `model` field.
 *
 * #3697: the Responses API nests `model` one level down — `{ type: "response.completed",
 * response: { model, ... } }` — so also rewrite `obj.response.model` when present. This is
 * what lets the Codex CLI compatibility shim echo the requested effort-suffixed model id
 * (e.g. `gpt-5.5-xhigh`) in `response.created`/`response.completed` payloads.
 */
export function echoModelInObject(obj: unknown, echoModel: string | null | undefined): unknown {
  if (!echoModel) return obj;
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    const rec = obj as Record<string, unknown>;
    if (typeof rec.model === "string") {
      rec.model = echoModel;
    }
    const nested = rec.response;
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const nestedRec = nested as Record<string, unknown>;
      if (typeof nestedRec.model === "string") {
        nestedRec.model = echoModel;
      }
    }
    // Only Anthropic's opening event carries a protocol model in message.model.
    // Tool data with an unrelated message.model must remain untouched.
    const message = rec.message;
    if (
      rec.type === "message_start" &&
      message &&
      typeof message === "object" &&
      !Array.isArray(message)
    ) {
      const messageRec = message as Record<string, unknown>;
      if (typeof messageRec.model === "string") messageRec.model = echoModel;
    }
  }
  return obj;
}

/**
 * Copy response containers before a presentation rewrite, keeping canonical
 * cache responses untouched. Completion payloads need not be deep cloned.
 */
export function cloneResponseWithModel<T>(obj: T, model: string | null | undefined): T {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return obj;
  const source = obj as Record<string, unknown>;
  const copy = { ...source };
  const response = source.response;
  if (
    response &&
    typeof response === "object" &&
    !Array.isArray(response) &&
    typeof (response as Record<string, unknown>).model === "string"
  ) {
    copy.response = { ...response };
  }
  const message = source.message;
  if (
    source.type === "message_start" &&
    message &&
    typeof message === "object" &&
    !Array.isArray(message) &&
    typeof (message as Record<string, unknown>).model === "string"
  ) {
    copy.message = { ...message };
  }
  echoModelInObject(copy, model);
  return copy as T;
}

/** Present structured stream-log summaries and captured protocol events on copies. */
export function cloneLoggedResponseWithModel<T>(payload: T, model: string | null | undefined): T {
  const copy = cloneResponseWithModel(payload, model);
  if (!copy || typeof copy !== "object" || Array.isArray(copy)) return copy;
  const record = copy as Record<string, unknown>;
  // Summary/events also occur in tool data. Only our structured stream envelope
  // owns protocol events at these paths; never recurse through arbitrary payloads.
  if (record._streamed !== true) return copy;
  if (Object.hasOwn(record, "summary")) {
    record.summary = cloneResponseWithModel(record.summary, model);
  }
  if (Array.isArray(record.events)) {
    record.events = record.events.map((event: unknown) => {
      if (!event || typeof event !== "object" || Array.isArray(event)) return event;
      const eventRecord = event as Record<string, unknown>;
      if (!Object.hasOwn(eventRecord, "data")) return event;
      return { ...eventRecord, data: cloneResponseWithModel(eventRecord.data, model) };
    });
  }
  return copy;
}

/**
 * Present captured client SSE fragments after the final echo transform. Logger
 * timestamps are metadata, so strip them before joining cross-fragment JSON,
 * then retain each timestamp and adapt the original fragment boundaries. Only
 * the client chunk array is copied; upstream captures remain unchanged.
 */
export function clonePipelineClientStreamChunks<T>(
  payloads: T,
  model: string | null | undefined
): T {
  if (!model || !payloads || typeof payloads !== "object" || Array.isArray(payloads))
    return payloads;
  const record = payloads as Record<string, unknown>;
  const streams = record.streamChunks;
  if (!streams || typeof streams !== "object" || Array.isArray(streams)) return payloads;
  const streamRecord = streams as Record<string, unknown>;
  const client = streamRecord.client;
  if (!Array.isArray(client) || !client.every((chunk) => typeof chunk === "string"))
    return payloads;

  const fragments = client.map((chunk: string) => {
    const prefix = /^\[\d{2}:\d{2}:\d{2}\.\d{3}\] /.exec(chunk)?.[0] ?? "";
    return { prefix, payload: chunk.slice(prefix.length) };
  });
  const combined = fragments.map((fragment) => fragment.payload).join("");
  const rewritten = combined
    .split("\n")
    .map((line) => echoModelInSseLine(line, model))
    .join("\n");
  if (rewritten === combined) return payloads;

  let offset = 0;
  const presentedChunks = fragments.map((fragment, index) => {
    const end =
      index === fragments.length - 1 ? rewritten.length : offset + fragment.payload.length;
    const presented = fragment.prefix + rewritten.slice(offset, end);
    offset = end;
    return presented;
  });
  return { ...record, streamChunks: { ...streamRecord, client: presentedChunks } } as T;
}

/**
 * Rewrite the `model` field inside a single SSE line. Only `data: {json}` lines that
 * carry a string `model` are rewritten; `data: [DONE]`, comments, event lines, and
 * unparseable payloads pass through untouched.
 */
export function echoModelInSseLine(line: string, echoModel: string | null | undefined): string {
  if (!echoModel) return line;
  if (!line.startsWith("data:")) return line;
  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]" || payload[0] !== "{") return line;
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    let changed = typeof parsed.model === "string";
    // #3697: Responses API events nest `model` under `response.model` — see
    // echoModelInObject for the shape.
    const nested = parsed.response;
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const nestedRec = nested as Record<string, unknown>;
      if (typeof nestedRec.model === "string") {
        changed = true;
      }
    }
    const message = parsed.message;
    if (
      parsed.type === "message_start" &&
      message &&
      typeof message === "object" &&
      !Array.isArray(message) &&
      typeof (message as Record<string, unknown>).model === "string"
    ) {
      changed = true;
    }
    if (!changed) return line;
    echoModelInObject(parsed, echoModel);
    return `data: ${JSON.stringify(parsed)}${line.endsWith("\r") ? "\r" : ""}`;
  } catch {
    return line;
  }
}

/**
 * A TransformStream that rewrites the `model` field in every SSE `data:` chunk of a
 * UTF-8 byte stream to `echoModel`. Buffers across chunk boundaries so a `data:` frame
 * split across two reads is still rewritten correctly. Used as the final pipe stage of
 * the streaming response when the echo setting is on.
 */
export function createModelEchoTransform(echoModel: string | null | undefined): TransformStream {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      // Emit complete lines; keep the trailing partial line in the buffer.
      const lastNewline = buffer.lastIndexOf("\n");
      if (lastNewline === -1) return;
      const ready = buffer.slice(0, lastNewline + 1);
      buffer = buffer.slice(lastNewline + 1);
      const rewritten = ready
        .split("\n")
        .map((line) => echoModelInSseLine(line, echoModel))
        .join("\n");
      controller.enqueue(encoder.encode(rewritten));
    },
    flush(controller) {
      const tail = buffer + decoder.decode();
      if (tail) controller.enqueue(encoder.encode(echoModelInSseLine(tail, echoModel)));
    },
  });
}
