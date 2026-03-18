const crypto = require("node:crypto");

function hashSecret(secret) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(secret || ""), salt, 64).toString("hex");

  return {
    hash,
    salt
  };
}

function verifySecret(secret, expectedHash, salt) {
  if (!expectedHash || !salt) {
    return false;
  }

  const actualHash = crypto.scryptSync(String(secret || ""), salt, 64).toString("hex");
  return timingSafeCompare(expectedHash, actualHash);
}

function timingSafeCompare(left, right) {
  const leftBuffer = Buffer.from(String(left || ""), "utf8");
  const rightBuffer = Buffer.from(String(right || ""), "utf8");

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

module.exports = {
  hashSecret,
  timingSafeCompare,
  verifySecret
};
