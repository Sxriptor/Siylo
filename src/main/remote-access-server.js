const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");
const {
  appendLog,
  getConfig,
  getStateSnapshot,
  setRemoteAccessState
} = require("./state");
const { timingSafeCompare, verifySecret } = require("./security-utils");

let remoteAccessServer = null;
let currentOptions = null;
const failedAuthAttempts = new Map();

async function startRemoteAccessServer(options = {}) {
  currentOptions = {
    ...currentOptions,
    ...options
  };

  const config = getConfig();
  const port = resolveRemoteAccessPort();
  const localUrls = listRemoteAccessUrls(port);

  if (!config.remoteAccessUsername || !config.remoteAccessPasswordHash || !config.remoteAccessPasswordSalt) {
    setRemoteAccessState({
      status: "error",
      port,
      url: localUrls[0] || "",
      localUrls,
      lastError: "Set a remote access username and password before enabling tunnel access."
    });
    return getStateSnapshot().remoteAccess;
  }

  if (remoteAccessServer) {
    return getStateSnapshot().remoteAccess;
  }

  try {
    const primaryUrl = localUrls[0] || `http://localhost:${port}/radio`;

    setRemoteAccessState({
      status: "starting",
      port,
      url: primaryUrl,
      localUrls,
      lastError: ""
    });

    remoteAccessServer = http.createServer((request, response) => {
      handleRemoteAccessRequest(request, response).catch((error) => {
        appendLog("error", `Remote access request failed: ${formatError(error)}`);
        sendText(response, 500, "Remote access request failed.");
      });
    });

    await new Promise((resolve, reject) => {
      const onError = (error) => {
        remoteAccessServer = null;
        setRemoteAccessState({
          status: "error",
          port,
          url: primaryUrl,
          localUrls,
          lastError: formatError(error)
        });
        reject(error);
      };

      remoteAccessServer.once("error", onError);
      remoteAccessServer.listen(port, "127.0.0.1", () => {
        remoteAccessServer.off("error", onError);
        resolve();
      });
    });

    setRemoteAccessState({
      status: "listening",
      port,
      url: primaryUrl,
      localUrls,
      lastError: ""
    });
    appendLog("info", `Remote access server listening on ${primaryUrl}.`);
    return getStateSnapshot().remoteAccess;
  } catch (error) {
    setRemoteAccessState({
      status: "error",
      port,
      url: localUrls[0] || "",
      localUrls,
      lastError: formatError(error)
    });
    throw error;
  }
}

async function stopRemoteAccessServer() {
  if (!remoteAccessServer) {
    const port = resolveRemoteAccessPort();
    const localUrls = listRemoteAccessUrls(port);
    setRemoteAccessState({
      status: "stopped",
      port,
      url: localUrls[0] || "",
      localUrls,
      lastError: ""
    });
    return getStateSnapshot().remoteAccess;
  }

  const activeServer = remoteAccessServer;
  remoteAccessServer = null;
  failedAuthAttempts.clear();

  await new Promise((resolve, reject) => {
    activeServer.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });

  const port = resolveRemoteAccessPort();
  const localUrls = listRemoteAccessUrls(port);
  setRemoteAccessState({
    status: "stopped",
    port,
    url: localUrls[0] || "",
    localUrls,
    lastError: ""
  });
  appendLog("info", "Remote access server stopped.");
  return getStateSnapshot().remoteAccess;
}

async function restartRemoteAccessServer(options = {}) {
  if (remoteAccessServer) {
    await stopRemoteAccessServer();
  }

  return startRemoteAccessServer({
    ...currentOptions,
    ...options
  });
}

