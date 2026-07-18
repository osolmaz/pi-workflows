import http from "node:http";
import type { AddressInfo } from "node:net";

type ChatMessage = {
  role: string;
  content?: unknown;
  tool_calls?: unknown[];
};

type ChatRequest = {
  messages: ChatMessage[];
  stream?: boolean;
};

export type MockModelReply =
  | { kind: "text"; text: string }
  | { kind: "tool"; toolName: string; args: Record<string, unknown> };

export type MockModelScript = (request: {
  messages: ChatMessage[];
  lastUserText: string;
  lastRole: string;
}) => MockModelReply;

function messageText(message: ChatMessage | undefined): string {
  if (!message) {
    return "";
  }
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "object" && part !== null && "text" in part
          ? String((part as { text: unknown }).text)
          : "",
      )
      .join("\n");
  }
  return "";
}

function sseChunks(reply: MockModelReply): string[] {
  const id = `chatcmpl-mock-${Date.now()}`;
  const base = {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "mock-model",
  };
  const chunks: object[] = [];
  if (reply.kind === "tool") {
    chunks.push({
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: `call-${Date.now()}`,
                type: "function",
                function: { name: reply.toolName, arguments: JSON.stringify(reply.args) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    });
    chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
  } else {
    chunks.push({
      ...base,
      choices: [
        { index: 0, delta: { role: "assistant", content: reply.text }, finish_reason: null },
      ],
    });
    chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  }
  const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
  const lines = chunks.map(
    (chunk, index) =>
      `data: ${JSON.stringify(index === chunks.length - 1 ? { ...chunk, usage } : chunk)}\n\n`,
  );
  lines.push("data: [DONE]\n\n");
  return lines;
}

/**
 * Minimal OpenAI-compatible chat-completions server for non-destructive E2E
 * tests. The provided script decides, per request, whether the fake model
 * answers with text or calls a tool.
 */
export async function startMockOpenAiServer(script: MockModelScript): Promise<{
  baseUrl: string;
  requests: ChatRequest[];
  close: () => Promise<void>;
}> {
  const requests: ChatRequest[] = [];
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || !req.url?.includes("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      const parsed = JSON.parse(body) as ChatRequest;
      requests.push(parsed);
      const lastMessage = parsed.messages.at(-1);
      const lastUser = [...parsed.messages].reverse().find((message) => message.role === "user");
      const reply = script({
        messages: parsed.messages,
        lastUserText: messageText(lastUser),
        lastRole: lastMessage?.role ?? "",
      });
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      for (const chunk of sseChunks(reply)) {
        res.write(chunk);
      }
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
