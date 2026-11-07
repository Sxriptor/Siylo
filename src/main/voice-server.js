const http = require("node:http");
const { appendLog, getSession, getStateSnapshot, setVoiceState } = require("./state");
const { executeVoiceCommand } = require("./execution-engine");
const gitService = require("./git-service");
const {
  getManagedSessionCwd,
  getManagedSessionSnapshot,
  getManagedSessionsStatus,
  getManagedSessionVersion,
  getSessionEvents,
  hasManagedSession,
  onSessionEvent,
  resizeSession,
  sendKeyToSession,
  sendTextToSession
} = require("./session-manager");
const {
  addSubscription,
  getVapidPublicKey,
  handleSessionEventForPush,
  hasSubscription,
  noteClientVisibility,
  removeSubscription,
  sendPushToAll
} = require("./push-service");
const {
  getTranscriptionProviderName,
  transcribeAudio
} = require("./transcription-service");
const {
  captureDesktopFrame,
  getPrimaryScreenMetrics,
  moveDesktopPointer
} = require("./desktop-control-service");
const { synthesizeSpeech } = require("./speech-service");

let voiceServer = null;
let detachPushListener = null;

function ensurePushListener() {
  if (detachPushListener) {
    return;
  }

  detachPushListener = onSessionEvent((event) => handleSessionEventForPush(event));
}

async function startVoiceServer() {
  if (voiceServer) {
    return getStateSnapshot().voice;
  }

  ensurePushListener();
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

  if (request.method === "GET" && requestUrl.pathname === "/desktop/screenshot") {
    const frame = await captureDesktopFrame({
      format: requestUrl.searchParams.get("format") || "png"
    });
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": frame.contentType,
      "X-Screen-Width": String(frame.screen.width || 0),
      "X-Screen-Height": String(frame.screen.height || 0)
    });
    response.end(frame.imageBuffer);
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/desktop/metrics") {
    const screen = await getPrimaryScreenMetrics().catch(() => ({
      width: 0,
      height: 0
    }));
    sendJson(response, 200, {
      screen,
      status: "ok"
    });
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/desktop/stream") {
    await streamDesktopFrames(request, response, requestUrl);
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/desktop/input") {
    const payload = await parseJsonRequest(request);
    const result = await moveDesktopPointer({
      x: payload?.x,
      y: payload?.y,
      click: Boolean(payload?.click)
    });
    sendJson(response, 200, result);
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/tts") {
    const payload = await parseJsonRequest(request);
    const speech = await synthesizeSpeech(payload?.text || "");
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": speech.contentType
    });
    response.end(speech.audioBuffer);
    return;
  }

  if (requestUrl.pathname.startsWith("/push/")) {
    await handlePushRequest(request, response, requestUrl);
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/sessions/status") {
    const visible = requestUrl.searchParams.get("visible") === "1";
    noteClientVisibility(visible, requestUrl.searchParams.get("viewing") || "");
    const events = getSessionEvents(requestUrl.searchParams.get("since") || 0);
    sendJson(response, 200, {
      status: "ok",
      now: Date.now(),
      sessions: buildSessionStatusList(),
      events: events.events,
      seq: events.seq
    });
    return;
  }

  const gitRouteMatch = requestUrl.pathname.match(/^\/sessions\/([^/]+)\/git\/(status|log|commit|diff|tree|file|action)$/i);
  if (gitRouteMatch) {
    await handleGitRequest(
      request,
      response,
      requestUrl,
      decodeURIComponent(gitRouteMatch[1] || "").trim().toLowerCase(),
      gitRouteMatch[2].toLowerCase()
    );
    return;
  }

  const sessionRouteMatch = requestUrl.pathname.match(/^\/sessions\/([^/]+)\/(output|input|resize|kill)$/i);
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
      noteClientVisibility(requestUrl.searchParams.get("visible") !== "0", sessionId);
      const knownVersion = requestUrl.searchParams.get("v");
      sendJson(response, 200, resolveSessionOutputPayload(sessionId, knownVersion));
      return;
    }

    if (routeType === "input" && request.method === "POST") {
      const payload = await parseJsonRequest(request);
      const result = await handleSessionInputRequest(sessionId, payload);
      sendJson(response, 200, result);
      return;
    }

    if (routeType === "resize" && request.method === "POST") {
      const payload = await parseJsonRequest(request);
      if (!hasManagedSession(sessionId)) {
        sendJson(response, 404, { error: `Session not found: ${sessionId}`, status: "error" });
        return;
      }
      const result = resizeSession(sessionId, payload?.cols, payload?.rows);
      sendJson(response, 200, { status: "ok", sessionId, ...result });
      return;
    }

    if (routeType === "kill" && request.method === "POST") {
      if (!getSession(sessionId)) {
        sendJson(response, 404, { error: `Session not found: ${sessionId}`, status: "error" });
        return;
      }
      const execution = await executeVoiceCommand({ requestedSessionId: "", transcript: `kill ${sessionId}` });
      sendJson(response, 200, { status: "ok", sessionId, route: execution.route });
      return;
    }
  }

  sendJson(response, 404, {
    error: "Not found.",
    status: "error"
  });
}

