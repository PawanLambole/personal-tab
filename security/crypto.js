"use strict";

/**
 * Personal Tab Locker - Cryptography and Security Utilities
 * Uses Web Crypto API for secure hashing, PBKDF2 key derivation, and random value generation.
 * All computations stay strictly local to the user's browser.
 */

var TabLockerCrypto = (function () {
  const PBKDF2_ITERATIONS = 100000;

  /**
   * Generates a cryptographically secure random salt hex string.
   * @returns {string} 32-character hex salt string
   */
  function generateSalt() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes)
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");
  }

  /**
   * Derives a cryptographic key using PBKDF2-HMAC-SHA256.
   * @param {string} password Plaintext password
   * @param {string} saltHex 32-char hex salt
   * @param {number} iterations Iteration count
   * @returns {Promise<string>} Hex representation of derived 256-bit key
   */
  async function derivePBKDF2(password, saltHex, iterations = PBKDF2_ITERATIONS) {
    if (typeof password !== "string" || !password.trim()) return "";
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      enc.encode(password.trim()),
      { name: "PBKDF2" },
      false,
      ["deriveBits"]
    );

    // Convert hex salt to Uint8Array safely
    let saltBytes;
    try {
      const matches = saltHex.match(/.{1,2}/g) || [];
      saltBytes = new Uint8Array(matches.map(byte => parseInt(byte, 16)));
      if (saltBytes.length === 0) saltBytes = enc.encode(saltHex || "ptl-default-salt");
    } catch (e) {
      saltBytes = enc.encode(saltHex || "ptl-default-salt");
    }

    const derivedBits = await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt: saltBytes,
        iterations: iterations,
        hash: "SHA-256"
      },
      keyMaterial,
      256
    );

    return Array.from(new Uint8Array(derivedBits))
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");
  }

  /**
   * Hashes a password using PBKDF2 with salt.
   * @param {string} password Plaintext password
   * @param {string} salt Salt string
   * @returns {Promise<string>} Format: pbkdf2:<iterations>:<hexDigest>
   */
  async function hashPassword(password, salt = "") {
    if (!password || !password.trim()) return "";
    const digest = await derivePBKDF2(password, salt, PBKDF2_ITERATIONS);
    return `pbkdf2:${PBKDF2_ITERATIONS}:${digest}`;
  }

  /**
   * Verifies a password against a stored hash (supports both PBKDF2 and legacy SHA-256).
   * @param {string} password Plaintext password to verify
   * @param {string} storedHash Stored hash string
   * @param {string} salt Salt string
   * @returns {Promise<boolean>}
   */
  async function verifyPassword(password, storedHash, salt = "") {
    if (!password || !storedHash) return false;

    if (storedHash.startsWith("pbkdf2:")) {
      const parts = storedHash.split(":");
      const iterations = parseInt(parts[1], 10) || PBKDF2_ITERATIONS;
      const expected = parts[2];
      const computed = await derivePBKDF2(password, salt, iterations);
      return computed === expected;
    }

    // Legacy SHA-256 fallback for existing installations
    const legacy = await hashValue(password, salt);
    return legacy === storedHash;
  }

  /**
   * Hashes a secret value with a salt using SHA-256 (used for recovery keys and backward compatibility).
   * @param {string} value Plaintext value to hash
   * @param {string} salt Salt string
   * @returns {Promise<string>} Hex representation of SHA-256 hash
   */
  async function hashValue(value, salt = "") {
    if (typeof value !== "string" || !value.trim()) {
      return "";
    }

    const dataToHash = `${salt}:${value.trim()}`;
    const encoder = new TextEncoder();
    const dataBuffer = encoder.encode(dataToHash);
    const hashBuffer = await crypto.subtle.digest("SHA-256", dataBuffer);

    return Array.from(new Uint8Array(hashBuffer))
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");
  }

  /**
   * Validates if a password satisfies security rules (any combination, min 4 characters).
   * @param {string} password Input string
   * @returns {boolean}
   */
  function isValidPassword(password) {
    if (typeof password !== "string") return false;
    return password.trim().length >= 4;
  }

  /**
   * Alias for backward compatibility
   */
  function isValidPIN(pin) {
    return isValidPassword(pin);
  }

  /**
   * Generates a cryptographically secure recovery key.
   * Format: 24 uppercase hexadecimal characters (12 random bytes).
   * @returns {string} Plaintext recovery key (shown to user ONCE upon creation)
   */
  function generateRecoveryKey() {
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    return Array.from(bytes)
      .map(b => b.toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase();
  }

  /**
   * Formats a raw 24-char hex recovery key into human-readable 4-char groups.
   * Example: A81F29C04E77B13D91AB44C2 -> A81F-29C0-4E77-B13D-91AB-44C2
   * @param {string} key
   * @returns {string}
   */
  function formatRecoveryKey(key) {
    const clean = cleanRecoveryKey(key);
    if (!clean) return "";
    return clean.match(/.{1,4}/g)?.join("-") || clean;
  }

  /**
   * Cleans input recovery key by removing spaces, hyphens, and converting to uppercase.
   * @param {string} key
   * @returns {string}
   */
  function cleanRecoveryKey(key) {
    if (typeof key !== "string") return "";
    return key.replace(/[\s\-]/g, "").toUpperCase();
  }

  return {
    generateSalt,
    derivePBKDF2,
    hashPassword,
    verifyPassword,
    hashValue,
    isValidPassword,
    isValidPIN,
    generateRecoveryKey,
    formatRecoveryKey,
    cleanRecoveryKey
  };
})();

if (typeof globalThis !== "undefined") {
  globalThis.TabLockerCrypto = TabLockerCrypto;
}