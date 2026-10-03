"use strict";

/**
 * Personal Tab Locker - Content Script
 * Injected into http:// and https:// webpages.
 * Uses Shadow DOM and inert document isolation to ensure tab locking is completely secure,
 * leak-proof, and does NOT cause reload loops or input jamming.
 * Features synchronous pre-cloaking at document_start to guarantee zero visual content leaks.
 */

(function () {
  if (window.__PTL_CONTENT_SCRIPT_INITIALIZED__) {
    if (typeof window.__PTL_CHECK_LOCK__ === "function") {
      window.__PTL_CHECK_LOCK__();
    }
    return;
  }
  window.__PTL_CONTENT_SCRIPT_INITIALIZED__ = true;

  // Immediately inject synchronous cloak style to guarantee zero visual leak while checking lock status
  function applyPreCloak() {
    if (document.getElementById("ptl-precheck-cloak")) return;
    const preCloakStyle = document.createElement("style");
    preCloakStyle.id = "ptl-precheck-cloak";
    preCloakStyle.textContent = `
      html[data-ptl-checking="true"] {
        visibility: hidden !important;
      }
    `;
    (document.head || document.documentElement).appendChild(preCloakStyle);
    if (document.documentElement) {
      document.documentElement.setAttribute("data-ptl-checking", "true");
    }
  }

  function removePreCloak() {
    if (document.documentElement) {
      document.documentElement.removeAttribute("data-ptl-checking");
    }
    const el = document.getElementById("ptl-precheck-cloak");
    if (el && el.parentNode) {
      el.parentNode.removeChild(el);
    }
  }

  applyPreCloak();
  // Failsafe: Never keep page blank for more than 400ms if extension communication lags
  setTimeout(removePreCloak, 400);

  let overlayHost = null;
  let shadowRoot = null;
  let countdownTimer = null;
  let isCurrentlyLocked = false;
  let isSessionUnlocked = false;
  let lastLockStatus = null;
  let domGuardianObserver = null;

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
    }
  });

  // Ensure underlying page is inert once DOM is ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      if (isCurrentlyLocked) {
        setUnderlyingPageInert(true);
        if (overlayHost && document.documentElement && document.documentElement.lastElementChild !== overlayHost) {
          document.documentElement.appendChild(overlayHost);
        }
        focusCurrentLockInput();
      }
    });
  }

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

  // Real-time SPA navigation watcher (e.g. switching between chats in ChatGPT or videos in YouTube)
  let lastObservedUrl = window.location.href;
  function handleUrlChange() {
    if (!isCurrentlyLocked) {
      const current = window.location.href;
      if (current !== lastObservedUrl) {
        lastObservedUrl = current;
        initTabLockCheck();
      }
    }
  }

  setInterval(handleUrlChange, 150);
  window.addEventListener("popstate", handleUrlChange, true);
  window.addEventListener("click", () => setTimeout(handleUrlChange, 50), true);

  // Capture keystrokes aimed at underlying page while locked
  function onWindowKeyCapture(e) {
    if (!isCurrentlyLocked) return;

    const path = e.composedPath ? e.composedPath() : [];
    const isFromOverlay = path.some((el) => el && el.id === "ptl-lock-overlay-host");

    if (isFromOverlay) {
      // Keystroke was typed inside our lock screen overlay input.
      // Allow it to reach our input naturally without calling preventDefault!
      return;
    }

    // Keystroke was aimed at the underlying page (e.g. ChatGPT prompt textarea) while locked.
    // Drop it completely so host page never receives it!
    e.preventDefault();
    e.stopPropagation();
    focusCurrentLockInput();
  }

  // Prevent background page scripts from stealing focus away from lock input
  function onWindowFocusCapture(e) {
    if (!isCurrentlyLocked) return;

    const path = e.composedPath ? e.composedPath() : [];
    const isFromOverlay = path.some((el) => el && el.id === "ptl-lock-overlay-host");

    if (!isFromOverlay) {
      e.preventDefault();
      e.stopImmediatePropagation();
      focusCurrentLockInput();
    }
  }

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
    if (!isCurrentlyLocked || !shadowRoot) return;
    const input = getActiveLockInput();
    if (input && shadowRoot.activeElement !== input) {
      try {
        input.focus();
      } catch (e) {}
    }
  }

  let reloadHandled = false;
  function checkIsPageReload() {
    if (reloadHandled) return false;
    try {
      const navEntries = window.performance && performance.getEntriesByType ? performance.getEntriesByType("navigation") : [];
      if (navEntries && navEntries.length > 0) {
        const isReload = navEntries[0].type === "reload";
        if (isReload) {
          reloadHandled = true;
          return true;
        }
      }
      if (window.performance && performance.navigation) {
        const isReload = performance.navigation.type === 1; // 1 = TYPE_RELOAD
        if (isReload) {
          reloadHandled = true;
          return true;
        }
      }
    } catch (e) {}
    return false;
  }

  function getLockoutStatus(lockoutUntil = 0) {
    const now = Date.now();
    if (lockoutUntil && lockoutUntil > now) {
      const remainingSeconds = Math.ceil((lockoutUntil - now) / 1000);
      return { isLockedOut: true, remainingSeconds };
    }
    return { isLockedOut: false, remainingSeconds: 0 };
  }

  async function initTabLockCheck() {
    try {
      const storage = await chrome.storage.local.get(["protectionEnabled", "lockedTabs", "lockoutUntil"]);
      if (storage.protectionEnabled === false) {
        removeLockScreen();
        removePreCloak();
        return;
      }

      const hostname = window.location.hostname;
      const targetNorm = hostname ? hostname.toLowerCase().replace(/^www\./, "") : "";
      const lockedTabs = storage.lockedTabs || {};

      let isDomainLocked = false;
      if (targetNorm) {
        for (const data of Object.values(lockedTabs)) {
          const dataNorm = data.hostname ? data.hostname.toLowerCase().replace(/^www\./, "") : "";
          if (data.locked && dataNorm === targetNorm) {
            isDomainLocked = true;
            break;
          }
        }
      }

      // Pre-show lock screen on initial load (prevents flash of webpage!).
      if (isDomainLocked && !isSessionUnlocked) {
        const lockout = getLockoutStatus(storage.lockoutUntil);
        showLockScreen({ isLocked: true, ...lockout });
      }

      const isReload = checkIsPageReload();

      const payload = {
        type: "CHECK_LOCK_STATUS",
        isReload,
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
      // In case of error, do not keep pre-cloak stuck
    } finally {
      removePreCloak();
    }
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

  function injectGlobalLockStyles() {
    if (document.getElementById("ptl-global-lock-styles")) return;
    const style = document.createElement("style");
    style.id = "ptl-global-lock-styles";
    style.textContent = `
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

  // Tamper-resistant DOM Guardian to prevent host page scripts from removing overlay or inert
  function startDomGuardian() {
    if (domGuardianObserver) return;
    domGuardianObserver = new MutationObserver(() => {
      if (!isCurrentlyLocked) return;

      // Re-attach overlay if removed by host page scripts
      if (overlayHost && document.documentElement && !document.documentElement.contains(overlayHost)) {
        document.documentElement.appendChild(overlayHost);
      }

      // Re-apply inert if stripped by host page scripts
      if (document.body && !document.body.hasAttribute("inert")) {
        setUnderlyingPageInert(true);
      }
    });

    try {
      domGuardianObserver.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["inert", "style", "class"]
      });
    } catch (e) {}
  }

  function stopDomGuardian() {
    if (domGuardianObserver) {
      domGuardianObserver.disconnect();
      domGuardianObserver = null;
    }
  }

  function showLockScreen(lockStatus) {
    removePreCloak();

    // If lock screen is already active and displaying, do NOT re-create or wipe DOM!
    if (isCurrentlyLocked && overlayHost && document.documentElement && document.documentElement.contains(overlayHost)) {
      if (document.documentElement.lastElementChild !== overlayHost) {
        document.documentElement.appendChild(overlayHost);
      }
      return;
    }

    isCurrentlyLocked = true;
    isSessionUnlocked = false;
    lastLockStatus = lockStatus;

    injectGlobalLockStyles();
    setUnderlyingPageInert(true);
    startDomGuardian();

    // Clean up any stray duplicate element in DOM
    const existing = document.getElementById("ptl-lock-overlay-host");
    if (existing && existing !== overlayHost) {
      existing.remove();
    }

    if (!overlayHost) {
      overlayHost = document.createElement("div");
      overlayHost.id = "ptl-lock-overlay-host";

      // Stop all keyboard events from bubbling out of overlayHost to host page listeners
      const stopBubble = (e) => e.stopPropagation();
      ["keydown", "keyup", "keypress"].forEach((evt) => {
        overlayHost.addEventListener(evt, stopBubble);
      });

      shadowRoot = overlayHost.attachShadow({ mode: "open" });
      renderPinView(lockStatus?.isLockedOut ? lockStatus.remainingSeconds : 0);
    }

    // Direct, CSP-proof inline styles with !important so host page styles/CSPs can NEVER hide it
    overlayHost.style.setProperty("position", "fixed", "important");
    overlayHost.style.setProperty("top", "0", "important");
    overlayHost.style.setProperty("left", "0", "important");
    overlayHost.style.setProperty("right", "0", "important");
    overlayHost.style.setProperty("bottom", "0", "important");
    overlayHost.style.setProperty("width", "100vw", "important");
    overlayHost.style.setProperty("height", "100vh", "important");
    overlayHost.style.setProperty("z-index", "2147483647", "important");
    overlayHost.style.setProperty("display", "block", "important");
    overlayHost.style.setProperty("visibility", "visible", "important");
    overlayHost.style.setProperty("opacity", "1", "important");
    overlayHost.style.setProperty("pointer-events", "auto", "important");
    overlayHost.style.setProperty("background-color", "#0f172a", "important");
    overlayHost.style.setProperty("margin", "0", "important");
    overlayHost.style.setProperty("padding", "0", "important");
    overlayHost.style.setProperty("border", "none", "important");

    if (document.documentElement) {
      if (!document.documentElement.contains(overlayHost) || document.documentElement.lastElementChild !== overlayHost) {
        document.documentElement.appendChild(overlayHost);
      }
    }

    // Dynamically attach keyboard, input, and focus guards
    window.removeEventListener("keydown", onWindowKeyCapture, true);
    window.addEventListener("keydown", onWindowKeyCapture, true);
    window.removeEventListener("beforeinput", onWindowKeyCapture, true);
    window.addEventListener("beforeinput", onWindowKeyCapture, true);
    window.removeEventListener("focusin", onWindowFocusCapture, true);
    window.addEventListener("focusin", onWindowFocusCapture, true);

    setTimeout(focusCurrentLockInput, 50);
  }

  function removeLockScreen() {
    isCurrentlyLocked = false;
    isSessionUnlocked = true;
    lastLockStatus = null;

    stopDomGuardian();

    // Dynamically remove keyboard and focus guards
    window.removeEventListener("keydown", onWindowKeyCapture, true);
    window.removeEventListener("beforeinput", onWindowKeyCapture, true);
    window.removeEventListener("focusin", onWindowFocusCapture, true);

    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }

    removeGlobalLockStyles();
    setUnderlyingPageInert(false);
    removePreCloak();

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

    const existingInput = shadowRoot.getElementById("pin-input");
    if (existingInput && lockoutRemaining === 0) {
      return;
    }

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
    if (container) {
      container.style.cssText =
        "position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;background:#0f172a!important;display:flex!important;align-items:center!important;justify-content:center!important;padding:20px!important;box-sizing:border-box!important;z-index:2147483647!important;";
    }

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
          pin,
          url: window.location.href
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
      if (countdownTimer) {
        clearInterval(countdownTimer);
        countdownTimer = null;
      }
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
    if (container) {
      container.style.cssText =
        "position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;background:#0f172a!important;display:flex!important;align-items:center!important;justify-content:center!important;padding:20px!important;box-sizing:border-box!important;z-index:2147483647!important;";
    }

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
    if (container) {
      container.style.cssText =
        "position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;background:#0f172a!important;display:flex!important;align-items:center!important;justify-content:center!important;padding:20px!important;box-sizing:border-box!important;z-index:2147483647!important;";
    }

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
          confirmNewPin,
          url: window.location.href
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