const {
  appendLog,
  getSession,
  getStateSnapshot
} = require("./state");
const {
  bringDesktopSessionToFront,
  hasDesktopSession,
  isDesktopTarget,
  killDesktopSession,
  normalizeDesktopTarget,
  openDesktopSession,
  sendKeyToDesktopSession,
  sendTextToDesktopSession
} = require("./desktop-session-manager");
const {
  createManagedSession,
  drainPendingOutput,
  hasManagedSession,
  killAllManagedSessions,
  killSession,
  sendKeyToSession,
  sendTextToSession
} = require("./session-manager");

const knownTargets = new Set(["browser", "cmd", "codex", "cursor", "kiro", "powershell", "vscode"]);

async function executeVoiceCommand({ requestedSessionId, transcript }) {
  const normalizedTranscript = normalizeWhitespace(transcript);
  if (!normalizedTranscript) {
    throw new Error("Transcript is empty.");
  }

  const plan = parseVoicePlan(normalizedTranscript, requestedSessionId);
  const openedTargets = new Map();
  const steps = [];
  let activeSessionId = normalizeSessionTarget(requestedSessionId) || "";
  let output = "";

  for (const step of plan) {
    if (step.type === "open") {
      const session = await openTarget(step.target);
      const normalizedTarget = normalizeSessionTarget(step.target);
      openedTargets.set(normalizedTarget, session.id);
      activeSessionId = session.id;
      steps.push(`open:${session.id}`);
      continue;
    }

    if (step.type === "send") {
      const hintedTarget = resolveHintedTarget(step.target, openedTargets, activeSessionId);
      const result = await sendTextToTarget(hintedTarget, step.text);
      activeSessionId = result.sessionId;
      output = result.output || output;
      steps.push(`send:${result.sessionId}`);
      continue;
    }

    if (step.type === "key") {
      const hintedTarget = resolveHintedTarget(step.target, openedTargets, activeSessionId);
      const result = await sendKeyToTarget(hintedTarget, step.keyName);
      activeSessionId = result.sessionId;
      output = result.output || output;
      steps.push(`key:${result.sessionId}:${step.keyName}`);
      continue;
    }

    if (step.type === "kill-all") {
      const killedCount = await killAllTargets();
      steps.push(`kill-all:${killedCount}`);
      continue;
    }

    if (step.type === "kill") {
      await killTarget(step.target);
      if (activeSessionId === normalizeSessionTarget(step.target)) {
        activeSessionId = "";
      }
      steps.push(`kill:${normalizeSessionTarget(step.target)}`);
      continue;
    }

    if (step.type === "front") {
      const hintedTarget = resolveHintedTarget(step.target, openedTargets, activeSessionId);
      await focusTarget(hintedTarget);
      activeSessionId = hintedTarget;
      steps.push(`front:${hintedTarget}`);
    }
  }

  return {
    output,
    route: steps.join(" -> "),
    sessionId: activeSessionId,
    status: "executed"
  };
}

async function openTarget(target) {
  const normalizedTarget = normalizeSessionTarget(target);
  if (!normalizedTarget) {
    throw new Error("Target is required.");
  }

  const managedAlias = parseManagedAlias(normalizedTarget);
  if (managedAlias) {
    if (hasManagedSession(normalizedTarget)) {
      return getSession(normalizedTarget);
    }

    appendLog("info", `Opening named managed session ${normalizedTarget} for voice routing.`);
    return createManagedSession(managedAlias.shell, {
      displayShell: managedAlias.shell,
      sessionId: normalizedTarget
    });
  }

  if (normalizedTarget === "codex") {
    if (hasManagedSession("codex")) {
      return getSession("codex");
    }

    appendLog("info", "Opening named codex runtime session.");
    const session = await createManagedSession("powershell", {
      displayShell: "codex",
      sessionId: "codex",
      startupCommand: "codex",
      startupDelayMs: 500
    });
    await delay(1200);
    drainPendingOutput("codex");
    return session;
  }

  if (normalizedTarget === "cmd" || normalizedTarget === "powershell") {
    appendLog("info", `Opening managed ${normalizedTarget} session for voice routing.`);
    return createManagedSession(normalizedTarget);
  }

  if (isDesktopTarget(normalizedTarget)) {
    appendLog("info", `Opening desktop target ${normalizedTarget} for voice routing.`);
    return openDesktopSession(normalizedTarget);
  }

  const existingSession = getSession(normalizedTarget);
  if (existingSession) {
    return existingSession;
  }

  throw new Error(`Unsupported target: ${target}`);
}

