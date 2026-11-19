import { expect, test } from "bun:test"
import { createVibeAcpCatalog, createVibeAcpFetch, VibeAcpBridgePlugin } from "../vibe-acp-bridge.mjs"

const model = "mistral-large-4-0"
const otherModels = [
  "mistral-medium-3.5",
  "zai-glm-5-3",
  "zai-glm-5-3-flash",
  "deepseek-v4-1-flash-1017",
]
const endpoint = "http://localhost/v1/chat/completions"
const messages = [{ role: "user", content: "Find the marker." }]
const send = (fetch, body, signal) => fetch(endpoint, {
  body: JSON.stringify({ model, messages, stream: true, ...body }),
  signal,
})

function events(text) {
  return text.split("\n\n").filter((part) => part.startsWith("data: ") && part !== "data: [DONE]")
    .map((part) => JSON.parse(part.slice(6)))
}

test("ACP provider registers the verified models with tools and local Vibe sign-in", async () => {
  const hooks = await VibeAcpBridgePlugin()
  const config = {}
  hooks.config(config)
  const id = hooks.auth.provider
  expect(id).toBe("mistral-vibe-acp")
  const models = await hooks.provider.models()
  expect(Object.keys(models)).toEqual([model, ...otherModels])
  for (const entry of Object.values(models)) expect(entry.tool_call).toBe(true)
  const getAuth = async () => ({ key: "local-vibe" })
  const { fetch } = await hooks.auth.loader(getAuth)
  expect(fetch).toBeFunction()
  const another = await VibeAcpBridgePlugin()
  expect((await another.auth.loader(getAuth)).fetch).toBe(fetch)
})

test.each(otherModels)("ACP uses the selected model %s", async (selected) => {
  const bridge = createVibeAcpFetch(async ({ model, onText }) => {
    expect(model.id).toBe(selected)
    return {
      async prompt() {
        onText("model reply")
        return { stopReason: "end_turn" }
      },
      close() {},
    }
  })
  const response = await send(bridge, { model: selected })
  const chunks = events(await response.text())
  expect(chunks.every((chunk) => chunk.model === selected)).toBe(true)
  expect((await send(bridge, { model: "unavailable" })).status).toBe(400)
})

test("ACP catalog includes all active chat IDs and excludes archived and non-chat cards", async () => {
  const rows = [
    { id: "codestral-latest", capabilities: { completion_chat: true } },
    { id: "codestral-versioned", capabilities: { completion_chat: true } },
    { id: "retired", archived: true, capabilities: { completion_chat: true } },
    { id: "audio-only", capabilities: { completion_chat: false } },
    { id: "no-capabilities" },
  ]
  let loads = 0
  const catalog = createVibeAcpCatalog(async () => {
    loads++
    return rows
  }, async (chat) => Object.fromEntries(chat.map(({ id }) => [
    id, { name: "Codestral", limit: { context: 256_000, output: 32_000 }, tool_call: true },
  ])))
  const [models, same] = await Promise.all([catalog.list(), catalog.list()])
  expect(loads).toBe(1)
  expect(models).toEqual(same)
  expect(Object.keys(models)).toEqual(["codestral-latest", "codestral-versioned"])
  expect(models["codestral-latest"].name).toContain("codestral-latest")
  expect(await catalog.find("retired")).toBeUndefined()
  const bridge = createVibeAcpFetch(async ({ model, onText }) => {
    expect(model.id).toBe("codestral-versioned")
    expect(model.explicit).toBe(true)
    return {
      async prompt() {
        onText("discovered model")
        return { stopReason: "end_turn" }
      },
      close() {},
    }
  }, catalog.find)
  expect(await (await send(bridge, { model: "codestral-versioned" })).text()).toContain("discovered model")
})

test("ACP catalog keeps verified presets when discovery is unavailable", async () => {
  const catalog = createVibeAcpCatalog(async () => { throw new Error("offline") })
  expect(Object.keys(await catalog.list())).toEqual([model, ...otherModels])
})

test("tool finish pauses the HTTP response while the original ACP turn stays active", async () => {
  let opened = 0
  let prompts = 0
  let closed = 0
  const bridge = createVibeAcpFetch(async ({ onText, onTool, tools }) => {
    opened++
    expect(tools[0].name).toBe("marker")
    return {
      async prompt(text) {
        prompts++
        expect(text).toContain("Find the marker.")
        onText("Looking.")
        const result = await onTool("marker", { input: "fixture" })
        onText("Found ")
        onText(result)
        return { stopReason: "end_turn" }
      },
      close() { closed++ },
    }
  })

  const tools = [{ type: "function", function: { name: "marker", parameters: { type: "object" } } }]
  const firstSignal = new AbortController()
  const first = await send(bridge, { tools }, firstSignal.signal)
  expect(first.headers.get("content-type")).toContain("text/event-stream")
  const chunks = events(await first.text()).map((chunk) => chunk.choices[0])
  expect(chunks.map((c) => c.delta.content ?? "").join("")).toBe("Looking.")
  expect(chunks.at(-1).finish_reason).toBe("tool_calls")
  firstSignal.abort()
  expect(closed).toBe(0)
  const toolCall = chunks.find((c) => c.delta.tool_calls).delta.tool_calls[0]
  expect(toolCall.id).toMatch(/^[A-Za-z0-9]{9}$/)
  expect(toolCall.function.name).toBe("marker")
  expect(JSON.parse(toolCall.function.arguments)).toEqual({ input: "fixture" })

  const continued = [...messages, { role: "assistant", tool_calls: [toolCall] }, {
    role: "tool", tool_call_id: toolCall.id, content: "unique-result",
  }]
  const disconnected = new AbortController()
  const interrupted = new Request(endpoint, { method: "POST", signal: disconnected.signal })
  interrupted.text = async () => {
    disconnected.abort()
    return JSON.stringify({ model, messages: continued, stream: true })
  }
  expect((await bridge(interrupted)).status).toBe(499)
  expect((await send(bridge, { model: otherModels[0], messages: continued, tools })).status).toBe(409)

  const second = await send(bridge, { messages: continued, tools })
  const reply = events(await second.text()).map((chunk) => chunk.choices[0])
  expect(reply.map((c) => c.delta.content).filter(Boolean)).toEqual(["Found ", "unique-result"])
  expect(reply.at(-1).finish_reason).toBe("stop")
  expect([opened, prompts, closed]).toEqual([1, 1, 1])
  expect((await send(bridge, { messages: continued, tools })).status).toBe(409)
})

test("aborting a response closes the in-flight ACP session", async () => {
  const abort = new AbortController()
  let started
  let finish
  let closed = 0
  const ready = new Promise((resolve) => { started = resolve })
  const bridge = createVibeAcpFetch(async () => ({
    prompt() {
      started()
      return new Promise((resolve) => { finish = resolve })
    },
    close() {
      closed++
      finish({ stopReason: "cancelled" })
    },
  }))
  const response = await send(bridge, {}, abort.signal)
  await ready
  abort.abort()
  await response.text()
  expect(closed).toBe(1)
})
