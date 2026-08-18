"use strict";

importScripts("security/crypto.js");

/**
 * Personal Tab Locker - Background Service Worker (Manifest V3)
 * Manages central storage, tab lifecycle, PIN & recovery verification,
 * lockout enforcement, and message passing.
 */

// Exponential backoff configuration for brute-force protection
const LOCKOUT_RULES = [
  { failedThreshold: 5, lockoutSeconds: 30 },
  { failedThreshold: 10, lockoutSeconds: 120 },
  { failedThreshold: 15, lockoutSeconds: 300 }
];

/**
 * Returns current storage state.
 */
async function getStorageData() {
  return await chrome.storage.local.get([
    "initialized",
    "pinHash",
    "recoveryKeyHash",
    "salt",
    "failedAttempts",
    "lockoutUntil",
    "lockedTabs"
  ]);
}

/**
 * Calculates current lockout status based on timestamp.
 * @param {number} lockoutUntil Timestamp in ms
 * @returns {{ isLockedOut: boolean, remainingSeconds: number }}
 */
function getLockoutStatus(lockoutUntil) {
  if (!lockoutUntil) return { isLockedOut: false, remainingSeconds: 0 };
  const now = Date.now();
  if (now >= lockoutUntil) {
    return { isLockedOut: false, remainingSeconds: 0 };
  }
  const remainingSeconds = Math.ceil((lockoutUntil - now) / 1000);
  return { isLockedOut: true, remainingSeconds };
}

/**
 * Tab Lifecycle: Clean up locked storage state when a tab is closed.
 */
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { lockedTabs = {} } = await chrome.storage.local.get("lockedTabs");
  if (lockedTabs[tabId]) {
    delete lockedTabs[tabId];
    await chrome.storage.local.set({ lockedTabs });
  }
});

/**
 * Tab Lifecycle: Check lock status on tab navigation / update.
 */
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!tab || !tab.url) return;
  const url = tab.url.toLowerCase();

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

  if (changeInfo.status === "loading" || changeInfo.status === "complete" || changeInfo.url) {
    const { lockedTabs = {}, protectionEnabled } = await chrome.storage.local.get(["lockedTabs", "protectionEnabled"]);
    if (protectionEnabled === false) return;

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

    if (isLocked) {
      try {
        await chrome.tabs.sendMessage(tabId, { type: "SHOW_LOCK_SCREEN" });
      } catch (err) {}
    }
  }
});

/**
 * Helper to check if a URL is lockable by Chrome Extension rules.
 * chrome://, edge://, about:, extension pages cannot host content scripts.
 */
function isLockableUrl(url) {
  if (!url || typeof url !== "string") return false;
  return url.startsWith("http://") || url.startsWith("https://");
}