async function handleRemoteAccessRequest(request, response) {
  const requestUrl = new URL(request.url || "/", "https://siylo.local");

  if (requestUrl.pathname === "/") {
    response.writeHead(302, { Location: "/radio" });
    response.end();
    return;
  }

  const authResult = authorizeRequest(request);
  if (!authResult.authorized) {
    if (authResult.statusCode === 429) {
      sendText(response, 429, authResult.message, {
        "Retry-After": String(Math.max(1, Math.ceil((authResult.retryAfterMs || 1000) / 1000)))
      });
      return;
    }

    response.writeHead(401, {
      "Content-Type": "text/plain; charset=utf-8",
      "WWW-Authenticate": 'Basic realm="Siylo Remote", charset="UTF-8"'
    });
    response.end(authResult.message);
    return;
  }

  if (requestUrl.pathname === "/health" || requestUrl.pathname === "/voice") {
    await proxyRequest(request, response, buildVoiceProxyUrl(requestUrl));
    return;
  }

  if (currentOptions?.isDev) {
    await proxyRequest(request, response, buildRendererProxyUrl(requestUrl));
    return;
  }

  await serveStaticRequest(request, response, requestUrl);
}

function authorizeRequest(request) {
  const clientAddress = normalizeRemoteAddress(request.socket.remoteAddress);
  const attemptState = failedAuthAttempts.get(clientAddress);

  if (attemptState?.blockedUntil && attemptState.blockedUntil > Date.now()) {
    return {
      authorized: false,
      statusCode: 429,
      message: "Too many failed login attempts. Try again shortly.",
      retryAfterMs: attemptState.blockedUntil - Date.now()
    };
  }

  const authorizationHeader = String(request.headers.authorization || "");
  if (!authorizationHeader.startsWith("Basic ")) {
    return {
      authorized: false,
      statusCode: 401,
      message: "Remote access credentials are required."
    };
  }

  let username = "";
  let password = "";

  try {
    const decodedValue = Buffer.from(authorizationHeader.slice(6), "base64").toString("utf8");
    const separatorIndex = decodedValue.indexOf(":");
    username = separatorIndex >= 0 ? decodedValue.slice(0, separatorIndex) : decodedValue;
    password = separatorIndex >= 0 ? decodedValue.slice(separatorIndex + 1) : "";
  } catch {
    recordFailedAttempt(clientAddress);
    return {
      authorized: false,
      statusCode: 401,
      message: "Remote access credentials were malformed."
    };
  }

  const config = getConfig();
  const usernameMatches = timingSafeCompare(username, config.remoteAccessUsername);
  const passwordMatches = verifySecret(
    password,
    config.remoteAccessPasswordHash,
    config.remoteAccessPasswordSalt
  );

  if (!usernameMatches || !passwordMatches) {
    recordFailedAttempt(clientAddress);
    return {
      authorized: false,
      statusCode: 401,
      message: "Remote access credentials were rejected."
    };
  }

  failedAuthAttempts.delete(clientAddress);
  return {
    authorized: true,
    statusCode: 200,
    message: ""
  };
}

function recordFailedAttempt(clientAddress) {
  const existingState = failedAuthAttempts.get(clientAddress) || {
    count: 0,
    blockedUntil: 0
  };
  const nextCount = existingState.count + 1;
  const blockedUntil = nextCount >= 6 ? Date.now() + 5 * 60 * 1000 : 0;

  failedAuthAttempts.set(clientAddress, {
    count: blockedUntil ? 0 : nextCount,
    blockedUntil
  });
}

function buildVoiceProxyUrl(requestUrl) {
  const voicePort = Number(getStateSnapshot().voice.port || getConfig().voiceServerPort || 3210);
  return new URL(`${requestUrl.pathname}${requestUrl.search}`, `http://127.0.0.1:${voicePort}`);
}

function buildRendererProxyUrl(requestUrl) {
  const dashboardPort = Number(getConfig().dashboardPort || 3000);
  return new URL(`${requestUrl.pathname}${requestUrl.search}`, `http://127.0.0.1:${dashboardPort}`);
}

function proxyRequest(request, response, targetUrl) {
  return new Promise((resolve, reject) => {
    const upstreamTransport = targetUrl.protocol === "https:" ? https : http;
    const upstreamRequest = upstreamTransport.request(
      targetUrl,
      {
        method: request.method,
        headers: filterProxyHeaders(request.headers, targetUrl)
      },
      (upstreamResponse) => {
        const responseHeaders = { ...upstreamResponse.headers };
        if (typeof responseHeaders.location === "string") {
          responseHeaders.location = rewriteLocationHeader(responseHeaders.location, targetUrl, request);
        }

        response.writeHead(upstreamResponse.statusCode || 502, responseHeaders);
        upstreamResponse.pipe(response);
        upstreamResponse.once("end", resolve);
      }
    );

    upstreamRequest.once("error", reject);
    request.pipe(upstreamRequest);
  });
}