function parseVoicePlan(transcript, requestedSessionId) {
  const openAndRunMatch = transcript.match(/^open\s+([a-z0-9-]+)\s+and\s+(run|type|send)\s+([\s\S]+)$/i);
  if (openAndRunMatch) {
    return [
      { type: "open", target: openAndRunMatch[1] },
      { type: "send", target: openAndRunMatch[1], text: openAndRunMatch[3].trim() }
    ];
  }

  const runIntoTargetMatch = transcript.match(/^(run|type|send)\s+([\s\S]+?)\s+(?:in|to)\s+([a-z0-9-]+(?:-\d+)?)$/i);
  if (runIntoTargetMatch) {
    return [{ type: "send", target: runIntoTargetMatch[3], text: runIntoTargetMatch[2].trim() }];
  }

  const pressMatch = transcript.match(/^press\s+(\S+)(?:\s+(?:in|to)\s+([a-z0-9-]+(?:-\d+)?))?$/i);
  if (pressMatch) {
    return [{ type: "key", keyName: pressMatch[1], target: pressMatch[2] || requestedSessionId || "" }];
  }

  const frontMatch = transcript.match(/^(?:focus|front)\s+([a-z0-9-]+(?:-\d+)?)$/i);
  if (frontMatch) {
    return [{ type: "front", target: frontMatch[1] }];
  }

  if (/^kill\s+all$/i.test(transcript)) {
    return [{ type: "kill-all" }];
  }

  const killMatch = transcript.match(/^kill\s+([a-z0-9-]+(?:-\d+)?)$/i);
  if (killMatch) {
    return [{ type: "kill", target: killMatch[1] }];
  }

  const openMatch = transcript.match(/^open\s+([a-z0-9-]+)$/i);
  if (openMatch) {
    return [{ type: "open", target: openMatch[1] }];
  }

  if (requestedSessionId) {
    return [{ type: "send", target: requestedSessionId, text: stripLeadingVerb(transcript) }];
  }

  const inferredTarget = inferTargetFromTranscript(transcript);
  return [{ type: "send", target: inferredTarget, text: stripLeadingVerb(transcript) }];
}

async function sendTextToTarget(target, text) {
  const resolvedTarget = await resolveTarget(target);
  const nextText = normalizeTargetText(resolvedTarget, text);

  if (hasManagedSession(resolvedTarget)) {
    await sendTextToSession(resolvedTarget, nextText);
    await delay(600);
    return {
      output: drainPendingOutput(resolvedTarget),
      sessionId: resolvedTarget
    };
  }

  if (hasDesktopSession(resolvedTarget)) {
    await sendTextToDesktopSession(resolvedTarget, nextText);
    return {
      output: "",
      sessionId: resolvedTarget
    };
  }

  throw new Error(`Unsupported session target: ${resolvedTarget}`);
}

async function sendKeyToTarget(target, keyName) {
  const resolvedTarget = await resolveTarget(target);

  if (hasManagedSession(resolvedTarget)) {
    await sendKeyToSession(resolvedTarget, keyName);
    await delay(250);
    return {
      output: drainPendingOutput(resolvedTarget),
      sessionId: resolvedTarget
    };
  }

  if (hasDesktopSession(resolvedTarget)) {
    await sendKeyToDesktopSession(resolvedTarget, keyName);
    return {
      output: "",
      sessionId: resolvedTarget
    };
  }

  throw new Error(`Unsupported key target: ${resolvedTarget}`);
}

async function focusTarget(target) {
  const resolvedTarget = await resolveTarget(target);

  if (hasDesktopSession(resolvedTarget)) {
    await bringDesktopSessionToFront(resolvedTarget);
    return;
  }

  if (hasManagedSession(resolvedTarget)) {
    return;
  }

  throw new Error(`Unsupported focus target: ${resolvedTarget}`);
}

