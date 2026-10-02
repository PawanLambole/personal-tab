"use strict";

importScripts("security/crypto.js");

/**
 * Personal Tab Locker - Background Service Worker
 * Manages tab lock state, rate limiting, and dual tabId + hostname matching.
 * Implements session unlock and reload auto-lock persistence.
 */

// In-memory transient session unlocks (cleared on tab reload or navigation)
const unlockedSessions = {};

// Brute-force exponential backoff lockout thresholds
const LOCKOUT_RULES = [
  { failedThreshold: 5, lockoutSeconds: 30 },
  { failedThreshold: 8, lockoutSeconds: 120 },
  { failedThreshold: 10, lockoutSeconds: 300 }
];

// Initialize extension default storage state on install
chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(["initialized", "protectionEnabled", "lockedTabs"]);
  if (!existing.initialized) {
    await chrome.storage.local.set({
      initialized: false,
      protectionEnabled: true,
      failedAttempts: 0,
      lockoutUntil: 0,
      lockedTabs: {},
      blockExtensionPage: false
    });
  }
});

/**
 * Tab Lifecycle: Clean up locked tabs record when closed.
 */
chrome.tabs.onRemoved.addListener(async (tabId) => {
  delete unlockedSessions[tabId];
  const { lockedTabs = {} } = await chrome.storage.local.get("lockedTabs");
  if (lockedTabs[tabId]) {
    delete lockedTabs[tabId];
    await chrome.storage.local.set({ lockedTabs });
  }
});

/**
 * Tab Lifecycle: Check lock status on tab navigation / update.
 * Clears transient session unlock on page reload to re-enforce lock screen.
 */
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!tab || !tab.url) return;
  const url = tab.url.toLowerCase();

  // Clear transient session unlock when page reloads or starts navigating
  if (changeInfo.status === "loading") {
    delete unlockedSessions[tabId];
  }

  // Optional Guard: Only block extension page if explicitly enabled in settings (default false)
  if (url.startsWith("chrome://extensions") || url.startsWith("chrome://settings")) {
    const { initialized, protectionEnabled, blockExtensionPage = false } = await chrome.storage.local.get([
      "initialized",
      "protectionEnabled",
      "blockExtensionPage"
    ]);

    if (initialized && protectionEnabled !== false && blockExtensionPage === true) {
      try {
        await chrome.tabs.remove(tabId);
      } catch (e) {}
      return;
    }
  }

  // Only check lock status when page navigation finishes loading
  if (changeInfo.status === "complete") {
    const { lockedTabs = {}, protectionEnabled } = await chrome.storage.local.get(["lockedTabs", "protectionEnabled"]);
    if (protectionEnabled === false) return;
    if (unlockedSessions[tabId]) return;

    let isLocked = Boolean(lockedTabs[tabId]?.locked);

    if (!isLocked && tab && tab.url) {
      try {
        const host = new URL(tab.url).hostname;
        for (const data of Object.values(lockedTabs)) {
          if (data.locked && data.hostname && data.hostname === host) {
            isLocked = true;
            break;
          }
        }
      } catch (e) {}
    }

    if (isLocked && isLockableUrl(tab.url)) {
      try {
        await chrome.tabs.sendMessage(tabId, { type: "SHOW_LOCK_SCREEN" });
      } catch (err) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId },
            files: ["content.js"]
          });
        } catch (scriptErr) {}
      }
    }
  }
});

/**
 * Helper to check if a URL is lockable by Chrome Extension rules.
 */
function isLockableUrl(url) {
  if (!url || typeof url !== "string") return false;
  return url.startsWith("http://") || url.startsWith("https://");
}

/**
 * Calculates current lockout status based on timestamp.
 */
function getLockoutStatus(lockoutUntil = 0) {
  const now = Date.now();
  if (lockoutUntil && lockoutUntil > now) {
    const remainingSeconds = Math.ceil((lockoutUntil - now) / 1000);
    return { isLockedOut: true, remainingSeconds };
  }
  return { isLockedOut: false, remainingSeconds: 0 };
}

