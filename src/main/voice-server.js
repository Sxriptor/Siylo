const http = require("node:http");
const { appendLog, getSession, getStateSnapshot, setVoiceState } = require("./state");
const { executeVoiceCommand } = require("./execution-engine");
const {
  getManagedSessionSnapshot,
  hasManagedSession,
  sendKeyToSession,
  sendTextToSession
} = require("./session-manager");
const {
  getTranscriptionProviderName,
  transcribeAudio
} = require("./transcription-service");

let voiceServer = null;

async function startVoiceServer() {
  if (voiceServer) {
    return getStateSnapshot().voice;
  }

  const port = resolveVoicePort();
  const host = resolveVoiceHost();
  const url = `http://${host}:${port}`;
  setVoiceState({
    status: "starting",
    port,
    provider: getTranscriptionProviderName(),
    url,
    lastError: ""
  });

  voiceServer = http.createServer((request, response) => {
    handleRequest(request, response).catch((error) => {
      appendLog("error", `Voice request failed: ${formatError(error)}`);
      sendJson(response, 500, {
        error: formatError(error),
        status: "error"
      });
    });
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      voiceServer = null;
      setVoiceState({
        status: "error",
        port,
        provider: getTranscriptionProviderName(),
        url,
        lastError: formatError(error)
      });
      reject(error);
    };

    voiceServer.once("error", onError);
    voiceServer.listen(port, host, () => {
      voiceServer.off("error", onError);
      resolve();
    });
  });

  setVoiceState({
    status: "listening",
    port,
    provider: getTranscriptionProviderName(),
    url,
    lastError: ""
  });
  appendLog("info", `Voice backend listening on ${url}.`);
  return getStateSnapshot().voice;
}

async function stopVoiceServer() {
  if (!voiceServer) {
    setVoiceState({
      status: "stopped",
      provider: getTranscriptionProviderName(),
      url: getStateSnapshot().voice.url || `http://${resolveVoiceHost()}:${resolveVoicePort()}`,
      lastError: ""
    });
    return getStateSnapshot().voice;
  }

  const activeServer = voiceServer;
  voiceServer = null;

  await new Promise((resolve, reject) => {
    activeServer.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });

  setVoiceState({
    status: "stopped",
    provider: getTranscriptionProviderName(),
    url: `http://${resolveVoiceHost()}:${resolveVoicePort()}`,
    lastError: ""
  });
  appendLog("info", "Voice backend stopped.");
  return getStateSnapshot().voice;
}

async function handleRequest(request, response) {
  setCorsHeaders(response);

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  const requestUrl = new URL(request.url || "/", "http://127.0.0.1");

  if (request.method === "GET" && requestUrl.pathname === "/health") {
    sendJson(response, 200, {
      status: "ok",
      voice: getStateSnapshot().voice,
      remoteAccess: getStateSnapshot().remoteAccess,
      sessions: getStateSnapshot().sessions
    });
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/voice") {
    const payload = await parseVoiceRequest(request);
    const transcript = await transcribeAudio(payload);
    appendLog(
      "info",
      `Voice command received for ${payload.sessionId || "auto"}: ${transcript.slice(0, 120)}`
    );

    const execution = await executeVoiceCommand({
      requestedSessionId: payload.sessionId,
      transcript
    });

    sendJson(response, 200, {
      output: execution.output || "",
      route: execution.route,
      sessionId: execution.sessionId,
      status: execution.status,
      transcript
    });
    return;
  }

  const sessionRouteMatch = requestUrl.pathname.match(/^\/sessions\/([^/]+)\/(output|input)$/i);
  if (sessionRouteMatch) {
    const sessionId = decodeURIComponent(sessionRouteMatch[1] || "").trim().toLowerCase();
    const routeType = (sessionRouteMatch[2] || "").toLowerCase();

    if (!sessionId) {
      sendJson(response, 400, {
        error: "Session ID is required.",
        status: "error"
      });
      return;
    }

    if (routeType === "output" && request.method === "GET") {
      sendJson(response, 200, resolveSessionOutputPayload(sessionId));
      return;
    }

    if (routeType === "input" && request.method === "POST") {
      const payload = await parseJsonRequest(request);
      const result = await handleSessionInputRequest(sessionId, payload);
      sendJson(response, 200, result);
      return;
    }
  }

  sendJson(response, 404, {
    error: "Not found.",
    status: "error"
  });
}