async function killTarget(target) {
  const resolvedTarget = normalizeSessionTarget(target);
  if (hasManagedSession(resolvedTarget)) {
    await killSession(resolvedTarget);
    return;
  }

  if (hasDesktopSession(resolvedTarget)) {
    await killDesktopSession(resolvedTarget);
    return;
  }

  throw new Error(`Session not found: ${target}`);
}

async function killAllTargets() {
  let killedCount = 0;
  const killedManagedSessions = await killAllManagedSessions();
  killedCount += killedManagedSessions.length;

  const desktopSessions = getStateSnapshot().sessions.filter(
    (session) => isDesktopTarget(session.id) && hasDesktopSession(session.id)
  );
  for (const session of desktopSessions) {
    await killDesktopSession(session.id);
    killedCount += 1;
  }

  return killedCount;
}

async function resolveTarget(target) {
  const normalizedTarget = normalizeSessionTarget(target);
  if (!normalizedTarget) {
    throw new Error("No target session available for this command.");
  }

  if (hasManagedSession(normalizedTarget) || hasDesktopSession(normalizedTarget)) {
    return normalizedTarget;
  }

  if (
    normalizedTarget === "codex" ||
    normalizedTarget === "cmd" ||
    normalizedTarget === "powershell" ||
    parseManagedAlias(normalizedTarget)
  ) {
    const session = await openTarget(normalizedTarget);
    return session.id;
  }

  if (isDesktopTarget(normalizedTarget)) {
    const session = await openTarget(normalizedTarget);
    return session.id;
  }

  const existingSession = getSession(normalizedTarget);
  if (existingSession && (hasManagedSession(existingSession.id) || hasDesktopSession(existingSession.id))) {
    return existingSession.id;
  }

  throw new Error(`Session not found: ${target}`);
}

function resolveHintedTarget(target, openedTargets, activeSessionId) {
  const normalizedTarget = normalizeSessionTarget(target);
  if (normalizedTarget && openedTargets.has(normalizedTarget)) {
    return openedTargets.get(normalizedTarget);
  }

  return normalizedTarget || activeSessionId;
}

function inferTargetFromTranscript(transcript) {
  const normalizedTranscript = transcript.toLowerCase();
  const openTargetMatch = normalizedTranscript.match(/^open\s+([a-z0-9-]+)/);
  if (openTargetMatch && knownTargets.has(normalizeSessionTarget(openTargetMatch[1]))) {
    return normalizeSessionTarget(openTargetMatch[1]);
  }

  const desktopTargetMatch = normalizedTranscript.match(/\b(cursor|vscode|code|kiro|browser|chrome|edge)\b/i);
  if (desktopTargetMatch) {
    return normalizeSessionTarget(desktopTargetMatch[1]);
  }

  if (/\b(codex|explain|debug|refactor|fix|review)\b/i.test(normalizedTranscript)) {
    return "codex";
  }

  return "powershell";
}

function normalizeSessionTarget(target) {
  const normalizedTarget = normalizeDesktopTarget(target);
  if (!normalizedTarget) {
    return "";
  }

  if (normalizedTarget === "shell" || normalizedTarget === "terminal") {
    return "powershell";
  }

  return normalizedTarget;
}

function parseManagedAlias(target) {
  const normalizedTarget = String(target || "").trim().toLowerCase();
  const match = normalizedTarget.match(/^(cmd|powershell)-\d+$/);
  if (!match) {
    return null;
  }

  return {
    shell: match[1],
    sessionId: normalizedTarget
  };
}

function normalizeTargetText(target, text) {
  const normalizedText = String(text || "").trim();
  if (target !== "codex") {
    return normalizedText;
  }

  return normalizedText.replace(/^codex\s+/i, "").trim() || normalizedText;
}

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function stripLeadingVerb(value) {
  return normalizeWhitespace(value).replace(/^(run|type|send)\s+/i, "").trim();
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

module.exports = {
  executeVoiceCommand,
  inferTargetFromTranscript,
  openTarget
};
