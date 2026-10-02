"use strict";

importScripts("security/crypto.js");

/**
 * Personal Tab Locker - Background Service Worker
 * Manages tab lock state, rate limiting, and dual tabId + hostname matching.
 * Implements session unlock and reload auto-lock persistence.
 */

// In-memory transient session unlocks (cleared on actual page reload or navigation away)
// Maps tabId -> hostname of unlocked site
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
 * Tab Lifecycle: Clean up transient unlocked session state when a tab is closed.
 * NOTE: lockedTabs is PERSISTENT and MUST NOT be deleted here!
 * This ensures locked tabs and domains remain permanently protected across browser sessions and re-opens.
 */
chrome.tabs.onRemoved.addListener((tabId) => {
  delete unlockedSessions[tabId];
});

/**
 * Tab Lifecycle: Guard against chrome://extensions access if configured.
 * Does NOT clear session unlock or spam SHOW_LOCK_SCREEN on SPA events (like in ChatGPT/YouTube),
 * which would cause glitchy reload loops.
 */
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!tab || !tab.url) return;
  const url = tab.url.toLowerCase();

  // Guard: Block extension and settings pages if explicitly enabled in settings
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
    }
    return;
  }

  // Handle SPA in-page navigation (e.g. switching between chats in ChatGPT)
  if (changeInfo.url) {
    const { protectionEnabled, lockedTabs = {}, lockoutUntil = 0 } = await chrome.storage.local.get([
      "protectionEnabled",
      "lockedTabs",
      "lockoutUntil"
    ]);

    if (protectionEnabled === false) return;

    let hostname = "";
    try {
      hostname = new URL(changeInfo.url).hostname;
    } catch (e) {}

    const targetNorm = hostname ? hostname.toLowerCase().replace(/^www\./, "") : "";
    let isDomainLocked = false;
    for (const data of Object.values(lockedTabs)) {
      const dataNorm = data.hostname ? data.hostname.toLowerCase().replace(/^www\./, "") : "";
      if (data.locked && dataNorm === targetNorm) {
        isDomainLocked = true;
        break;
      }
    }

    if (isDomainLocked) {
      const session = unlockedSessions[tabId];
      const sessionUrl = typeof session === "object" ? session.url : "";
      const sessionKey = getConversationKey(sessionUrl);
      const newKey = getConversationKey(changeInfo.url);

      // If user navigated to a different conversation/chat path, lock the tab again!
      if (!session || (sessionKey && newKey && sessionKey !== newKey)) {
        delete unlockedSessions[tabId];

        const lockout = getLockoutStatus(lockoutUntil);
        try {
          await chrome.tabs.sendMessage(tabId, {
            type: "SHOW_LOCK_SCREEN",
            lockStatus: { isLocked: true, ...lockout }
          });
        } catch (e) {}
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
 * Normalizes a URL to a distinct conversation or page key.
 * Strips query parameters and hash fragments so switching chats in SPAs like ChatGPT
 * (e.g. /c/uuid-1 to /c/uuid-2) triggers a distinct key, while scrolling or typing in the same chat does not.
 */
function getConversationKey(urlStr) {
  if (!urlStr || typeof urlStr !== "string") return "";
  try {
    const u = new URL(urlStr);
    const hostNorm = u.hostname.toLowerCase().replace(/^www\./, "");
    const pathNorm = u.pathname.replace(/\/+$/, "");
    return `${hostNorm}${pathNorm}`;
  } catch (e) {
    return urlStr;
  }
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

      const targetNorm = hostname ? hostname.toLowerCase().replace(/^www\./, "") : "";
      if (!isLocked && targetNorm) {
        for (const data of Object.values(lockedTabs)) {
          const dataNorm = data.hostname ? data.hostname.toLowerCase().replace(/^www\./, "") : "";
          if (data.locked && dataNorm === targetNorm) {
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
      const targetHost = message.hostname || (sender?.tab?.url ? new URL(sender.tab.url).hostname : "");

      // If an actual page reload occurred, clear transient session unlock
      if (message.isReload && tabId) {
        delete unlockedSessions[tabId];
      }

      // Check if session is already unlocked for this tab and host
      if (tabId && unlockedSessions[tabId]) {
        const session = unlockedSessions[tabId];
        const sessionHost = typeof session === "object" ? session.host : session;
        const sessionUrl = typeof session === "object" ? session.url : "";

        const currentUrl = message.url || (sender?.tab?.url ? sender.tab.url : "");
        const sessionKey = getConversationKey(sessionUrl);
        const currentKey = getConversationKey(currentUrl);

        if (sessionKey && currentKey && sessionKey !== currentKey) {
          delete unlockedSessions[tabId];
        } else if (sessionHost === true || !targetHost || sessionHost === targetHost) {
          return {
            success: true,
            isLocked: false
          };
        }
      }

      const { lockedTabs = {} } = await chrome.storage.local.get("lockedTabs");
      let isLocked = Boolean(lockedTabs[tabId]?.locked);

      const targetNorm = targetHost ? targetHost.toLowerCase().replace(/^www\./, "") : "";

      if (!isLocked && targetNorm) {
        try {
          for (const data of Object.values(lockedTabs)) {
            const dataNorm = data.hostname ? data.hostname.toLowerCase().replace(/^www\./, "") : "";
            if (data.locked && dataNorm === targetNorm) {
              isLocked = true;
              break;
            }
          }
        } catch (e) {}
      }

      // If domain is locked and this reopened tab doesn't have an entry yet, associate it
      if (isLocked && tabId && !lockedTabs[tabId]) {
        lockedTabs[tabId] = {
          locked: true,
          hostname: targetHost,
          title: sender?.tab?.title || targetHost,
          url: sender?.tab?.url || "",
          lockedAt: Date.now()
        };
        await chrome.storage.local.set({ lockedTabs });
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
        let tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tabs || tabs.length === 0) {
          tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
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
        title: tab.title || hostname || "Locked Tab",
        lockedAt: Date.now(),
        url: tab.url
      };

      await chrome.storage.local.set({ lockedTabs });

      const lockout = getLockoutStatus(storage.lockoutUntil);
      const lockPayload = {
        type: "SHOW_LOCK_SCREEN",
        lockStatus: { isLocked: true, ...lockout }
      };

      try {
        await chrome.tabs.sendMessage(tab.id, lockPayload);
      } catch (e) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ["content.js"]
          });
          setTimeout(async () => {
            try {
              await chrome.tabs.sendMessage(tab.id, lockPayload);
            } catch (err) {}
          }, 60);
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
        let tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tabs || tabs.length === 0) {
          tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
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
        let host = "";
        try {
          if (sender?.tab?.url) host = new URL(sender.tab.url).hostname;
        } catch (e) {}

        if (targetTabId) {
          const currentUrl = message.url || sender?.tab?.url || "";
          unlockedSessions[targetTabId] = {
            host: host || true,
            url: currentUrl
          };

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
      let host = "";
      try {
        if (sender?.tab?.url) host = new URL(sender.tab.url).hostname;
      } catch (e) {}

      if (targetTabId) {
        const currentUrl = message.url || sender?.tab?.url || "";
        unlockedSessions[targetTabId] = {
          host: host || true,
          url: currentUrl
        };

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