/**
 * Central Message Router
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((err) => sendResponse({ success: false, error: err.message }));
  return true; // Keep response channel open for async response
});

async function handleMessage(message, sender) {
  const type = message.type;
  const storage = await getStorageData();

  switch (type) {
    case "GET_SETTINGS_STATUS": {
      return {
        success: true,
        initialized: Boolean(storage.initialized)
      };
    }

    case "INITIALIZE_SECURITY": {
      if (storage.initialized) {
        return { success: false, error: "Extension is already initialized." };
      }
      const { pin, confirmPin } = message;
      if (!TabLockerCrypto.isValidPIN(pin)) {
        return { success: false, error: "PIN must be 4 to 8 digits (numbers only)." };
      }
      if (pin !== confirmPin) {
        return { success: false, error: "PINs do not match." };
      }

      const salt = TabLockerCrypto.generateSalt();
      const pinHash = await TabLockerCrypto.hashValue(pin, salt);

      const rawRecoveryKey = TabLockerCrypto.generateRecoveryKey();
      const recoveryKeyHash = await TabLockerCrypto.hashValue(rawRecoveryKey, salt);

      await chrome.storage.local.set({
        initialized: true,
        salt,
        pinHash,
        recoveryKeyHash,
        failedAttempts: 0,
        lockoutUntil: 0,
        lockedTabs: {}
      });

      return {
        success: true,
        recoveryKey: TabLockerCrypto.formatRecoveryKey(rawRecoveryKey)
      };
    }

    case "GET_TAB_INFO": {
      let targetTabId = message.tabId;
      let targetTab = null;

      if (targetTabId) {
        try {
          targetTab = await chrome.tabs.get(targetTabId);
        } catch (e) {
          // Tab not found
        }
      } else if (sender && sender.tab) {
        targetTab = sender.tab;
        targetTabId = sender.tab.id;
      } else {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        targetTab = activeTab;
        targetTabId = activeTab?.id;
      }

      if (!targetTab) {
        return { success: false, error: "Tab not found." };
      }

      const isSupported = isLockableUrl(targetTab.url);
      const lockedTabs = storage.lockedTabs || {};
      const isLocked = Boolean(lockedTabs[targetTabId]?.locked);

      let hostname = "";
      try {
        if (targetTab.url) {
          hostname = new URL(targetTab.url).hostname;
        }
      } catch (e) {
        hostname = targetTab.url || "";
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
      const lockedTabs = storage.lockedTabs || {};
      let isLocked = Boolean(lockedTabs[tabId]?.locked);

      if (!isLocked && sender?.tab?.url) {
        try {
          const senderHost = new URL(sender.tab.url).hostname;
          for (const data of Object.values(lockedTabs)) {
            if (data.locked && data.hostname && data.hostname === senderHost) {
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
      const tabId = message.tabId || sender?.tab?.id;
      if (!tabId) {
        return { success: false, error: "Target tab ID is missing." };
      }

      let tab = null;
      try {
        tab = await chrome.tabs.get(tabId);
      } catch (e) {
        return { success: false, error: "Tab does not exist." };
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

      const lockedTabs = storage.lockedTabs || {};
      lockedTabs[tabId] = {
        locked: true,
        hostname,
        title: tab.title || "Locked Tab",
        lockedAt: Date.now(),
        url: tab.url
      };

      await chrome.storage.local.set({ lockedTabs });

      try {
        await chrome.tabs.sendMessage(tabId, { type: "SHOW_LOCK_SCREEN" });
      } catch (e) {
        // Tab will pick up lock state on script injection or refresh
      }

      return { success: true, tabId };
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
        return { success: false, error: "PIN is required." };
      }

      const inputHash = await TabLockerCrypto.hashValue(pin, storage.salt);

      if (inputHash === storage.pinHash) {
        // Reset failed attempt counter on success
        await chrome.storage.local.set({ failedAttempts: 0, lockoutUntil: 0 });

        // If a specific tabId is passed or sender tab, unlock it
        const targetTabId = reqTabId || sender?.tab?.id;
        if (targetTabId && storage.lockedTabs && storage.lockedTabs[targetTabId]) {
          const lockedTabs = storage.lockedTabs;
          delete lockedTabs[targetTabId];
          await chrome.storage.local.set({ lockedTabs });

          try {
            await chrome.tabs.sendMessage(targetTabId, { type: "REMOVE_LOCK_SCREEN" });
          } catch (e) {}
        }

        return { success: true };
      } else {
        // Failed attempt handling & exponential backoff calculation
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

        if (lockoutSeconds > 0) {
          return {
            success: false,
            isLockedOut: true,
            remainingSeconds: lockoutSeconds,
            error: `Too many attempts. Try again in ${lockoutSeconds} seconds.`
          };
        }

        return {
          success: false,
          error: "Incorrect PIN",
          failedAttempts
        };
      }
    }

    case "VERIFY_RECOVERY": {
      const { recoveryKey } = message;
      const lockout = getLockoutStatus(storage.lockoutUntil);

      if (lockout.isLockedOut) {
        return {
          success: false,
          isLockedOut: true,
          remainingSeconds: lockout.remainingSeconds,
          error: `Too many attempts. Try again in ${lockout.remainingSeconds} seconds.`
        };
      }

      const cleanKey = TabLockerCrypto.cleanRecoveryKey(recoveryKey);
      if (!cleanKey) {
        return { success: false, error: "Recovery key is required." };
      }

      const keyHash = await TabLockerCrypto.hashValue(cleanKey, storage.salt);

      if (keyHash === storage.recoveryKeyHash) {
        await chrome.storage.local.set({ failedAttempts: 0, lockoutUntil: 0 });
        return { success: true };
      } else {
        const failedAttempts = (storage.failedAttempts || 0) + 1;
        let lockoutSeconds = 0;
        for (const rule of LOCKOUT_RULES) {
          if (failedAttempts >= rule.failedThreshold) {
            lockoutSeconds = rule.lockoutSeconds;
          }
        }
        const newLockoutUntil = lockoutSeconds > 0 ? Date.now() + lockoutSeconds * 1000 : 0;
        await chrome.storage.local.set({ failedAttempts, lockoutUntil: newLockoutUntil });

        if (lockoutSeconds > 0) {
          return {
            success: false,
            isLockedOut: true,
            remainingSeconds: lockoutSeconds,
            error: `Too many attempts. Try again in ${lockoutSeconds} seconds.`
          };
        }
        return { success: false, error: "Invalid recovery key." };
      }
    }

    case "SET_NEW_PIN_WITH_RECOVERY": {
      const { recoveryKey, newPin, confirmNewPin, tabId: reqTabId } = message;

      const cleanKey = TabLockerCrypto.cleanRecoveryKey(recoveryKey);
      const keyHash = await TabLockerCrypto.hashValue(cleanKey, storage.salt);

      if (keyHash !== storage.recoveryKeyHash) {
        return { success: false, error: "Invalid recovery key." };
      }

      if (!TabLockerCrypto.isValidPIN(newPin)) {
        return { success: false, error: "New PIN must be 4 to 8 digits (numbers only)." };
      }

      if (newPin !== confirmNewPin) {
        return { success: false, error: "New PINs do not match." };
      }

      const newPinHash = await TabLockerCrypto.hashValue(newPin, storage.salt);

      await chrome.storage.local.set({
        pinHash: newPinHash,
        failedAttempts: 0,
        lockoutUntil: 0
      });

      // Optionally unlock current target tab
      const targetTabId = reqTabId || sender?.tab?.id;
      if (targetTabId && storage.lockedTabs && storage.lockedTabs[targetTabId]) {
        const lockedTabs = storage.lockedTabs;
        delete lockedTabs[targetTabId];
        await chrome.storage.local.set({ lockedTabs });

        try {
          await chrome.tabs.sendMessage(targetTabId, { type: "REMOVE_LOCK_SCREEN" });
        } catch (e) {}
      }

      return { success: true };
    }

    case "CHANGE_PIN": {
      const { currentPin, newPin, confirmNewPin } = message;
      const inputHash = await TabLockerCrypto.hashValue(currentPin, storage.salt);

      if (inputHash !== storage.pinHash) {
        return { success: false, error: "Incorrect current PIN." };
      }

      if (!TabLockerCrypto.isValidPIN(newPin)) {
        return { success: false, error: "New PIN must be 4 to 8 digits (numbers only)." };
      }

      if (newPin !== confirmNewPin) {
        return { success: false, error: "New PINs do not match." };
      }

      const newPinHash = await TabLockerCrypto.hashValue(newPin, storage.salt);
      await chrome.storage.local.set({ pinHash: newPinHash });

      return { success: true };
    }

    case "REGENERATE_RECOVERY_KEY": {
      const { currentPin } = message;
      const inputHash = await TabLockerCrypto.hashValue(currentPin, storage.salt);

      if (inputHash !== storage.pinHash) {
        return { success: false, error: "Incorrect current PIN." };
      }

      const rawNewRecoveryKey = TabLockerCrypto.generateRecoveryKey();
      const newRecoveryKeyHash = await TabLockerCrypto.hashValue(rawNewRecoveryKey, storage.salt);

      await chrome.storage.local.set({ recoveryKeyHash: newRecoveryKeyHash });

      return {
        success: true,
        newRecoveryKey: TabLockerCrypto.formatRecoveryKey(rawNewRecoveryKey)
      };
    }

    case "GET_LOCKED_TABS": {
      const lockedTabs = storage.lockedTabs || {};
      const activeList = [];

      for (const [tabIdStr, data] of Object.entries(lockedTabs)) {
        if (data.locked) {
          activeList.push({
            tabId: parseInt(tabIdStr, 10),
            hostname: data.hostname,
            title: data.title,
            lockedAt: data.lockedAt
          });
        }
      }

      return { success: true, lockedTabs: activeList };
    }

    case "UNLOCK_ALL_TABS": {
      const { pin } = message;
      const inputHash = await TabLockerCrypto.hashValue(pin, storage.salt);

      if (inputHash !== storage.pinHash) {
        return { success: false, error: "Incorrect PIN." };
      }

      const lockedTabs = storage.lockedTabs || {};
      const tabIds = Object.keys(lockedTabs);

      await chrome.storage.local.set({ lockedTabs: {} });

      for (const idStr of tabIds) {
        const id = parseInt(idStr, 10);
        try {
          await chrome.tabs.sendMessage(id, { type: "REMOVE_LOCK_SCREEN" });
        } catch (e) {}
      }

      return { success: true };
    }

    case "RESET_EXTENSION": {
      const { pin } = message;
      const inputHash = await TabLockerCrypto.hashValue(pin, storage.salt);

      if (inputHash !== storage.pinHash) {
        return { success: false, error: "Incorrect PIN." };
      }

      const lockedTabs = storage.lockedTabs || {};
      const tabIds = Object.keys(lockedTabs);

      await chrome.storage.local.clear();

      for (const idStr of tabIds) {
        const id = parseInt(idStr, 10);
        try {
          await chrome.tabs.sendMessage(id, { type: "REMOVE_LOCK_SCREEN" });
        } catch (e) {}
      }

      return { success: true };
    }

    default:
      return { success: false, error: `Unknown message type: ${type}` };
  }
}