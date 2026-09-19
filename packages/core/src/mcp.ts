import { z } from "zod";
import { type Json, request } from "./http";

const toolResponse = z.object({
  result: z
    .object({
      content: z.array(z.object({ text: z.string().optional() })).default([]),
      structuredContent: z.record(z.string(), z.unknown()).optional(),
      isError: z.boolean().optional(),
    })
    .optional(),
  error: z.object({ message: z.string() }).optional(),
});

export async function callMcp(
  url: string,
  name: string,
  args: Json,
  signal: AbortSignal,
  preferStructured: boolean,
): Promise<string> {
  const res = await request(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    signal,
  });
  const raw = await res.text();
  const json = res.headers.get("content-type")?.includes("text/event-stream")
    ? raw.split("\n").find((line) => line.startsWith("data: "))?.slice(6)
    : raw;
  if (!json) throw new Error(`${name}: empty MCP response`);
  const msg = toolResponse.parse(JSON.parse(json));
  const text = msg.result?.content.map((c) => c.text ?? "").join("\n") ?? "";
  if (msg.error || msg.result?.isError) throw new Error(`${name}: ${msg.error?.message ?? text.slice(0, 200)}`);
  if (preferStructured && msg.result?.structuredContent !== undefined) {
    return JSON.stringify(msg.result.structuredContent);
  }
  return text;
}