/**
 * Message handler for extension components and content scripts.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((err) => {
      sendResponse({ success: false, error: err.message || "Background worker error." });
    });
  return true; // Keep async response channel open
});

async function handleMessage(message, sender) {
  const storage = await chrome.storage.local.get([
    "initialized",
    "protectionEnabled",
    "salt",
    "pinHash",
    "recoveryKeyHash",
    "failedAttempts",
    "lockoutUntil",
    "lockedTabs"
  ]);

  const type = message.type;

  switch (type) {
    case "GET_ACTIVE_TAB_INFO": {
      let tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tabs || tabs.length === 0) {
        tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      }
      const targetTab = tabs ? tabs[0] : null;

      if (!targetTab) {
        return { success: false, error: "No active tab detected." };
      }

      const targetTabId = targetTab.id;
      const isSupported = isLockableUrl(targetTab.url);
      const lockedTabs = storage.lockedTabs || {};
      
      let isLocked = Boolean(lockedTabs[targetTabId]?.locked);
      let hostname = "";
      try {
        if (targetTab.url) {
          hostname = new URL(targetTab.url).hostname;
        }
      } catch (e) {
        hostname = targetTab.url || "";
      }

      if (!isLocked && hostname) {
        for (const data of Object.values(lockedTabs)) {
          if (data.locked && data.hostname && data.hostname === hostname) {
            isLocked = true;
            break;
          }
        }
      }

      return {
        success: true,
        tabId: targetTabId,
        url: targetTab.url,
        hostname: hostname || "Internal Page",
        title: targetTab.title || "Untitled Tab",
        isSupported,
        isLocked
      };
    }

    case "CHECK_LOCK_STATUS": {
      if (storage.protectionEnabled === false) {
        return {
          success: true,
          isLocked: false,
          protectionEnabled: false
        };
      }

      const tabId = message.tabId || sender?.tab?.id;
      if (tabId && unlockedSessions[tabId]) {
        return {
          success: true,
          isLocked: false
        };
      }

      const { lockedTabs = {} } = await chrome.storage.local.get("lockedTabs");
      let isLocked = Boolean(lockedTabs[tabId]?.locked);

      const targetHost = message.hostname || (sender?.tab?.url ? new URL(sender.tab.url).hostname : "");
      if (!isLocked && targetHost) {
        try {
          for (const data of Object.values(lockedTabs)) {
            if (data.locked && data.hostname && data.hostname === targetHost) {
              isLocked = true;
              break;
            }
          }
        } catch (e) {}
      }

      const lockout = getLockoutStatus(storage.lockoutUntil);

      return {
        success: true,
        isLocked,
        isLockedOut: lockout.isLockedOut,
        remainingSeconds: lockout.remainingSeconds
      };
    }

    case "LOCK_TAB": {
      let tab = null;
      if (message.tabId) {
        try {
          tab = await chrome.tabs.get(message.tabId);
        } catch (e) {}
      }
      if (!tab) {
        let tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!tabs || tabs.length === 0) {
          tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        }
        tab = tabs ? tabs[0] : null;
      }

      if (!tab || !tab.id) {
        return { success: false, error: "No active tab detected." };
      }

      if (!isLockableUrl(tab.url)) {
        return { success: false, error: "This Chrome page cannot be locked by this extension." };
      }

      let hostname = "";
      try {
        hostname = new URL(tab.url).hostname;
      } catch (e) {
        hostname = tab.url;
      }

      delete unlockedSessions[tab.id];

      const { lockedTabs = {} } = await chrome.storage.local.get("lockedTabs");
      lockedTabs[tab.id] = {
        locked: true,
        hostname,
        title: tab.title || "Locked Tab",
        lockedAt: Date.now(),
        url: tab.url
      };

      await chrome.storage.local.set({ lockedTabs });

      try {
        await chrome.tabs.sendMessage(tab.id, { type: "SHOW_LOCK_SCREEN" });
      } catch (e) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ["content.js"]
          });
        } catch (scriptErr) {}
      }

      return { success: true, tabId: tab.id };
    }

    case "UNLOCK_TAB": {
      let tab = null;
      if (message.tabId) {
        try {
          tab = await chrome.tabs.get(message.tabId);
        } catch (e) {}
      }
      if (!tab) {
        let tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!tabs || tabs.length === 0) {
          tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        }
        tab = tabs ? tabs[0] : null;
      }

      if (!tab || !tab.id) {
        return { success: false, error: "No active tab detected." };
      }

      const inputPin = message.pin;
      const inputHash = await TabLockerCrypto.hashValue(inputPin, storage.salt);

      if (inputHash !== storage.pinHash) {
        return { success: false, error: "Incorrect password." };
      }

      let hostname = "";
      try {
        hostname = new URL(tab.url).hostname;
      } catch (e) {}

      const { lockedTabs = {} } = await chrome.storage.local.get("lockedTabs");
      delete lockedTabs[tab.id];
      delete unlockedSessions[tab.id];

      if (hostname) {
        for (const [idStr, data] of Object.entries(lockedTabs)) {
          if (data.hostname === hostname) {
            delete lockedTabs[idStr];
            delete unlockedSessions[parseInt(idStr, 10)];
          }
        }
      }

      await chrome.storage.local.set({ lockedTabs });

      try {
        await chrome.tabs.sendMessage(tab.id, { type: "REMOVE_LOCK_SCREEN" });
      } catch (e) {}

      return { success: true, tabId: tab.id };
    }

    case "VERIFY_PIN": {
      const { pin, tabId: reqTabId } = message;
      const lockout = getLockoutStatus(storage.lockoutUntil);

      if (lockout.isLockedOut) {
        return {
          success: false,
          isLockedOut: true,
          remainingSeconds: lockout.remainingSeconds,
          error: `Too many attempts. Try again in ${lockout.remainingSeconds} seconds.`
        };
      }

      if (!pin) {
        return { success: false, error: "Password is required." };
      }

      const inputHash = await TabLockerCrypto.hashValue(pin, storage.salt);

      if (inputHash === storage.pinHash) {
        await chrome.storage.local.set({ failedAttempts: 0, lockoutUntil: 0 });

        const targetTabId = reqTabId || sender?.tab?.id;
        if (targetTabId) {
          unlockedSessions[targetTabId] = true;
          try {
            await chrome.tabs.sendMessage(targetTabId, { type: "REMOVE_LOCK_SCREEN" });
          } catch (e) {}
        }

        return { success: true };
      } else {
        const failedAttempts = (storage.failedAttempts || 0) + 1;
        let newLockoutUntil = 0;
        let lockoutSeconds = 0;

        for (const rule of LOCKOUT_RULES) {
          if (failedAttempts >= rule.failedThreshold) {
            lockoutSeconds = rule.lockoutSeconds;
          }
        }

        if (lockoutSeconds > 0) {
          newLockoutUntil = Date.now() + lockoutSeconds * 1000;
        }

        await chrome.storage.local.set({
          failedAttempts,
          lockoutUntil: newLockoutUntil
        });

        const updatedLockout = getLockoutStatus(newLockoutUntil);

        return {
          success: false,
          isLockedOut: updatedLockout.isLockedOut,
          remainingSeconds: updatedLockout.remainingSeconds,
          error: updatedLockout.isLockedOut
            ? `Too many failed attempts. Locked out for ${updatedLockout.remainingSeconds} seconds.`
            : "Incorrect password."
        };
      }
    }

    case "VERIFY_RECOVERY": {
      const { recoveryKey } = message;
      if (!recoveryKey) {
        return { success: false, error: "Recovery key is required." };
      }

      const cleanKey = TabLockerCrypto.cleanRecoveryKey(recoveryKey);
      const inputHash = await TabLockerCrypto.hashValue(cleanKey, storage.salt);

      if (inputHash === storage.recoveryKeyHash) {
        return { success: true };
      } else {
        return { success: false, error: "Invalid recovery key." };
      }
    }

    case "SET_NEW_PIN_WITH_RECOVERY": {
      const { recoveryKey, newPin, confirmNewPin } = message;

      const cleanKey = TabLockerCrypto.cleanRecoveryKey(recoveryKey);
      const inputHash = await TabLockerCrypto.hashValue(cleanKey, storage.salt);

      if (inputHash !== storage.recoveryKeyHash) {
        return { success: false, error: "Recovery key verification failed." };
      }

      if (!TabLockerCrypto.isValidPassword(newPin)) {
        return { success: false, error: "New password must be at least 4 characters long." };
      }

      if (newPin !== confirmNewPin) {
        return { success: false, error: "Passwords do not match." };
      }

      const newPinHash = await TabLockerCrypto.hashValue(newPin, storage.salt);

      await chrome.storage.local.set({
        pinHash: newPinHash,
        failedAttempts: 0,
        lockoutUntil: 0
      });

      const targetTabId = sender?.tab?.id;
      if (targetTabId) {
        unlockedSessions[targetTabId] = true;
        try {
          await chrome.tabs.sendMessage(targetTabId, { type: "REMOVE_LOCK_SCREEN" });
        } catch (e) {}
      }

      return { success: true };
    }

    default:
      return { success: false, error: `Unknown message type: ${type}` };
  }
}