async function handleGitRequest(request, response, requestUrl, sessionId, routeType) {
  if (!hasManagedSession(sessionId)) {
    sendJson(response, 404, { error: `Session not found: ${sessionId}`, status: "error" });
    return;
  }

  // The phone can point the panel at a different folder; otherwise follow the terminal.
  const detectedCwd = getManagedSessionCwd(sessionId);
  const requestedCwd = String(requestUrl.searchParams.get("cwd") || "").trim();
  const cwd = requestedCwd && gitService.isDirectory(requestedCwd) ? requestedCwd : detectedCwd;
  const params = requestUrl.searchParams;

  try {
    let result;
    if (routeType === "status" && request.method === "GET") {
      result = await gitService.getStatus(cwd);
    } else if (routeType === "log" && request.method === "GET") {
      result = await gitService.getLog(cwd, { all: params.get("all") === "1", limit: params.get("limit") });
    } else if (routeType === "commit" && request.method === "GET") {
      result = await gitService.getCommit(cwd, params.get("hash"));
    } else if (routeType === "diff" && request.method === "GET") {
      result = await gitService.getDiff(cwd, {
        path: params.get("path") || "",
        staged: params.get("staged") === "1",
        untracked: params.get("untracked") === "1",
        commit: params.get("commit") || ""
      });
    } else if (routeType === "tree" && request.method === "GET") {
      result = await gitService.listDirectory(cwd, params.get("dir") || "");
    } else if (routeType === "file" && request.method === "GET") {
      result = await gitService.readProjectFile(cwd, params.get("path") || "");
    } else if (routeType === "action" && request.method === "POST") {
      const payload = await parseJsonRequest(request);
      result = await gitService.runAction(cwd, payload);
      appendLog(
        result.ok ? "info" : "warn",
        `Git ${result.action} in ${result.root} for ${sessionId}: ${result.steps.map((step) => step.command).join(" && ")}`
      );
    } else {
      sendJson(response, 405, { error: "Method not allowed.", status: "error" });
      return;
    }

    sendJson(response, 200, { status: "ok", sessionId, detectedCwd, ...result });
  } catch (error) {
    sendJson(response, error?.statusCode || 500, {
      error: formatError(error),
      status: "error",
      sessionId,
      detectedCwd,
      cwd
    });
  }
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

function resolveSessionOutputPayload(sessionId, knownVersion = null) {
  const session = getSession(sessionId);
  if (!session) {
    return {
      error: `Session not found: ${sessionId}`,
      inputAvailable: false,
      missing: true,
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
      message: "Live output is only available for terminal sessions. Use Talk to send commands to this app.",
      output: "",
      outputAvailable: false,
      sessionId,
      status: "ok"
    };
  }

  const currentVersion = getManagedSessionVersion(sessionId);
  if (knownVersion !== null && knownVersion !== "" && Number(knownVersion) === currentVersion) {
    const statusEntry = buildSessionStatusList().find((entry) => entry.id === sessionId);
    return {
      activity: statusEntry?.activity || "idle",
      inputAvailable: true,
      isBusy: Boolean(statusEntry?.isBusy),
      outputAvailable: true,
      runStartedAt: statusEntry?.runStartedAt || 0,
      sessionId,
      status: "ok",
      unchanged: true,
      version: currentVersion,
      waitingForInput: Boolean(statusEntry?.waitingForInput)
    };
  }

  const snapshot = getManagedSessionSnapshot(sessionId);
  return {
    activity: snapshot?.activity || "idle",
    cols: snapshot?.cols || 0,
    inputAvailable: true,
    isBusy: snapshot?.isBusy || false,
    output: snapshot?.output || "",
    outputAvailable: true,
    runStartedAt: snapshot?.runStartedAt || 0,
    sessionId,
    status: "ok",
    version: snapshot?.version ?? currentVersion,
    waitingForInput: Boolean(snapshot?.waitingForInput)
  };
}

function buildSessionStatusList() {
  const managedStatuses = getManagedSessionsStatus();
  const managedIds = new Set(managedStatuses.map((entry) => entry.id));
  const desktopStatuses = getStateSnapshot().sessions
    .filter((session) => !managedIds.has(session.id))
    .map((session) => ({
      id: session.id,
      shell: session.shell,
      activity: "app",
      isBusy: false,
      lastCommand: session.lastCommand || "",
      lastFinishedAt: 0,
      lastEventKind: "",
      lastLine: "",
      runStartedAt: 0,
      version: 0,
      waitingForInput: false
    }));

  return [...managedStatuses, ...desktopStatuses];
}

async function handleSessionInputRequest(sessionId, payload) {
  const session = getSession(sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  if (!hasManagedSession(sessionId)) {
    throw new Error("Keyboard input is available only for managed terminal sessions.");
  }

  const rawText = typeof payload?.text === "string" ? payload.text : "";
  const text = rawText.replace(/[\r\n]+$/g, "");
  const key = String(payload?.key || "").trim();
  const pressEnter = payload?.enter !== false;

  if (key) {
    await sendKeyToSession(sessionId, key);
  } else if (text || pressEnter) {
    await sendTextToSession(sessionId, text, { allowBusy: true, pressEnter });
  } else {
    throw new Error("Input payload must include `text` or `key`.");
  }

  // Give the shell a moment to echo so the response already shows the result.
  await delay(140);
  return resolveSessionOutputPayload(sessionId);
}

async function handlePushRequest(request, response, requestUrl) {
  if (request.method === "GET" && requestUrl.pathname === "/push/key") {
    sendJson(response, 200, { status: "ok", publicKey: getVapidPublicKey() });
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/push/subscribe") {
    const payload = await parseJsonRequest(request);
    const result = addSubscription(payload?.subscription || payload);
    sendJson(response, 200, { status: "ok", ...result });
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/push/unsubscribe") {
    const payload = await parseJsonRequest(request);
    const result = removeSubscription(String(payload?.endpoint || ""));
    sendJson(response, 200, { status: "ok", ...result });
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/push/status") {
    const payload = await parseJsonRequest(request);
    sendJson(response, 200, { status: "ok", subscribed: hasSubscription(String(payload?.endpoint || "")) });
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/push/test") {
    const result = await sendPushToAll({
      title: "Siylo notifications are on",
      body: "You'll get a notification when a terminal finishes or needs input.",
      tag: "siylo-test",
      url: "/radio"
    });
    sendJson(response, 200, { status: "ok", ...result });
    return;
  }

  sendJson(response, 404, { error: "Not found.", status: "error" });
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

async function streamDesktopFrames(request, response, requestUrl) {
  const boundary = "siylo-desktop-frame";
  const requestedFps = Number(requestUrl.searchParams.get("fps") || 4);
  const fps = Number.isFinite(requestedFps) ? Math.max(1, Math.min(requestedFps, 8)) : 4;
  const frameDelayMs = Math.round(1000 / fps);
  let closed = false;

  request.once("close", () => {
    closed = true;
  });

  response.writeHead(200, {
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "Connection": "keep-alive",
    "Content-Type": `multipart/x-mixed-replace; boundary=${boundary}`,
    "Pragma": "no-cache"
  });

  while (!closed && !response.destroyed) {
    try {
      const frame = await captureDesktopFrame({
        format: "jpg"
      });
      response.write(`--${boundary}\r\n`);
      response.write(`Content-Type: ${frame.contentType}\r\n`);
      response.write(`Content-Length: ${frame.imageBuffer.length}\r\n`);
      response.write(`X-Screen-Width: ${frame.screen.width || 0}\r\n`);
      response.write(`X-Screen-Height: ${frame.screen.height || 0}\r\n\r\n`);
      response.write(frame.imageBuffer);
      response.write("\r\n");
    } catch (error) {
      appendLog("warn", `Desktop stream frame failed: ${formatError(error)}`);
      await delay(750);
    }

    await delay(frameDelayMs);
  }

  if (!response.destroyed) {
    response.end();
  }
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
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
  response.setHeader("Access-Control-Expose-Headers", "X-Screen-Width, X-Screen-Height");
  response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS, POST");
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
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

function isVoiceServerListening() {
  return voiceServer !== null && voiceServer.listening;
}

module.exports = {
  isVoiceServerListening,
  startVoiceServer,
  stopVoiceServer
};
