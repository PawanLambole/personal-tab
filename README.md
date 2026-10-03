# 🔒 lulululu (Personal Tab Locker)

**lulululu** is a high-security, privacy-first Google Chrome extension (Manifest V3) that protects browser tabs and domains behind a master password with cryptographic recovery key support.

All security credentials and state logic operate 100% locally inside your browser using standard Web Crypto and Chrome Storage APIs. No external networks, backend servers, analytics, or third-party tracking libraries are ever used.

---

## ✨ Features

- **🔐 PBKDF2 Password Protection**: Set a password of any combination (letters, numbers, symbols, spaces, min 4 chars). Uses hardware-accelerated PBKDF2-HMAC-SHA256 key derivation with 100,000 iterations and a unique 128-bit random salt.
- **🛡️ Cryptographic Recovery Key**: Generate a 24-character hexadecimal recovery key (`crypto.getRandomValues()`) during setup to restore access if you forget your password.
- **🔒 Domain & Tab Protection**: Locks chosen websites and domains across browser sessions and tab re-opens.
- **⚡ Synchronous Zero-Flash Cloaking**: Injects immediate synchronous visibility cloaking at `document_start` to eliminate flashes of sensitive page content before authentication.
- **🛡️ Tamper-Resistant DOM Guardian**: Uses a reactive `MutationObserver` to prevent host page scripts from removing the overlay or clearing `inert`.
- **⏱️ Universal Brute-Force Rate Limiting**: Exponential backoff protection delays repeated invalid password or recovery key entries (5 fails = 30s, 8 fails = 120s, 10 fails = 300s).
- **🔄 Session-Safe Service Worker Architecture**: Uses `chrome.storage.session` to maintain active unlocked sessions across Manifest V3 background service worker sleep/termination cycles.
- **🧭 SPA Route & In-Page Navigation Protection**: Detects client-side SPA route transitions (e.g. switching chats in ChatGPT or videos in YouTube) and relocks the view.
- **⏸️ Master Lock Protection Switch**: Toggle protection ON/OFF directly from the popup or options page (turning OFF requires password verification).
- **⚙️ Comprehensive Options Dashboard**: Change password, regenerate recovery key, view active locked tabs, unlock individual or all tabs, or perform an emergency extension factory reset. Sensitive data is never rendered in the DOM before authentication.
- **🛡️ Zero Telemetry / Local-Only Privacy**: Requests minimal Chrome permissions (`storage`, `tabs`, `scripting`). Makes zero network calls.

---

## 🚀 Installation Guide

Load **lulululu** directly into Google Chrome as an unpacked developer extension:

1. Download or clone this repository to your local computer.
2. Open Google Chrome and navigate to:
   ```text
   chrome://extensions
   ```
3. Enable **Developer mode** using the toggle switch in the top-right corner of the page.
4. Click the **Load unpacked** button in the top-left toolbar.
5. Browse to and select the `personal-tab-locker` directory containing `manifest.json`.
6. The extension icon 🔒 will appear in your Chrome extensions toolbar!

---

## 🔐 Security & Privacy Architecture

- **No Plaintext Secrets**: Plaintext passwords and recovery keys are **never** written to storage, DOM attributes, console logs, or network requests.
- **PBKDF2 Key Derivation**: Native `crypto.subtle.deriveBits("PBKDF2", ...)` with 100,000 iterations and random 128-bit salt prevents offline dictionary cracking.
- **Cryptographic Randomness**: Recovery keys and salts are generated exclusively via `crypto.getRandomValues()`.
- **Isolated Shadow DOM**: Lock screen UI is isolated in an Open Shadow DOM attached directly to `document.documentElement` with inline `!important` styles resistant to host page CSS.
- **Scoped Content Script Injection**: Content scripts are scoped exclusively to `http://*/*` and `https://*/*` web pages without requesting broad `<all_urls>` host permissions.
