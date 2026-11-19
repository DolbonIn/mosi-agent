import { afterAll, expect, test } from "bun:test";
import { startMockLlm } from "./mock-llm.ts";

const mock = startMockLlm();
afterAll(() => mock.stop());

/** a server that may take the port: null when it is refused */
function tryServe(o: { hostname?: string; port: number }): ReturnType<typeof Bun.serve> | null {
  try {
    return Bun.serve({ ...o, fetch: () => new Response("not found", { status: 404 }) });
  } catch {
    return null;
  }
}

test("the mock LLM keeps its port and its requests: another 127.0.0.1 server cannot take the port, a server on every address does not get them (a mock on every address lost them to a later 127.0.0.1 listener: 404 'not found', 11-19)", async () => {
  const port = Number(new URL(mock.url).port);
  const loopback = tryServe({ hostname: "127.0.0.1", port });
  const wide = tryServe({ port });
  try {
    mock.fallback = { text: ["mock"] };
    const res = await fetch(`${mock.url}/chat/completions`, { method: "POST", body: JSON.stringify({ model: "m", messages: [], stream: false }) });
    const body = await res.text();
    expect({ loopbackTook: !!loopback, status: res.status, body: body.includes('"content":"mock"') ? "mock" : body.slice(0, 40), requests: mock.requests.length }).toEqual({
      loopbackTook: false,
      status: 200,
      body: "mock",
      requests: 1,
    });
  } finally {
    loopback?.stop(true);
    wide?.stop(true);
  }
});
