"use strict";

/**
 * Personal Tab Locker - Options Dashboard Script
 * Direct, resilient interface for settings, Master Protection toggle, and tab management.
 */

document.addEventListener("DOMContentLoaded", async () => {
  const alertBanner = document.getElementById("alert-banner");

  // Master Switch Elements
  const optChkMasterToggle = document.getElementById("opt-chk-master-toggle");
  const optMasterStatus = document.getElementById("opt-master-status");
  const optChkBlockExtPage = document.getElementById("opt-chk-block-ext-page");

  // Password Form Elements
  const formChangePin = document.getElementById("form-change-pin");
  const inputCurrentPin = document.getElementById("input-current-pin");
  const inputNewPin = document.getElementById("input-new-pin");
  const inputConfirmNewPin = document.getElementById("input-confirm-new-pin");

  // Recovery Key Form Elements
  const formRegenKey = document.getElementById("form-regen-key");
  const inputRegenPin = document.getElementById("input-regen-pin");
  const newKeyDisplayBox = document.getElementById("new-key-display-box");
  const newRecoveryKeyText = document.getElementById("new-recovery-key-text");
  const btnCopyNewKey = document.getElementById("btn-copy-new-key");

  // Locked Tabs Elements
  const lockedTabsList = document.getElementById("locked-tabs-list");
  const btnUnlockAll = document.getElementById("btn-unlock-all");

  // Danger Zone Elements
  const btnResetExtension = document.getElementById("btn-reset-extension");

  // Real-time Storage Listener to auto-update Locked Tabs card live
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local") {
      if (changes.lockedTabs) {
        loadLockedTabsList();
      }
      if (changes.protectionEnabled !== undefined) {
        updateOptMasterSwitchUI(changes.protectionEnabled.newValue !== false);
      }
    }
  });

  // Initial Load
  await initMasterSwitch();
  await loadLockedTabsList();

  async function initMasterSwitch() {
    const { protectionEnabled, blockExtensionPage = false } = await chrome.storage.local.get([
      "protectionEnabled",
      "blockExtensionPage"
    ]);
    const isEnabled = protectionEnabled !== false;
    updateOptMasterSwitchUI(isEnabled);
    optChkBlockExtPage.checked = Boolean(blockExtensionPage);
  }

  function updateOptMasterSwitchUI(enabled) {
    optChkMasterToggle.checked = enabled;
    if (enabled) {
      optMasterStatus.textContent = "Active (ON)";
      optMasterStatus.className = "master-status-on";
    } else {
      optMasterStatus.textContent = "Paused (OFF)";
      optMasterStatus.className = "master-status-off";
    }
  }

  optChkBlockExtPage.addEventListener("change", async () => {
    await chrome.storage.local.set({ blockExtensionPage: optChkBlockExtPage.checked });
    if (optChkBlockExtPage.checked) {
      showAlert("🔒 Access to chrome://extensions is now blocked while protection is active.", "success");
    } else {
      showAlert("🔓 Access to chrome://extensions is now unrestricted.", "success");
    }
  });

  optChkMasterToggle.addEventListener("change", async () => {
    const isAttemptingTurnOff = !optChkMasterToggle.checked;

    if (isAttemptingTurnOff) {
      optChkMasterToggle.checked = true; // Revert until password verified
      const pin = prompt("Enter your password to turn Master Protection OFF:");
      if (pin === null || !pin.trim()) return;

      const storage = await chrome.storage.local.get(["salt", "pinHash"]);
      const inputHash = await TabLockerCrypto.hashValue(pin, storage.salt);

      if (inputHash && inputHash === storage.pinHash) {
        await chrome.storage.local.set({ protectionEnabled: false });
        updateOptMasterSwitchUI(false);
        showAlert("⏸️ Master Protection turned OFF. Tab locks paused.", "success");
      } else {
        showAlert("Incorrect password. Master Protection remains active.", "danger");
      }
    } else {
      await chrome.storage.local.set({ protectionEnabled: true });
      updateOptMasterSwitchUI(true);
      showAlert("🛡️ Master Protection re-enabled!", "success");
    }
  });

  // Change Password Handler
  formChangePin.addEventListener("submit", async (e) => {
    e.preventDefault();
    hideAlert();

    const currentPin = inputCurrentPin.value.trim();
    const newPin = inputNewPin.value.trim();
    const confirmNewPin = inputConfirmNewPin.value.trim();

    if (!TabLockerCrypto.isValidPassword(newPin)) {
      showAlert("New Password must be at least 4 characters long.", "danger");
      return;
    }

    if (newPin !== confirmNewPin) {
      showAlert("New Passwords do not match.", "danger");
      return;
    }

    try {
      const storage = await chrome.storage.local.get(["salt", "pinHash"]);
      const currentInputHash = await TabLockerCrypto.hashValue(currentPin, storage.salt);

      if (currentInputHash && currentInputHash === storage.pinHash) {
        const newPinHash = await TabLockerCrypto.hashValue(newPin, storage.salt);
        await chrome.storage.local.set({ pinHash: newPinHash });

        showAlert("✓ Password successfully updated!", "success");
        formChangePin.reset();
      } else {
        showAlert("Incorrect current password.", "danger");
      }
    } catch (err) {
      showAlert("Error updating password.", "danger");
    }
  });

  // Regenerate Recovery Key Handler
  formRegenKey.addEventListener("submit", async (e) => {
    e.preventDefault();
    hideAlert();

    const currentPin = inputRegenPin.value.trim();
    if (!currentPin) {
      showAlert("Current password is required.", "danger");
      return;
    }

    try {
      const storage = await chrome.storage.local.get(["salt", "pinHash"]);
      const currentInputHash = await TabLockerCrypto.hashValue(currentPin, storage.salt);

      if (currentInputHash && currentInputHash === storage.pinHash) {
        const rawNewKey = TabLockerCrypto.generateRecoveryKey();
        const newRecoveryKeyHash = await TabLockerCrypto.hashValue(rawNewKey, storage.salt);

        await chrome.storage.local.set({ recoveryKeyHash: newRecoveryKeyHash });

        showAlert("✓ New recovery key generated!", "success");
        newRecoveryKeyText.value = TabLockerCrypto.formatRecoveryKey(rawNewKey);
        newKeyDisplayBox.classList.remove("hidden");
        formRegenKey.reset();
      } else {
        showAlert("Incorrect current password.", "danger");
      }
    } catch (err) {
      showAlert("Error regenerating recovery key.", "danger");
    }
  });

  btnCopyNewKey.addEventListener("click", async () => {
    if (!newRecoveryKeyText.value) return;
    try {
      await navigator.clipboard.writeText(newRecoveryKeyText.value);
      btnCopyNewKey.textContent = "Copied!";
      setTimeout(() => {
        btnCopyNewKey.textContent = "Copy";
      }, 2000);
    } catch (e) {
      showAlert("Failed to copy recovery key.", "danger");
    }
  });

  // Load Locked Tabs List
  async function loadLockedTabsList() {
    try {
      const { lockedTabs = {} } = await chrome.storage.local.get("lockedTabs");
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

      if (activeList.length === 0) {
        lockedTabsList.innerHTML = `<div class="empty-state">No tabs are currently locked.</div>`;
        return;
      }

      lockedTabsList.innerHTML = "";
      activeList.forEach((tab) => {
        const row = document.createElement("div");
        row.className = "tab-item-row";
        row.innerHTML = `
          <div class="tab-info-main">
            <span class="tab-icon">🔒</span>
            <div class="tab-details">
              <h4>${escapeHtml(tab.title || "Locked Tab")}</h4>
              <p>${escapeHtml(tab.hostname || "")} (Tab ID: ${tab.tabId})</p>
            </div>
          </div>
          <button class="btn-secondary-sm btn-unlock-single" data-tab-id="${tab.tabId}">Unlock</button>
        `;
        lockedTabsList.appendChild(row);
      });

      // Bind single unlock click events
      document.querySelectorAll(".btn-unlock-single").forEach((btn) => {
        btn.addEventListener("click", async (e) => {
          const tabId = parseInt(e.target.getAttribute("data-tab-id"), 10);
          const pin = prompt("Enter your password to unlock this tab:");
          if (pin === null || !pin.trim()) return;

          const storage = await chrome.storage.local.get(["salt", "pinHash", "lockedTabs"]);
          const inputHash = await TabLockerCrypto.hashValue(pin, storage.salt);

          if (inputHash && inputHash === storage.pinHash) {
            const currentLocked = storage.lockedTabs || {};
            const tabData = currentLocked[tabId];
            delete currentLocked[tabId];

            if (tabData && tabData.hostname) {
              for (const [id, d] of Object.entries(currentLocked)) {
                if (d.hostname === tabData.hostname) {
                  delete currentLocked[id];
                  try {
                    await chrome.tabs.sendMessage(parseInt(id, 10), { type: "REMOVE_LOCK_SCREEN" });
                  } catch (e) {}
                }
              }
            }

            await chrome.storage.local.set({ lockedTabs: currentLocked });

            try {
              await chrome.tabs.sendMessage(tabId, { type: "REMOVE_LOCK_SCREEN" });
            } catch (err) {}

            showAlert("🔓 Tab unlocked!", "success");
            await loadLockedTabsList();
          } else {
            showAlert("Incorrect password.", "danger");
          }
        });
      });
    } catch (err) {
      lockedTabsList.innerHTML = `<div class="empty-state">Error loading locked tabs list.</div>`;
    }
  }

  // Unlock All Tabs Handler
  btnUnlockAll.addEventListener("click", async () => {
    const pin = prompt("Enter your password to unlock ALL tabs:");
    if (pin === null || !pin.trim()) return;

    try {
      const storage = await chrome.storage.local.get(["salt", "pinHash", "lockedTabs"]);
      const inputHash = await TabLockerCrypto.hashValue(pin, storage.salt);

      if (inputHash && inputHash === storage.pinHash) {
        const currentLocked = storage.lockedTabs || {};
        const tabIds = Object.keys(currentLocked);

        await chrome.storage.local.set({ lockedTabs: {} });

        for (const idStr of tabIds) {
          const id = parseInt(idStr, 10);
          try {
            await chrome.tabs.sendMessage(id, { type: "REMOVE_LOCK_SCREEN" });
          } catch (err) {}
        }

        showAlert("🔓 All tabs unlocked successfully!", "success");
        await loadLockedTabsList();
      } else {
        showAlert("Incorrect password.", "danger");
      }
    } catch (err) {
      showAlert("Error unlocking all tabs.", "danger");
    }
  });

  // Reset Extension Handler
  btnResetExtension.addEventListener("click", async () => {
    const confirmText = prompt(
      "WARNING: This will permanently delete your password, recovery key, and all settings.\n\nEnter your password to confirm extension reset:"
    );
    if (confirmText === null || !confirmText.trim()) return;

    try {
      const storage = await chrome.storage.local.get(["salt", "pinHash"]);
      const inputHash = await TabLockerCrypto.hashValue(confirmText, storage.salt);

      if (inputHash && inputHash === storage.pinHash) {
        const currentLocked = storage.lockedTabs || {};
        const tabIds = Object.keys(currentLocked);

        await chrome.storage.local.clear();

        for (const idStr of tabIds) {
          const id = parseInt(idStr, 10);
          try {
            await chrome.tabs.sendMessage(id, { type: "REMOVE_LOCK_SCREEN" });
          } catch (err) {}
        }

        alert("Extension has been completely reset.");
        window.location.reload();
      } else {
        showAlert("Incorrect password. Reset aborted.", "danger");
      }
    } catch (err) {
      showAlert("Error resetting extension.", "danger");
    }
  });

  function showAlert(msg, type = "danger") {
    alertBanner.textContent = msg;
    alertBanner.className = `alert alert-${type}`;
    alertBanner.classList.remove("hidden");
  }

  function hideAlert() {
    alertBanner.classList.add("hidden");
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }
});
