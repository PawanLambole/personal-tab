"use strict";

/**
 * Personal Tab Locker - Popup UI Script
 * Direct, resilient interface for tab locking, Master Protection toggle, and password setup.
 */

document.addEventListener("DOMContentLoaded", async () => {
  const statusAlert = document.getElementById("status-alert");
  const viewSetup = document.getElementById("view-setup");
  const viewMain = document.getElementById("view-main");
  const btnOptionsGear = document.getElementById("btn-options-gear");
  const btnOpenOptions = document.getElementById("btn-open-options");

  // Master Switch Elements
  const chkMasterToggle = document.getElementById("chk-master-toggle");
  const masterStatusText = document.getElementById("master-status-text");
  const masterDisabledBanner = document.getElementById("master-disabled-banner");

  // Setup View Elements
  const setupForm = document.getElementById("setup-form");
  const setupPin = document.getElementById("setup-pin");
  const setupConfirmPin = document.getElementById("setup-confirm-pin");
  const btnGenerateKey = document.getElementById("btn-generate-key");
  const recoveryContainer = document.getElementById("recovery-display-container");
  const recoveryKeyInput = document.getElementById("recovery-key-input");
  const btnCopyKey = document.getElementById("btn-copy-key");
  const chkConfirmSaved = document.getElementById("chk-confirm-saved");
  const btnCompleteSetup = document.getElementById("btn-complete-setup");

  // Active Tab View Elements
  const tabStatusBadge = document.getElementById("tab-status-badge");
  const tabTitle = document.getElementById("tab-title");
  const tabHostname = document.getElementById("tab-hostname");
  const unsupportedBanner = document.getElementById("unsupported-banner");
  const btnLockTab = document.getElementById("btn-lock-tab");
  const btnUnlockTab = document.getElementById("btn-unlock-tab");

  let activeTabId = null;
  let activeTabObject = null;
  let rawGeneratedRecoveryKey = "";

  // Navigation to Options Page
  const openOptionsPage = () => {
    try {
      if (chrome.runtime.openOptionsPage) {
        chrome.runtime.openOptionsPage(() => {
          if (chrome.runtime.lastError) {
            chrome.tabs.create({ url: chrome.runtime.getURL("options/options.html") });
          }
        });
      } else {
        chrome.tabs.create({ url: chrome.runtime.getURL("options/options.html") });
      }
    } catch (e) {
      chrome.tabs.create({ url: chrome.runtime.getURL("options/options.html") });
    }
  };

  btnOptionsGear.addEventListener("click", openOptionsPage);
  btnOpenOptions.addEventListener("click", openOptionsPage);

  // Storage listener to update UI live
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local") {
      if (changes.protectionEnabled !== undefined) {
        updateMasterSwitchUI(changes.protectionEnabled.newValue !== false);
      }
      if (changes.lockedTabs !== undefined) {
        loadActiveTabInfo();
      }
    }
  });

  // Initialize view state
  await checkInitialization();

  async function checkInitialization() {
    try {
      const storage = await chrome.storage.local.get(["initialized", "protectionEnabled"]);
      if (storage && storage.initialized) {
        viewSetup.classList.add("hidden");
        viewMain.classList.remove("hidden");

        const protectionEnabled = storage.protectionEnabled !== false;
        updateMasterSwitchUI(protectionEnabled);

        await loadActiveTabInfo();
      } else {
        viewSetup.classList.remove("hidden");
        viewMain.classList.add("hidden");
      }
    } catch (err) {
      showAlert("Error loading storage state.", "danger");
    }
  }

  function updateMasterSwitchUI(enabled) {
    chkMasterToggle.checked = enabled;
    if (enabled) {
      masterStatusText.textContent = "🛡️ Protection Active (ON)";
      masterStatusText.className = "master-status-on";
      masterDisabledBanner.classList.add("hidden");
    } else {
      masterStatusText.textContent = "⏸️ Protection Paused (OFF)";
      masterStatusText.className = "master-status-off";
      masterDisabledBanner.classList.remove("hidden");
    }
  }

  // Master Switch Toggle Event
  chkMasterToggle.addEventListener("change", async () => {
    const isAttemptingTurnOff = !chkMasterToggle.checked;

    if (isAttemptingTurnOff) {
      // Revert UI until password is verified
      chkMasterToggle.checked = true;

      const pin = prompt("Enter your password to turn Master Protection OFF:");
      if (pin === null || !pin.trim()) return; // Cancelled or empty

      const storage = await chrome.storage.local.get(["salt", "pinHash"]);
      const inputHash = await TabLockerCrypto.hashValue(pin, storage.salt);

      if (inputHash && inputHash === storage.pinHash) {
        await chrome.storage.local.set({ protectionEnabled: false });
        updateMasterSwitchUI(false);
        showAlert("⏸️ Master Protection turned OFF. Tab locks paused.", "success");
        setTimeout(hideAlert, 2500);
      } else {
        showAlert("Incorrect password. Master Protection remains active.", "danger");
      }
    } else {
      // Turning ON
      await chrome.storage.local.set({ protectionEnabled: true });
      updateMasterSwitchUI(true);
      showAlert("🛡️ Master Protection re-enabled!", "success");
      setTimeout(hideAlert, 2000);
    }
  });

  // First-Time Setup Logic
  btnGenerateKey.addEventListener("click", () => {
    rawGeneratedRecoveryKey = TabLockerCrypto.generateRecoveryKey();
    recoveryKeyInput.value = TabLockerCrypto.formatRecoveryKey(rawGeneratedRecoveryKey);
    recoveryContainer.classList.remove("hidden");
    btnGenerateKey.classList.add("hidden");
  });

  btnCopyKey.addEventListener("click", async () => {
    if (!recoveryKeyInput.value) return;
    try {
      await navigator.clipboard.writeText(recoveryKeyInput.value);
      btnCopyKey.textContent = "Copied!";
      setTimeout(() => {
        btnCopyKey.textContent = "Copy";
      }, 2000);
    } catch (e) {
      showAlert("Failed to copy to clipboard.", "danger");
    }
  });

  chkConfirmSaved.addEventListener("change", () => {
    btnCompleteSetup.disabled = !chkConfirmSaved.checked;
  });

  setupForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    hideAlert();

    const pin = setupPin.value.trim();
    const confirmPin = setupConfirmPin.value.trim();

    if (!TabLockerCrypto.isValidPassword(pin)) {
      showAlert("Password must be at least 4 characters long.", "danger");
      return;
    }

    if (pin !== confirmPin) {
      showAlert("Passwords do not match.", "danger");
      return;
    }

    if (!chkConfirmSaved.checked || !rawGeneratedRecoveryKey) {
      showAlert("Please generate and save your recovery key before continuing.", "danger");
      return;
    }

    try {
      const salt = TabLockerCrypto.generateSalt();
      const pinHash = await TabLockerCrypto.hashValue(pin, salt);
      const recoveryKeyHash = await TabLockerCrypto.hashValue(rawGeneratedRecoveryKey, salt);

      await chrome.storage.local.set({
        initialized: true,
        protectionEnabled: true,
        salt,
        pinHash,
        recoveryKeyHash,
        failedAttempts: 0,
        lockoutUntil: 0,
        lockedTabs: {}
      });

      showAlert("✓ Security setup complete!", "success");
      setTimeout(async () => {
        hideAlert();
        await checkInitialization();
      }, 800);
    } catch (err) {
      showAlert("Error completing setup.", "danger");
    }
  });

  // Active Tab View Logic
  async function loadActiveTabInfo() {
    try {
      let tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tabs || tabs.length === 0) {
        tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      }
      const currentTab = tabs ? tabs[0] : null;

      if (!currentTab) {
        showAlert("No active tab detected.", "danger");
        return;
      }

      activeTabObject = currentTab;
      activeTabId = currentTab.id;

      tabTitle.textContent = currentTab.title || "Untitled Tab";

      let hostname = "";
      try {
        if (currentTab.url) {
          hostname = new URL(currentTab.url).hostname;
        }
      } catch (e) {
        hostname = currentTab.url || "";
      }
      tabHostname.textContent = hostname || "Internal Page";

      const isSupported = Boolean(
        currentTab.url && (currentTab.url.startsWith("http://") || currentTab.url.startsWith("https://"))
      );

      if (!isSupported) {
        unsupportedBanner.classList.remove("hidden");
        btnLockTab.classList.add("hidden");
        btnUnlockTab.classList.add("hidden");
        tabStatusBadge.classList.add("hidden");
        return;
      }

      unsupportedBanner.classList.add("hidden");
      tabStatusBadge.classList.remove("hidden");

      // Verify lock state with background worker
      const statusRes = await chrome.runtime.sendMessage({
        type: "CHECK_LOCK_STATUS",
        tabId: activeTabId,
        hostname
      });

      const isLocked = Boolean(statusRes && statusRes.isLocked);
      updateLockStatusState(isLocked);
    } catch (err) {
      showAlert("Error reading tab information.", "danger");
    }
  }

  function updateLockStatusState(isLocked) {
    if (isLocked) {
      tabStatusBadge.textContent = "🔒 Locked";
      tabStatusBadge.className = "badge badge-locked";
      btnLockTab.classList.add("hidden");
      btnUnlockTab.classList.remove("hidden");
    } else {
      tabStatusBadge.textContent = "🔓 Unlocked";
      tabStatusBadge.className = "badge badge-unlocked";
      btnLockTab.classList.remove("hidden");
      btnUnlockTab.classList.add("hidden");
    }
  }

  btnLockTab.addEventListener("click", async () => {
    if (!activeTabId) return;

    try {
      const response = await chrome.runtime.sendMessage({
        type: "LOCK_TAB",
        tabId: activeTabId
      });

      if (response && response.success) {
        updateLockStatusState(true);
        showAlert("🔒 Tab locked successfully!", "success");
        setTimeout(hideAlert, 2000);
      } else {
        showAlert(response?.error || "Error locking tab.", "danger");
      }
    } catch (err) {
      showAlert("Error locking tab.", "danger");
    }
  });

  btnUnlockTab.addEventListener("click", async () => {
    if (!activeTabId) return;

    const pin = prompt("Enter your password to unlock this tab:");
    if (pin === null || !pin.trim()) return; // Cancelled or empty

    try {
      const response = await chrome.runtime.sendMessage({
        type: "UNLOCK_TAB",
        tabId: activeTabId,
        pin: pin.trim()
      });

      if (response && response.success) {
        updateLockStatusState(false);
        showAlert("🔓 Tab unlocked!", "success");
        setTimeout(hideAlert, 2000);
      } else {
        showAlert(response?.error || "Incorrect password.", "danger");
      }
    } catch (err) {
      showAlert("Error unlocking tab.", "danger");
    }
  });

  function showAlert(msg, type = "danger") {
    statusAlert.textContent = msg;
    statusAlert.className = `alert alert-${type}`;
    statusAlert.classList.remove("hidden");
  }

  function hideAlert() {
    statusAlert.classList.add("hidden");
  }
});