async function serveStaticRequest(request, response, requestUrl) {
  if (!["GET", "HEAD"].includes(String(request.method || "GET").toUpperCase())) {
    sendText(response, 405, "Method not allowed.");
    return;
  }

  const filePath = resolveStaticFilePath(requestUrl.pathname);
  if (!filePath) {
    sendText(response, 404, "Not found.");
    return;
  }

  const contentType = getContentType(filePath);
  response.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": filePath.endsWith(".html") ? "no-cache" : "public, max-age=300"
  });

  if (String(request.method || "GET").toUpperCase() === "HEAD") {
    response.end();
    return;
  }

  fs.createReadStream(filePath).pipe(response);
}

function resolveStaticFilePath(requestPathname) {
  const productionRoot = currentOptions?.productionRoot || "";
  const publicRoot = currentOptions?.publicRoot || "";
  const normalizedPath = decodeURIComponent(requestPathname || "/");
  const candidatePaths = [];

  if (normalizedPath === "/radio") {
    candidatePaths.push(path.join(productionRoot, "radio.html"));
  }

  if (normalizedPath === "/") {
    candidatePaths.push(path.join(productionRoot, "index.html"));
  }

  candidatePaths.push(path.join(productionRoot, normalizedPath.replace(/^\//, "")));
  candidatePaths.push(path.join(productionRoot, normalizedPath.replace(/^\//, ""), "index.html"));
  candidatePaths.push(path.join(publicRoot, normalizedPath.replace(/^\//, "")));

  for (const candidatePath of candidatePaths) {
    if (!candidatePath) {
      continue;
    }

    const normalizedCandidate = path.normalize(candidatePath);
    if (
      (productionRoot && normalizedCandidate.startsWith(path.normalize(productionRoot))) ||
      (publicRoot && normalizedCandidate.startsWith(path.normalize(publicRoot)))
    ) {
      if (fs.existsSync(normalizedCandidate) && fs.statSync(normalizedCandidate).isFile()) {
        return normalizedCandidate;
      }
    }
  }

  return "";
}

function filterProxyHeaders(headers, targetUrl) {
  const nextHeaders = { ...headers };
  delete nextHeaders.host;
  delete nextHeaders.authorization;
  nextHeaders.host = targetUrl.host;
  nextHeaders["x-forwarded-host"] = String(headers.host || "");
  nextHeaders["x-forwarded-proto"] = "https";
  return nextHeaders;
}

function rewriteLocationHeader(locationValue, targetUrl, request) {
  try {
    const nextUrl = new URL(locationValue, targetUrl);
    return `${getRequestOrigin(request)}${nextUrl.pathname}${nextUrl.search}`;
  } catch {
    return locationValue;
  }
}

function getRequestOrigin(request) {
  const forwardedProto = String(request.headers["x-forwarded-proto"] || "").trim();
  const protocol = forwardedProto || "http";
  return `${protocol}://${String(request.headers.host || "")}`;
}

function listRemoteAccessUrls(port) {
  return [`http://localhost:${port}/radio`, `http://127.0.0.1:${port}/radio`];
}

function resolveRemoteAccessPort() {
  const configuredPort = Number(getConfig().remoteAccessPort || 3443);
  return Number.isInteger(configuredPort) && configuredPort > 0 ? configuredPort : 3443;
}

function normalizeRemoteAddress(value) {
  const normalized = String(value || "").trim();
  return normalized.startsWith("::ffff:") ? normalized.slice(7) : normalized || "unknown";
}

function getContentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const contentTypes = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".ico": "image/x-icon",
    ".jfif": "image/jpeg",
    ".jpg": "image/jpeg",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8"
  };

  return contentTypes[extension] || "application/octet-stream";
}

function sendText(response, statusCode, message, headers = {}) {
  response.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    ...headers
  });
  response.end(message);
}

function formatError(error) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

module.exports = {
  restartRemoteAccessServer,
  startRemoteAccessServer,
  stopRemoteAccessServer
};
