const https = require("node:https");
const { decryptSecret } = require("./config-store");
const { getConfig } = require("./state");

const defaultVoiceId = "21m00Tcm4TlvDq8ikWAM";
const defaultModelId = "eleven_multilingual_v2";

async function synthesizeSpeech(text) {
  const config = getConfig();
  let storedApiKey = "";
  try {
    storedApiKey = decryptSecret(config.elevenLabsApiKeyEncrypted || config.elevenLabsApiKey);
  } catch {}

  const apiKey = String(process.env.ELEVENLABS_API_KEY || storedApiKey).trim();
  if (!apiKey) {
    throw new Error("ELEVENLABS_API_KEY is not configured. Re-enter it in `siylo` or set ELEVENLABS_API_KEY.");
  }

  const voiceId = String(
    process.env.ELEVENLABS_VOICE_ID ||
    config.elevenLabsVoiceId ||
    defaultVoiceId
  ).trim();
  const modelId = String(
    process.env.ELEVENLABS_MODEL_ID ||
    config.elevenLabsModelId ||
    defaultModelId
  ).trim();
  const payload = JSON.stringify({
    text: normalizeSpeechText(text),
    model_id: modelId,
    voice_settings: {
      stability: 0.45,
      similarity_boost: 0.78,
      style: 0.08,
      use_speaker_boost: true
    }
  });

  return requestSpeech({
    apiKey,
    path: `/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
    payload
  });
}

function requestSpeech({ apiKey, path, payload }) {
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        hostname: "api.elevenlabs.io",
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          "xi-api-key": apiKey
        }
      },
      (response) => {
        const chunks = [];

        response.on("data", (chunk) => {
          chunks.push(chunk);
        });
        response.once("end", () => {
          const body = Buffer.concat(chunks);

          if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(body.toString("utf8") || `ElevenLabs returned ${response.statusCode}.`));
            return;
          }

          resolve({
            audioBuffer: body,
            contentType: String(response.headers["content-type"] || "audio/mpeg")
          });
        });
      }
    );

    request.once("error", reject);
    request.end(payload);
  });
}

function normalizeSpeechText(text) {
  const normalized = String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!normalized) {
    throw new Error("Speech text cannot be empty.");
  }

  return normalized.slice(-1600);
}

module.exports = {
  synthesizeSpeech
};
