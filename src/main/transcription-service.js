const { decryptSecret } = require("./config-store");
const { getConfig } = require("./state");

const defaultModel = process.env.SIYLO_TRANSCRIBE_MODEL || "whisper-1";

function getOpenAiApiKey() {
  const environmentKey = String(process.env.OPENAI_API_KEY || "").trim();

  if (environmentKey) {
    return environmentKey;
  }

  const config = getConfig();
  return decryptSecret(config.openAIApiKeyEncrypted || config.openAIApiKey);
}

async function transcribeAudio({ audioBuffer, contentType, filename, prompt, transcript }) {
  const providedTranscript = String(transcript || "").trim();
  if (providedTranscript) {
    return providedTranscript;
  }

  if (!audioBuffer || audioBuffer.length === 0) {
    throw new Error("Audio payload is empty.");
  }

  const openAiApiKey = getOpenAiApiKey();
  if (!openAiApiKey) {
    throw new Error(
      "No transcription provider configured. Add an OpenAI API key in the dashboard, set OPENAI_API_KEY, or provide a transcript field."
    );
  }

  const formData = new FormData();
  formData.set("model", defaultModel);
  if (prompt) {
    formData.set("prompt", String(prompt));
  }
  formData.set(
    "file",
    new Blob([audioBuffer], { type: contentType || "application/octet-stream" }),
    filename || `voice-${Date.now()}.webm`
  );

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openAiApiKey}`
    },
    body: formData
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Transcription request failed (${response.status}): ${errorBody.slice(0, 240)}`);
  }

  const payload = await response.json();
  const nextTranscript = String(payload.text || "").trim();
  if (!nextTranscript) {
    throw new Error("Transcription provider returned an empty transcript.");
  }

  return nextTranscript;
}

function getTranscriptionProviderName() {
  if (getOpenAiApiKey()) {
    return `openai:${defaultModel}`;
  }

  return "unconfigured";
}

module.exports = {
  getTranscriptionProviderName,
  transcribeAudio
};
