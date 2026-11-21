const root = "http://127.0.0.1:3425"
const headers = { authorization: "Bearer magpie-vibe-acceptance", "content-type": "application/json" }
const model = "mistral-vibe-acp/mistral-large-4-0"

async function budget() {
  const response = await fetch(`${root}/v1/magpie/native/mistral/v1/billing/budget`, { headers })
  if (!response.ok) throw new Error(`budget ${response.status}`)
  const body = await response.json()
  const amount = (name) => body[name].usage_percentage * body[name].initial_budget / 100
  return { api: amount("api_budget"), vibe: amount("vibe_budget") }
}

async function complete(messages) {
  const response = await fetch(`${root}/v1/chat/completions`, {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(180000),
    body: JSON.stringify({
      model,
      stream: true,
      messages,
      tools: [{
        type: "function",
        function: {
          name: "marker",
          description: "Return the acceptance marker.",
          parameters: { type: "object", properties: {} },
        },
      }],
    }),
  })
  if (!response.ok) throw new Error(`chat ${response.status}: ${(await response.text()).slice(0, 400)}`)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = ""
  let text = ""
  let calls = new Map()
  let finish = null
  let chunks = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    pending += decoder.decode(value, { stream: true })
    const parts = pending.split("\n\n")
    pending = parts.pop() ?? ""
    for (const part of parts) {
      const line = part.split("\n").find((item) => item.startsWith("data: "))
      if (!line || line === "data: [DONE]") continue
      const event = JSON.parse(line.slice(6))
      if (event.error) throw new Error(event.error.message || "stream error")
      chunks += 1
      const choice = event.choices?.[0]
      const delta = choice?.delta ?? {}
      if (typeof delta.content === "string") text += delta.content
      for (const call of delta.tool_calls ?? []) {
        const current = calls.get(call.index) ?? { id: "", name: "", arguments: "" }
        if (call.id) current.id = call.id
        if (call.function?.name) current.name += call.function.name
        if (call.function?.arguments) current.arguments += call.function.arguments
        calls.set(call.index, current)
      }
      if (choice?.finish_reason) finish = choice.finish_reason
    }
  }
  return { text, calls: [...calls.values()], finish, chunks }
}

const before = await budget()
const first = await complete([{
  role: "user",
  content: "Call the marker tool once with no arguments. After its result, reply with exactly VIBE-MODEL-OK.",
}])
let second = null
if (first.calls.length === 1 && first.calls[0].name === "marker") {
  second = await complete([
    { role: "user", content: "Call the marker tool once with no arguments. After its result, reply with exactly VIBE-MODEL-OK." },
    { role: "assistant", content: first.text || null, tool_calls: first.calls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments || "{}" } })) },
    { role: "tool", tool_call_id: first.calls[0].id, content: "pong" },
  ])
}
const after = await budget()
console.log(JSON.stringify({
  before, after,
  apiDelta: Number((after.api - before.api).toFixed(9)),
  vibeDelta: Number((after.vibe - before.vibe).toFixed(9)),
  first: { finish: first.finish, chunks: first.chunks, tools: first.calls.map((call) => call.name), text: first.text },
  second: second && { finish: second.finish, chunks: second.chunks, text: second.text },
}))