async function parseVoiceRequest(request) {
  const contentType = String(request.headers["content-type"] || "");
  const sessionIdHeader = request.headers["x-session-id"];
  const transcriptHeader = request.headers["x-transcript"];
  const promptHeader = request.headers["x-transcribe-prompt"];

  if (contentType.includes("application/json")) {
    const bodyBuffer = await readRequestBody(request);
    const payload = JSON.parse(bodyBuffer.toString("utf8") || "{}");

    return {
      audioBuffer: payload.audioBase64 ? Buffer.from(String(payload.audioBase64), "base64") : Buffer.alloc(0),
      contentType: payload.audioContentType || "application/octet-stream",
      filename: payload.filename || "voice.json",
      prompt: payload.prompt || promptHeader || "",
      sessionId: payload.sessionId || sessionIdHeader || "",
      transcript: payload.transcript || transcriptHeader || ""
    };
  }

  if (contentType.includes("multipart/form-data")) {
    const bodyBuffer = await readRequestBody(request);
    const multipart = parseMultipartFormData(bodyBuffer, contentType);

    return {
      audioBuffer: multipart.files.audio?.buffer || multipart.files.file?.buffer || Buffer.alloc(0),
      contentType:
        multipart.files.audio?.contentType ||
        multipart.files.file?.contentType ||
        "application/octet-stream",
      filename: multipart.files.audio?.filename || multipart.files.file?.filename || "voice-upload.bin",
      prompt: multipart.fields.prompt || promptHeader || "",
      sessionId: multipart.fields.sessionId || sessionIdHeader || "",
      transcript: multipart.fields.transcript || transcriptHeader || ""
    };
  }

  const rawAudio = await readRequestBody(request);
  return {
    audioBuffer: rawAudio,
    contentType: contentType || "application/octet-stream",
    filename: String(request.headers["x-filename"] || "voice-upload.bin"),
    prompt: String(promptHeader || ""),
    sessionId: String(sessionIdHeader || ""),
    transcript: String(transcriptHeader || "")
  };
}

function parseMultipartFormData(bodyBuffer, contentType) {
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) {
    throw new Error("Missing multipart boundary.");
  }

  const boundary = `--${boundaryMatch[1] || boundaryMatch[2]}`;
  const rawBody = bodyBuffer.toString("latin1");
  const parts = rawBody.split(boundary);
  const fields = {};
  const files = {};

  for (const part of parts) {
    const trimmedPart = part.trim();
    if (!trimmedPart || trimmedPart === "--") {
      continue;
    }

    const separatorIndex = part.indexOf("\r\n\r\n");
    if (separatorIndex < 0) {
      continue;
    }

    const headerBlock = part.slice(0, separatorIndex);
    let bodyBlock = part.slice(separatorIndex + 4);
    bodyBlock = bodyBlock.replace(/\r\n--$/, "").replace(/\r\n$/, "");

    const dispositionMatch = headerBlock.match(/name="([^"]+)"/i);
    if (!dispositionMatch) {
      continue;
    }

    const fieldName = dispositionMatch[1];
    const filenameMatch = headerBlock.match(/filename="([^"]*)"/i);
    const partContentTypeMatch = headerBlock.match(/content-type:\s*([^\r\n]+)/i);

    if (filenameMatch) {
      files[fieldName] = {
        buffer: Buffer.from(bodyBlock, "latin1"),
        contentType: partContentTypeMatch ? partContentTypeMatch[1].trim() : "application/octet-stream",
        filename: filenameMatch[1]
      };
      continue;
    }

    fields[fieldName] = bodyBlock.trim();
  }

  return {
    fields,
    files
  };
}

async function parseJsonRequest(request) {
  const bodyBuffer = await readRequestBody(request);
  const bodyText = bodyBuffer.toString("utf8").trim();

  if (!bodyText) {
    return {};
  }

  return JSON.parse(bodyText);
}

function resolveSessionOutputPayload(sessionId) {
  const session = getSession(sessionId);
  if (!session) {
    return {
      error: `Session not found: ${sessionId}`,
      inputAvailable: false,
      output: "",
      outputAvailable: false,
      sessionId,
      status: "error"
    };
  }

  if (!hasManagedSession(sessionId)) {
    return {
      inputAvailable: false,
      isBusy: false,
      message: "Live stdout is available only for managed terminal sessions.",
      output: "",
      outputAvailable: false,
      sessionId,
      status: "ok"
    };
  }

  const snapshot = getManagedSessionSnapshot(sessionId);
  return {
    inputAvailable: true,
    isBusy: snapshot?.isBusy || false,
    output: snapshot?.output || "",
    outputAvailable: true,
    sessionId,
    status: "ok"
  };
}

async function handleSessionInputRequest(sessionId, payload) {
  const session = getSession(sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  if (!hasManagedSession(sessionId)) {
    throw new Error("Keyboard input is available only for managed terminal sessions.");
  }

  const text = String(payload?.text || "").trim();
  const key = String(payload?.key || "").trim();

  if (text) {
    await sendTextToSession(sessionId, text, { allowBusy: true });
  } else if (key) {
    await sendKeyToSession(sessionId, key);
  } else {
    throw new Error("Input payload must include `text` or `key`.");
  }

  return resolveSessionOutputPayload(sessionId);
}

function readRequestBody(request, maxBytes = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;

    request.on("data", (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        reject(new Error(`Request body exceeded ${maxBytes} bytes.`));
        request.destroy();
        return;
      }

      chunks.push(chunk);
    });
    request.once("error", reject);
    request.once("end", () => {
      resolve(Buffer.concat(chunks));
    });
  });
}

function resolveVoicePort() {
  const configuredPort = Number(process.env.SIYLO_VOICE_PORT || getStateSnapshot().config.voiceServerPort || 3210);
  return Number.isInteger(configuredPort) && configuredPort > 0 ? configuredPort : 3210;
}

function resolveVoiceHost() {
  const configuredHost = String(process.env.SIYLO_VOICE_HOST || "").trim();
  return configuredHost || "127.0.0.1";
}

function setCorsHeaders(response) {
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Filename, X-Session-Id, X-Transcript, X-Transcribe-Prompt");
  response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS, POST");
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode);
  response.end(JSON.stringify(payload));
}

function formatError(error) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

module.exports = {
  startVoiceServer,
  stopVoiceServer
};
