import http from "node:http";
import {
  createModels,
  createProvider,
  type Context,
  type Model,
  type Tool,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { afterEach, describe, expect, it } from "vitest";
import {
  WorkflowSubmissionToolParameters,
  WorkflowToolParameters,
} from "../src/workflows/tool-input.js";

const servers = new Set<http.Server>();

afterEach(async () => {
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
  servers.clear();
});

describe("workflow tool provider schema", () => {
  it("passes both schemas through Pi's OpenAI adapter to a strict endpoint", async () => {
    const receivedSchemas: unknown[] = [];
    const server = http.createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        tools?: { function?: { parameters?: unknown } }[];
      };
      const schemas = body.tools?.map((tool) => tool.function?.parameters) ?? [];
      receivedSchemas.push(...schemas);

      const invalid = schemas.find(
        (schema) => !isRecord(schema) || schema.type !== "object" || "anyOf" in schema,
      );
      if (invalid !== undefined) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              message: "Tool schema root must be a JSON Schema object.",
              type: "invalid_request_error",
            },
          }),
        );
        return;
      }

      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        [
          `data: ${JSON.stringify({
            id: "strict-schema-test",
            object: "chat.completion.chunk",
            created: 0,
            model: "strict-schema-test",
            choices: [{ index: 0, delta: { role: "assistant", content: "accepted" } }],
          })}`,
          `data: ${JSON.stringify({
            id: "strict-schema-test",
            object: "chat.completion.chunk",
            created: 0,
            model: "strict-schema-test",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })}`,
          "data: [DONE]",
          "",
        ].join("\n\n"),
      );
    });
    servers.add(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("Test server has no port.");
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;

    const model: Model<"openai-completions"> = {
      id: "strict-schema-test",
      name: "Strict schema test",
      api: "openai-completions",
      provider: "strict-local",
      baseUrl,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8_192,
      maxTokens: 64,
    };
    const provider = createProvider({
      id: "strict-local",
      name: "Strict local",
      baseUrl,
      auth: { apiKey: { name: "None", resolve: async () => ({ auth: {} }) } },
      models: [model],
      api: openAICompletionsApi(),
    });
    const models = createModels();
    models.setProvider(provider);
    const tools: Tool[] = [
      {
        name: "workflow",
        description: "Manage workflow runs.",
        parameters: WorkflowToolParameters,
      },
      {
        name: "workflow_submission",
        description: "Submit workflow step data.",
        parameters: WorkflowSubmissionToolParameters,
      },
    ];
    const context: Context = {
      messages: [{ role: "user", content: "Check the tool schemas.", timestamp: Date.now() }],
      tools,
    };

    const result = await models.complete(model, context, { apiKey: "local-test" });

    expect(result.stopReason).toBe("stop");
    expect(result.errorMessage).toBeUndefined();
    expect(receivedSchemas).toHaveLength(2);
    expect(receivedSchemas).toEqual([
      expect.objectContaining({ type: "object" }),
      expect.objectContaining({ type: "object" }),
    ]);
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
