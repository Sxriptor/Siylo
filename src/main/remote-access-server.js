const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const { URL } = require("node:url");
const {
  appendLog,
  getConfig,
  getStateSnapshot,
  setRemoteAccessState
} = require("./state");

let remoteAccessServer = null;
let currentOptions = null;

async function startRemoteAccessServer(options = {}) {
  currentOptions = {
    ...currentOptions,
    ...options
  };

  const config = getConfig();
  const port = resolveRemoteAccessPort();
  const localUrls = listRemoteAccessUrls(port);

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

  if (
    requestUrl.pathname === "/health" ||
    requestUrl.pathname === "/voice" ||
    requestUrl.pathname.startsWith("/sessions/")
  ) {
    await proxyRequest(request, response, buildVoiceProxyUrl(requestUrl));
    return;
  }

  if (currentOptions?.isDev) {
    await proxyRequest(request, response, buildRendererProxyUrl(requestUrl));
    return;
  }

  await serveStaticRequest(request, response, requestUrl);
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
