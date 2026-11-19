import { execFile, spawn } from "node:child_process"
import { once } from "node:events"
import { constants } from "node:fs"
import { access, mkdir, mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises"
import { createConnection, createServer } from "node:net"
import { delimiter, dirname, isAbsolute, join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"

const SERVER = "bridge"
const SHIM_FLAG = "--vibe-mcp-stdio"
const STARTUP_MS = 45_000
const TURN_MS = 15 * 60_000
const IDLE_MS = 5 * 60_000
const MAX_FRAME = 16 * 1024 * 1024
const CATALOG_URL = "https://api.mistral.ai/v1/models"
const run = promisify(execFile)

async function vibeExecutable() {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!isAbsolute(directory)) continue
    try {
      const executable = await realpath(join(directory, "vibe-acp"))
      await access(executable, constants.X_OK)
      return executable
    } catch {}
  }
  throw new Error("The official vibe-acp executable was not found in PATH.")
}

async function vibePython() {
  const executable = await vibeExecutable()
  const python = join(dirname(executable), "python")
  try {
    await access(python, constants.X_OK)
    return python
  } catch {}
  const launcher = await open(executable)
  try {
    const { buffer, bytesRead } = await launcher.read(Buffer.alloc(512))
    const firstLine = buffer.subarray(0, bytesRead).toString().split("\n", 1)[0]
    const interpreter = firstLine.match(/^#!\s*(\/[^\s]+\/python(?:[\d.]+)?)\s*$/)?.[1]
    if (interpreter) return interpreter
  } finally {
    await launcher.close()
  }
  throw new Error("Could not find the Python runtime of the installed Vibe CLI.")
}

export async function listVibeModelRows() {
  const token = process.env.MISTRAL_API_KEY
  if (token) {
    const response = await fetch(CATALOG_URL, {
      headers: { authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`Mistral model catalog returned HTTP ${response.status}.`)
    return (await response.json()).data
  }

  // The installed Vibe runtime resolves its own Keychain login. Only the
  // model catalog leaves the helper process, so Magpie never stores that key.
  const { stdout } = await run(await vibePython(), ["-I", "-c", `
import httpx
from vibe.utils.keyring import get_api_key_from_keyring

key = get_api_key_from_keyring("MISTRAL_API_KEY")
if not key:
    raise SystemExit(1)
reply = httpx.get(${JSON.stringify(CATALOG_URL)}, headers={"Authorization": "Bearer " + key}, timeout=10)
reply.raise_for_status()
print(reply.text)
`], { timeout: 13_000, maxBuffer: 2 * 1024 * 1024 })
  return JSON.parse(stdout).data
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function readMessages(stream, receive, fail) {
  let partial = ""
  stream.setEncoding("utf8")
  stream.on("data", (chunk) => {
    try {
      for (let start = 0; start < chunk.length;) {
        const end = chunk.indexOf("\n", start)
        partial += chunk.slice(start, end === -1 ? undefined : end)
        if (partial.length > MAX_FRAME) throw new Error()
        if (end === -1) break
        const line = partial
        partial = ""
        start = end + 1
        if (!line.trim()) continue
        const message = JSON.parse(line)
        if (!isObject(message) || message.jsonrpc !== "2.0") throw new Error()
        receive(message)
      }
    } catch {
      fail()
    }
  })
}

function send(stream, message) {
  if (!stream.writable) return
  const line = JSON.stringify({ jsonrpc: "2.0", ...message })
  if (line.length > MAX_FRAME) throw new Error("Vibe bridge message is too large.")
  stream.write(line + "\n")
}

function textResult(text, isError = false) {
  return { content: [{ type: "text", text }], isError }
}

function serveMcp(socket, published, invoke) {
  async function respond({ id, method, params }) {
    let result
    switch (method) {
      case "initialize":
        result = {
          protocolVersion: ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]
            .includes(params?.protocolVersion) ? params.protocolVersion : "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "vibe-tool-bridge", version: "1.0.0" },
        }
        break
      case "ping":
        result = {}
        break
      case "tools/list":
        result = { tools: [...published.values()].map(({ definition }) => definition) }
        break
      case "tools/call": {
        const tool = published.get(params?.name)
        const args = params?.arguments ?? {}
        if (!tool || !isObject(args)) {
          send(socket, { id, error: { code: -32602, message: "Invalid bridge tool call." } })
          return
        }
        result = await invoke(tool.name, args)
        break
      }
      default:
        send(socket, { id, error: { code: -32601, message: "Unsupported MCP method." } })
        return
    }
    try {
      send(socket, { id, result })
    } catch {
      send(socket, { id, error: { code: -32603, message: "Invalid or oversized MCP result." } })
    }
  }

  readMessages(socket, (message) => {
    if (message.id == null) return
    void respond(message).catch(() => socket.destroy())
  }, () => socket.destroy())
}

function prepareTools(tools) {
  const names = new Set()
  for (const tool of tools) {
    if (typeof tool?.name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(tool.name) ||
        names.has(tool.name) || !isObject(tool.inputSchema)) {
      throw new TypeError("Expected unique Vibe bridge tool names and object input schemas.")
    }
    names.add(tool.name)
  }

  const published = new Map()
  const nameLimit = 64 - SERVER.length - 1
  let suffix = 0
  for (const { name, description, inputSchema } of tools) {
    // Vibe uses identifiers for runtime MCP tool names. Reserve the original
    // names first so normalization cannot shadow another caller tool.
    const candidate = name.replaceAll("-", "_").replace(/^\d/, "_$&")
    let alias = candidate
    while (alias.length > nameLimit || published.has(alias) || (alias !== name && names.has(alias))) {
      const ending = "_" + ++suffix
      alias = candidate.slice(0, nameLimit - ending.length) + ending
    }
    published.set(alias, {
      name,
      definition: {
        name: alias,
        description: alias === name ? description : `${name}: ${description ?? ""}`,
        inputSchema: JSON.parse(JSON.stringify(inputSchema)),
      },
    })
  }
  return published
}

function configFor(model, published, socketPath, cwd) {
  const stdio = [
    process.execPath, fileURLToPath(import.meta.url), SHIM_FLAG, socketPath,
  ]
  const enabled = [...published.keys()].map((name) => `${SERVER}_${name}`)
  return [
    `active_model = ${JSON.stringify(model.id)}`,
    `enabled_tools = ${JSON.stringify(enabled.length ? enabled : ["bridge_no_tools"])}`,
    'disabled_skills = ["*"]',
    "enable_connectors = false",
    "enable_telemetry = false",
    "enable_auto_update = false",
    "enable_file_autocomplete = false",
    "enable_auto_approve = false",
    "[session_logging]",
    "enabled = false",
    "generate_titles = false",
    ...(enabled.length ? [
      "[[mcp_servers]]",
      `name = "${SERVER}"`,
      'transport = "stdio"',
      `command = ${JSON.stringify(stdio)}`,
      `cwd = ${JSON.stringify(cwd)}`,
      `tool_timeout_sec = ${TURN_MS / 1000}`,
    ] : []),
    ...(model.explicit ? [
      "[[models]]",
      `name = ${JSON.stringify(model.id)}`,
      'provider = "mistral"',
      `max_context_length = ${model.context}`,
      `max_output_tokens = ${model.output}`,
    ] : []),
    "",
  ].join("\n")
}

function literalPrompt(text) {
  // ACP also interprets slash commands and attaches local @mentions before approvals.
  const escaped = text.replace(/(?<![\p{L}\p{N}_])@(?=[\p{L}\p{N}._/\\()[\]{}~'"-])/gu, "@\u200b")
  return /^\s*\//u.test(escaped) ? "\u200b" + escaped : escaped
}

function acpError(method, code) {
  if (code === -32000) {
    return new Error("Vibe ACP authentication is required. Sign in with Vibe or set MISTRAL_API_KEY.")
  }
  const suffix = Number.isInteger(code) ? ` (code ${code})` : ""
  return new Error(`Vibe ACP ${method} failed${suffix}.`)
}

function runStdioShim(socketPath) {
  const socket = createConnection(socketPath)
  const stop = () => {
    process.stdin.unpipe(socket)
    process.stdin.pause()
    socket.destroy()
  }
  socket.on("error", () => {
    process.exitCode = 1
    stop()
  })
  process.stdin.on("error", stop)
  process.stdout.on("error", stop)
  socket.on("close", stop)
  process.stdin.pipe(socket)
  socket.pipe(process.stdout)
}

if (process.argv[2] === SHIM_FLAG && process.argv[1] &&
    pathToFileURL(process.argv[1]).href === import.meta.url) {
  runStdioShim(process.argv[3])
}

/**
 * Start a native Vibe ACP session. A caller tool promise keeps its MCP request
 * open inside the current prompt. Close the session when it is no longer needed.
 */
export async function openVibeAcpSession({ model, tools, onTool, onText, onThought }) {
  if (typeof model?.id !== "string" || (model.explicit &&
      ![model.context, model.output].every((limit) => Number.isSafeInteger(limit) && limit > 0))) {
    throw new TypeError("Expected a Vibe ACP model ID and valid model limits.")
  }
  if (!Array.isArray(tools) || typeof onTool !== "function" ||
      typeof onText !== "function" || (onThought != null && typeof onThought !== "function")) {
    throw new TypeError("Expected Vibe bridge tools, onTool, onText, and an optional onThought.")
  }
  const published = prepareTools(tools)
  // Vibe filters on the display name, but identifies approvals by group and tool.
  const allowed = new Set([...published.keys()].map((name) => `mcp_${SERVER}.${name}`))
  const root = await mkdtemp(join(await realpath("/tmp"), "vibe-acp-"))
  const home = join(root, "home")
  const cwd = join(root, "work")
  const socketPath = join(root, "mcp.sock")
  const sockets = new Set()
  const pending = new Map()
  const calls = new Set()
  let child
  let childClosed
  let sessionId
  let turn
  let nextId = 0
  let idle
  let closing
  let closedError

  const server = createServer((socket) => {
    socket.on("error", () => socket.destroy())
    if (closedError) {
      socket.destroy()
      return
    }
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
    serveMcp(socket, published, async (name, args) => {
      if (!turn || closedError) return textResult("No active Vibe prompt.", true)
      try {
        const result = await onTool(name, args)
        if (typeof result === "string") return textResult(result)
        if (isObject(result) && Array.isArray(result.content)) return result
        if (isObject(result) && isObject(result.structuredContent) && result.content === undefined) {
          return { ...result, content: [] }
        }
        return textResult("The caller returned an invalid MCP tool result.", true)
      } catch {
        return textResult("The caller tool failed.", true)
      }
    })
  })

  function signalGroup(signal) {
    if (!child?.pid) return false
    try {
      process.kill(-child.pid, signal)
      return true
    } catch {
      return false
    }
  }

  function close(error = new Error("Vibe ACP session closed.")) {
    if (closing) return closing
    closedError = error
    clearTimeout(idle)
    for (const { finish } of pending.values()) finish(undefined, error)
    pending.clear()
    for (const socket of sockets) socket.destroy()
    child?.stdin.end()

    closing = (async () => {
      const serverClosed = new Promise((resolve) => server.close(resolve))
      if (childClosed) {
        await Promise.race([childClosed, delay(500, undefined, { ref: false })])
        if (signalGroup("SIGTERM")) {
          await delay(500)
          signalGroup("SIGKILL")
        }
        await Promise.race([childClosed, delay(500, undefined, { ref: false })])
      }
      await serverClosed
      await rm(root, { recursive: true, force: true })
    })()
    return closing
  }

  function fail(error) {
    void close(error).catch(() => {})
  }

  function request(method, params, timeout) {
    if (closedError) return Promise.reject(closedError)
    const id = ++nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => fail(new Error(`Vibe ACP ${method} timed out.`)), timeout)
      const finish = (result, error) => {
        clearTimeout(timer)
        pending.delete(id)
        if (error) reject(error)
        else resolve(result)
      }
      pending.set(id, { method, finish })
      try {
        send(child.stdin, { id, method, params })
      } catch (error) {
        finish(undefined, error)
      }
    })
  }

  function receive({ id, method, params, result, error }) {
    if (closedError) return
    if (method === "session/update" && id == null) {
      if (!turn || params?.sessionId !== sessionId) return
      const update = params.update
      if (update?.sessionUpdate === "tool_call" || update?.sessionUpdate === "tool_call_update") {
        const meta = update._meta
        const callId = update.toolCallId
        if (["completed", "failed", "cancelled"].includes(update.status)) calls.delete(callId)
        else if (typeof callId === "string" && allowed.has(meta?.tool_name) && meta.effect_kind === "tool") {
          calls.add(callId)
        } else if (meta?.tool_name) calls.delete(callId)
      }
      if (update?.content?.type === "text" && typeof update.content.text === "string") {
        try {
          if (update.sessionUpdate === "agent_message_chunk") onText(update.content.text)
          if (update.sessionUpdate === "agent_thought_chunk") onThought?.(update.content.text)
        } catch {
          fail(new Error("A Vibe ACP stream callback failed."))
        }
      }
      return
    }
    if (method && id != null) {
      if (method === "session/request_permission") {
        const trusted = turn && params?.sessionId === sessionId && calls.has(params.toolCall?.toolCallId)
        const options = Array.isArray(params?.options) ? params.options : []
        const option = (trusted && options.find((entry) => entry?.kind === "allow_once")) ||
          options.find((entry) => entry?.kind === "reject_once")
        const outcome = typeof option?.optionId === "string"
          ? { outcome: "selected", optionId: option.optionId }
          : { outcome: "cancelled" }
        send(child.stdin, { id, result: { outcome } })
      } else {
        send(child.stdin, { id, error: { code: -32601, message: "Unsupported ACP client method." } })
      }
      return
    }
    const request = pending.get(id)
    if (!method && request) request.finish(result, error ? acpError(request.method, error.code) : undefined)
  }

  function armIdle() {
    idle = setTimeout(() => fail(new Error("Vibe ACP session expired while idle.")), IDLE_MS)
  }

  async function prompt(text) {
    if (typeof text !== "string") throw new TypeError("Expected a Vibe ACP text prompt.")
    if (closedError) throw closedError
    if (turn) throw new Error("A Vibe ACP prompt is already active.")
    clearTimeout(idle)
    turn = true
    try {
      const result = await request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: literalPrompt(text) }],
      }, TURN_MS)
      if (typeof result?.stopReason !== "string") throw new Error("Invalid Vibe ACP prompt result.")
      return result
    } finally {
      turn = false
      calls.clear()
      if (!closedError) armIdle()
    }
  }

  try {
    await mkdir(home, { mode: 0o700 })
    await mkdir(cwd, { mode: 0o700 })
    await writeFile(join(home, "config.toml"), configFor(model, published, socketPath, cwd), { mode: 0o600 })
    if (published.size) {
      server.listen(socketPath)
      await once(server, "listening")
      server.on("error", () => fail(new Error("The private Vibe MCP socket failed.")))
    }

    // Keep Vibe's native auth environment while excluding overrides for the
    // backend, tools, logging, and spawned Node shim.
    const env = { ...process.env, VIBE_HOME: home }
    for (const key of Object.keys(env)) {
      if (key !== "VIBE_HOME" && (/^VIBE_/i.test(key) || /^NODE_OPTIONS$/i.test(key) ||
          (/^MISTRAL_/i.test(key) && key !== "MISTRAL_API_KEY"))) delete env[key]
    }
    child = spawn(await vibeExecutable(), [], { cwd, env, detached: true, stdio: ["pipe", "pipe", "ignore"] })
    childClosed = new Promise((resolve) => child.once("close", resolve))
    child.once("error", (error) => fail(new Error(error.code === "ENOENT"
      ? "The official vibe-acp executable was not found in PATH."
      : "The vibe-acp subprocess could not start.")))
    child.once("close", () => fail(new Error("The vibe-acp subprocess exited.")))
    child.stdin.on("error", () => fail(new Error("The vibe-acp input stream failed.")))
    child.stdout.on("error", () => fail(new Error("The vibe-acp output stream failed.")))
    readMessages(child.stdout, receive, () => fail(new Error("Invalid Vibe ACP protocol message.")))

    const initialized = await request("initialize", { protocolVersion: 1, clientCapabilities: {} }, STARTUP_MS)
    if (initialized?.protocolVersion !== 1) throw new Error("Vibe ACP did not negotiate protocol v1.")
    // session/new's stdio entry has no timeout field and would replace the
    // isolated config entry, imposing Vibe's default tool timeout.
    const session = await request("session/new", { cwd, mcpServers: [] }, STARTUP_MS)
    sessionId = session?.sessionId
    if (typeof sessionId !== "string" || !sessionId) throw new Error("Vibe ACP did not return a session ID.")
    const selection = session.configOptions?.find((option) => option.id === "model")
    if (selection?.currentValue !== model.id) throw new Error(`Vibe ACP did not select ${model.id}.`)
    armIdle()
    return { prompt, close: () => close() }
  } catch (error) {
    await close(error)
    throw error
  }
}
