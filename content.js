"use strict";

/**
 * Personal Tab Locker - Content Script
 * Injected into http:// and https:// webpages.
 * Uses closed Shadow DOM, inert document isolation, and capture-phase focus/keyboard trapping
 * to ensure tab locking is completely secure, leak-proof, and does NOT cause hydration or reload crashes.
 */

(function () {
  if (window.__PTL_CONTENT_SCRIPT_INITIALIZED__) {
    if (typeof window.__PTL_CHECK_LOCK__ === "function") {
      window.__PTL_CHECK_LOCK__();
    }
    return;
  }
  window.__PTL_CONTENT_SCRIPT_INITIALIZED__ = true;

  let overlayHost = null;
  let shadowRoot = null;
  let countdownTimer = null;
  let isCurrentlyLocked = false;
  let lockObserver = null;
  let lastLockStatus = null;

  window.__PTL_CHECK_LOCK__ = initTabLockCheck;

  // Perform lock check immediately upon injection
  initTabLockCheck();

  // Listen for storage changes in real-time across all browser tabs
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local") {
      if (changes.protectionEnabled !== undefined) {
        const enabled = changes.protectionEnabled.newValue !== false;
        if (!enabled) {
          removeLockScreen();
        } else {
          initTabLockCheck();
        }
      }
      if (changes.lockedTabs !== undefined) {
        initTabLockCheck();
      }
    }
  });

  // Listen for DOM lifecycle events to re-enforce lock during reload parsing
  document.addEventListener("readystatechange", () => {
    if (isCurrentlyLocked) enforceLockScreen();
  });
  document.addEventListener("DOMContentLoaded", () => {
    if (isCurrentlyLocked) enforceLockScreen();
  });
  window.addEventListener("load", () => {
    if (isCurrentlyLocked) enforceLockScreen();
  });

  // Listen for direct messages from background service worker or popup
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "SHOW_LOCK_SCREEN") {
      showLockScreen(message.lockStatus);
      sendResponse({ success: true });
    } else if (message.type === "REMOVE_LOCK_SCREEN") {
      removeLockScreen();
      sendResponse({ success: true });
    }
  });

  // Global capture listeners to trap keyboard events and focus while locked
  function onWindowKeyCapture(e) {
    if (!isCurrentlyLocked) return;

    const path = e.composedPath ? e.composedPath() : [];
    const isFromOverlay = overlayHost && (path.includes(overlayHost) || e.target === overlayHost);

    if (isFromOverlay) {
      // Keystroke was typed inside the lock screen input.
      // Stop it from propagating to window/document listeners so host page (e.g. ChatGPT) never sees it!
      e.stopPropagation();
      return;
    }

    // Keystroke was aimed at the underlying page:
    // Drop the event completely!
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    focusCurrentLockInput();
  }

  function onWindowFocusCapture(e) {
    if (!isCurrentlyLocked) return;

    const path = e.composedPath ? e.composedPath() : [];
    const isFromOverlay = overlayHost && path.includes(overlayHost);

    if (!isFromOverlay) {
      // Underlying page element tried to steal focus:
      // Drop the event and refocus our overlay input
      e.preventDefault();
      e.stopImmediatePropagation();
      focusCurrentLockInput();
    }
  }

  window.addEventListener("keydown", onWindowKeyCapture, true);
  window.addEventListener("keyup", onWindowKeyCapture, true);
  window.addEventListener("keypress", onWindowKeyCapture, true);
  window.addEventListener("focusin", onWindowFocusCapture, true);
  window.addEventListener("focus", onWindowFocusCapture, true);

  function getActiveLockInput() {
    if (!shadowRoot) return null;
    return (
      shadowRoot.getElementById("pin-input") ||
      shadowRoot.getElementById("key-input") ||
      shadowRoot.getElementById("new-pin-input") ||
      shadowRoot.getElementById("confirm-pin-input")
    );
  }

  function focusCurrentLockInput() {
    if (!isCurrentlyLocked) return;
    const input = getActiveLockInput();
    if (input) {
      try {
        input.focus();
      } catch (e) {}
    }
  }

  async function initTabLockCheck() {
    try {
      const storage = await chrome.storage.local.get(["protectionEnabled"]);
      if (storage.protectionEnabled === false) {
        removeLockScreen();
        return;
      }

      const payload = {
        type: "CHECK_LOCK_STATUS",
        url: window.location.href,
        hostname: window.location.hostname
      };
      const response = await chrome.runtime.sendMessage(payload);
      if (response && response.isLocked) {
        showLockScreen(response);
      } else {
        removeLockScreen();
      }
    } catch (e) {
      setTimeout(async () => {
        try {
          const storage = await chrome.storage.local.get(["protectionEnabled"]);
          if (storage.protectionEnabled === false) {
            removeLockScreen();
            return;
          }

          const payload = {
            type: "CHECK_LOCK_STATUS",
            url: window.location.href,
            hostname: window.location.hostname
          };
          const res = await chrome.runtime.sendMessage(payload);
          if (res && res.isLocked) {
            showLockScreen(res);
          } else {
            removeLockScreen();
          }
        } catch (err) {}
      }, 300);
    }
  }

  function setupMutationObserver() {
    if (lockObserver) return;
    lockObserver = new MutationObserver(() => {
      if (isCurrentlyLocked) {
        const missingHost = !overlayHost || !document.documentElement.contains(overlayHost);
        const missingClass = !document.documentElement.classList.contains("ptl-locked-active");
        if (missingHost || missingClass) {
          enforceLockScreen();
        }
      }
    });
    lockObserver.observe(document.documentElement, {
      childList: true,
      attributes: true,
      attributeFilter: ["class"]
    });
  }

  function setUnderlyingPageInert(active) {
    if (document.body) {
      if (active) {
        document.body.setAttribute("inert", "");
        try {
          document.body.inert = true;
        } catch (e) {}
      } else {
        document.body.removeAttribute("inert");
        try {
          document.body.inert = false;
        } catch (e) {}
      }
    }
  }

  function enforceLockScreen() {
    if (!isCurrentlyLocked) return;
    injectGlobalLockStyles();
    setUnderlyingPageInert(true);

    if (!document.documentElement.classList.contains("ptl-locked-active")) {
      document.documentElement.classList.add("ptl-locked-active");
    }

    if (!overlayHost) {
      overlayHost = document.createElement("div");
      overlayHost.id = "ptl-lock-overlay-host";
      shadowRoot = overlayHost.attachShadow({ mode: "closed" });
      renderPinView(lastLockStatus?.isLockedOut ? lastLockStatus.remainingSeconds : 0);
    }

    if (!document.documentElement.contains(overlayHost)) {
      document.documentElement.appendChild(overlayHost);
      setTimeout(focusCurrentLockInput, 50);
    }
  }

  function injectGlobalLockStyles() {
    if (document.getElementById("ptl-global-lock-styles")) return;
    const style = document.createElement("style");
    style.id = "ptl-global-lock-styles";
    style.textContent = `
      html.ptl-locked-active {
        overflow: hidden !important;
        height: 100% !important;
      }
      html.ptl-locked-active body {
        overflow: hidden !important;
        pointer-events: none !important;
        user-select: none !important;
        -webkit-user-select: none !important;
      }
      #ptl-lock-overlay-host {
        position: fixed !important;
        top: 0 !important;
        left: 0 !important;
        right: 0 !important;
        bottom: 0 !important;
        width: 100vw !important;
        height: 100vh !important;
        z-index: 2147483647 !important;
        display: block !important;
        visibility: visible !important;
        opacity: 1 !important;
        pointer-events: auto !important;
        background-color: #0f172a !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function removeGlobalLockStyles() {
    const style = document.getElementById("ptl-global-lock-styles");
    if (style && style.parentNode) {
      style.parentNode.removeChild(style);
    }
  }

  function showLockScreen(lockStatus) {
    isCurrentlyLocked = true;
    lastLockStatus = lockStatus;

    injectGlobalLockStyles();
    setUnderlyingPageInert(true);
    document.documentElement.classList.add("ptl-locked-active");

    if (!overlayHost) {
      overlayHost = document.createElement("div");
      overlayHost.id = "ptl-lock-overlay-host";
      shadowRoot = overlayHost.attachShadow({ mode: "closed" });
      document.documentElement.appendChild(overlayHost);
      renderPinView(lockStatus?.isLockedOut ? lockStatus.remainingSeconds : 0);
    } else if (!document.documentElement.contains(overlayHost)) {
      document.documentElement.appendChild(overlayHost);
      setTimeout(focusCurrentLockInput, 50);
    }

    setupMutationObserver();
  }

  function removeLockScreen() {
    isCurrentlyLocked = false;
    lastLockStatus = null;

    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }

    if (lockObserver) {
      lockObserver.disconnect();
      lockObserver = null;
    }

    document.documentElement.classList.remove("ptl-locked-active");
    removeGlobalLockStyles();
    setUnderlyingPageInert(false);

    if (overlayHost && overlayHost.parentNode) {
      overlayHost.parentNode.removeChild(overlayHost);
    }
    overlayHost = null;
    shadowRoot = null;
  }

  function getShadowStyles() {
    return `
      :host {
        all: initial;
        display: block;
        width: 100vw;
        height: 100vh;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      }

      .lock-container {
        position: fixed;
        inset: 0;
        background: #0f172a;
        color: #f8fafc;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 20px;
        box-sizing: border-box;
        z-index: 2147483647;
      }

      .lock-card {
        background: #1e293b;
        border: 1px solid #334155;
        border-radius: 16px;
        box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.6);
        width: 100%;
        max-width: 420px;
        padding: 36px 32px;
        box-sizing: border-box;
        text-align: center;
        animation: fadeIn 0.25s ease-out;
      }

      @keyframes fadeIn {
        from { opacity: 0; transform: scale(0.96); }
        to { opacity: 1; transform: scale(1); }
      }

      .icon-shield {
        width: 64px;
        height: 64px;
        background: rgba(56, 189, 248, 0.1);
        color: #38bdf8;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 32px;
        margin: 0 auto 20px auto;
        border: 1px solid rgba(56, 189, 248, 0.25);
      }

      h1 {
        font-size: 22px;
        font-weight: 700;
        margin: 0 0 8px 0;
        color: #f8fafc;
        letter-spacing: 0.5px;
      }

      p.subtitle {
        font-size: 14px;
        color: #94a3b8;
        margin: 0 0 24px 0;
        line-height: 1.5;
      }

      .form-group {
        margin-bottom: 20px;
        text-align: left;
      }

      label {
        display: block;
        font-size: 13px;
        font-weight: 600;
        color: #cbd5e1;
        margin-bottom: 8px;
      }

      input[type="password"],
      input[type="text"] {
        width: 100%;
        box-sizing: border-box;
        background: #0f172a;
        border: 1px solid #475569;
        border-radius: 8px;
        padding: 12px 16px;
        font-size: 16px;
        color: #f8fafc;
        outline: none;
        transition: border-color 0.2s, box-shadow 0.2s;
        text-align: center;
      }

      input:focus {
        border-color: #38bdf8;
        box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.2);
      }

      button.btn-primary {
        width: 100%;
        background: #0284c7;
        color: #ffffff;
        border: none;
        border-radius: 8px;
        padding: 12px 20px;
        font-size: 15px;
        font-weight: 600;
        cursor: pointer;
        transition: background-color 0.2s;
        margin-top: 8px;
      }

      button.btn-primary:hover:not(:disabled) {
        background: #0369a1;
      }

      button.btn-primary:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .error-msg {
        background: rgba(239, 68, 68, 0.15);
        border: 1px solid rgba(239, 68, 68, 0.3);
        color: #fca5a5;
        border-radius: 8px;
        padding: 10px 14px;
        font-size: 13px;
        margin-bottom: 18px;
        display: none;
        line-height: 1.4;
        text-align: center;
      }

      .error-msg.visible {
        display: block;
      }

      .link-btn {
        background: none;
        border: none;
        color: #38bdf8;
        font-size: 13px;
        cursor: pointer;
        margin-top: 16px;
        text-decoration: underline;
        padding: 4px;
      }

      .link-btn:hover {
        color: #7dd3fc;
      }

      .lockout-badge {
        background: rgba(245, 158, 11, 0.15);
        border: 1px solid rgba(245, 158, 11, 0.3);
        color: #fcd34d;
        border-radius: 8px;
        padding: 10px 14px;
        font-size: 13px;
        margin-bottom: 18px;
        line-height: 1.4;
      }
    `;
  }

  function renderPinView(lockoutRemaining = 0) {
    if (!shadowRoot) return;

    shadowRoot.innerHTML = `
      <style>${getShadowStyles()}</style>
      <div class="lock-container">
        <div class="lock-card">
          <div class="icon-shield">🔒</div>
          <h1>TAB LOCKED</h1>
          <p class="subtitle">This tab is protected by lulululu.<br>Enter your password to unlock access.</p>

          <div id="error-box" class="error-msg"></div>

          ${
            lockoutRemaining > 0
              ? `<div id="lockout-box" class="lockout-badge">Too many attempts. Try again in <span id="countdown">${lockoutRemaining}</span>s.</div>`
              : ""
          }

          <form id="pin-form">
            <div class="form-group">
              <label for="pin-input">Password</label>
              <input
                type="password"
                id="pin-input"
                placeholder="Enter Password"
                maxlength="64"
                autocomplete="off"
                required
                ${lockoutRemaining > 0 ? "disabled" : ""}
                autofocus
              />
            </div>
            <button type="submit" id="unlock-btn" class="btn-primary" ${lockoutRemaining > 0 ? "disabled" : ""}>
              Unlock Tab
            </button>
          </form>

          <button type="button" id="forgot-btn" class="link-btn">Forgot Password?</button>
        </div>
      </div>
    `;

    const form = shadowRoot.getElementById("pin-form");
    const pinInput = shadowRoot.getElementById("pin-input");
    const errorBox = shadowRoot.getElementById("error-box");
    const forgotBtn = shadowRoot.getElementById("forgot-btn");
    const container = shadowRoot.querySelector(".lock-container");

    // Shield events inside the shadow root from bubbling to host page
    const stopBubble = (e) => e.stopPropagation();
    ["keydown", "keyup", "keypress", "input", "change"].forEach((evt) => {
      pinInput.addEventListener(evt, stopBubble);
      form.addEventListener(evt, stopBubble);
    });

    container.addEventListener("click", (e) => {
      e.stopPropagation();
      if (e.target !== pinInput && e.target !== shadowRoot.getElementById("unlock-btn") && e.target !== forgotBtn) {
        pinInput.focus();
      }
    });

    if (lockoutRemaining > 0) {
      startCountdownTimer(lockoutRemaining, () => renderPinView(0));
    } else {
      setTimeout(() => pinInput?.focus(), 50);
    }

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const pin = pinInput.value.trim();
      if (!pin) return;

      errorBox.classList.remove("visible");

      try {
        const response = await chrome.runtime.sendMessage({
          type: "VERIFY_PIN",
          pin
        });

        if (response && response.success) {
          removeLockScreen();
        } else {
          if (response && response.isLockedOut) {
            renderPinView(response.remainingSeconds);
          } else {
            errorBox.textContent = (response && response.error) || "Incorrect password";
            errorBox.classList.add("visible");
            pinInput.value = "";
            pinInput.focus();
          }
        }
      } catch (err) {
        errorBox.textContent = "Error communicating with extension background worker.";
        errorBox.classList.add("visible");
      }
    });

    forgotBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      renderRecoveryView();
    });
  }

  function renderRecoveryView() {
    if (!shadowRoot) return;

    shadowRoot.innerHTML = `
      <style>${getShadowStyles()}</style>
      <div class="lock-container">
        <div class="lock-card">
          <div class="icon-shield">🔑</div>
          <h1>RECOVER ACCESS</h1>
          <p class="subtitle">Enter your 24-character recovery key to reset your password.</p>

          <div id="error-box" class="error-msg"></div>

          <form id="recovery-form">
            <div class="form-group">
              <label for="key-input">Recovery Key</label>
              <input
                type="text"
                id="key-input"
                placeholder="A81F-29C0-4E77-B13D..."
                maxlength="29"
                autocomplete="off"
                required
                autofocus
              />
            </div>
            <button type="submit" id="verify-key-btn" class="btn-primary">
              Verify Recovery Key
            </button>
          </form>

          <button type="button" id="back-pin-btn" class="link-btn">Back to Password</button>
        </div>
      </div>
    `;

    const form = shadowRoot.getElementById("recovery-form");
    const keyInput = shadowRoot.getElementById("key-input");
    const errorBox = shadowRoot.getElementById("error-box");
    const backBtn = shadowRoot.getElementById("back-pin-btn");
    const container = shadowRoot.querySelector(".lock-container");

    const stopBubble = (e) => e.stopPropagation();
    ["keydown", "keyup", "keypress", "input", "change"].forEach((evt) => {
      keyInput.addEventListener(evt, stopBubble);
      form.addEventListener(evt, stopBubble);
    });

    container.addEventListener("click", (e) => {
      e.stopPropagation();
      if (e.target !== keyInput && e.target !== shadowRoot.getElementById("verify-key-btn") && e.target !== backBtn) {
        keyInput.focus();
      }
    });

    keyInput.focus();

    keyInput.addEventListener("input", () => {
      const clean = keyInput.value.replace(/[\s\-]/g, "").toUpperCase();
      keyInput.value = clean.match(/.{1,4}/g)?.join("-") || clean;
    });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const recoveryKey = keyInput.value.trim();
      if (!recoveryKey) return;

      errorBox.classList.remove("visible");

      try {
        const response = await chrome.runtime.sendMessage({
          type: "VERIFY_RECOVERY",
          recoveryKey
        });

        if (response && response.success) {
          renderResetPinView(recoveryKey);
        } else {
          errorBox.textContent = (response && response.error) || "Invalid recovery key.";
          errorBox.classList.add("visible");
        }
      } catch (err) {
        errorBox.textContent = "Error communicating with extension service worker.";
        errorBox.classList.add("visible");
      }
    });

    backBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      renderPinView(0);
    });
  }

  function renderResetPinView(verifiedRecoveryKey) {
    if (!shadowRoot) return;

    shadowRoot.innerHTML = `
      <style>${getShadowStyles()}</style>
      <div class="lock-container">
        <div class="lock-card">
          <div class="icon-shield">🔐</div>
          <h1>CREATE NEW PASSWORD</h1>
          <p class="subtitle">Recovery key verified successfully.<br>Enter a new password (any combination, min 4 chars).</p>

          <div id="error-box" class="error-msg"></div>

          <form id="reset-pin-form">
            <div class="form-group">
              <label for="new-pin-input">New Password</label>
              <input
                type="password"
                id="new-pin-input"
                placeholder="New Password (min 4 chars)"
                maxlength="64"
                required
                autofocus
              />
            </div>
            <div class="form-group">
              <label for="confirm-pin-input">Confirm New Password</label>
              <input
                type="password"
                id="confirm-pin-input"
                placeholder="Confirm New Password"
                maxlength="64"
                required
              />
            </div>
            <button type="submit" class="btn-primary">
              Reset Password & Unlock
            </button>
          </form>
        </div>
      </div>
    `;

    const form = shadowRoot.getElementById("reset-pin-form");
    const newPinInput = shadowRoot.getElementById("new-pin-input");
    const confirmPinInput = shadowRoot.getElementById("confirm-pin-input");
    const errorBox = shadowRoot.getElementById("error-box");
    const container = shadowRoot.querySelector(".lock-container");

    const stopBubble = (e) => e.stopPropagation();
    ["keydown", "keyup", "keypress", "input", "change"].forEach((evt) => {
      newPinInput.addEventListener(evt, stopBubble);
      confirmPinInput.addEventListener(evt, stopBubble);
      form.addEventListener(evt, stopBubble);
    });

    container.addEventListener("click", (e) => {
      e.stopPropagation();
      newPinInput.focus();
    });

    newPinInput.focus();

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const newPin = newPinInput.value.trim();
      const confirmNewPin = confirmPinInput.value.trim();

      errorBox.classList.remove("visible");

      try {
        const response = await chrome.runtime.sendMessage({
          type: "SET_NEW_PIN_WITH_RECOVERY",
          recoveryKey: verifiedRecoveryKey,
          newPin,
          confirmNewPin
        });

        if (response && response.success) {
          removeLockScreen();
        } else {
          errorBox.textContent = (response && response.error) || "Failed to reset password.";
          errorBox.classList.add("visible");
        }
      } catch (err) {
        errorBox.textContent = "Error communicating with extension service worker.";
        errorBox.classList.add("visible");
      }
    });
  }

  function startCountdownTimer(seconds, onFinished) {
    if (countdownTimer) clearInterval(countdownTimer);
    let remaining = seconds;

    countdownTimer = setInterval(() => {
      remaining--;
      if (shadowRoot) {
        const countSpan = shadowRoot.getElementById("countdown");
        if (countSpan) countSpan.textContent = remaining;
      }
      if (remaining <= 0) {
        clearInterval(countdownTimer);
        countdownTimer = null;
        if (typeof onFinished === "function") onFinished();
      }
    }, 1000);
  }
})();