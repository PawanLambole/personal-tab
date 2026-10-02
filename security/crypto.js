"use strict";

/**
 * Personal Tab Locker - Cryptography and Security Utilities
 * Uses Web Crypto API for secure hashing and random value generation.
 * All computations stay strictly local to the user's browser.
 */

var TabLockerCrypto = (function () {
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
   * Hashes a secret value (Password or Recovery Key) with a salt using SHA-256.
   * Safely returns empty string if input is empty/invalid.
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