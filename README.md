# 🔒 lulululu

**lulululu** is a lightweight, privacy-first Google Chrome extension (Manifest V3) that allows users to lock individual browser tabs behind a custom password (any combination) with recovery key support.

All security credentials and state logic operate 100% locally inside your browser using standard Web Crypto and Chrome Storage APIs. No external networks, backend servers, analytics, or third-party tracking libraries are ever used.

---

## ✨ Features

- **🔐 Custom Password Protection**: Set a password of any combination (letters, numbers, symbols, spaces, min 4 chars). Plaintext passwords are never stored; only salted SHA-256 hashes are preserved.
- **🛡️ Cryptographic Recovery Key**: Generate a 24-character hexadecimal recovery key (`crypto.getRandomValues()`) during setup to restore access if you forget your password.
- **🔒 Per-Tab Independent Locking**: Lock specific sensitive tabs (e.g. Gmail, WhatsApp Web, GitHub) while keeping other tabs unlocked.
- **⏸️ Master Lock Protection Switch**: Toggle protection ON/OFF directly from the popup or options page (turning OFF requires password verification).
- **👁️ Shadow DOM Lock Screen**: Locked tabs present a full-viewport lock overlay rendered inside a closed Shadow DOM root, isolating it from host webpage scripts and CSS.
- **⏱️ Brute-Force Rate Limiting**: Exponential backoff protection delays repeated invalid password entries (e.g., 5 failed attempts = 30s lockout).
- **🔄 Tab Lifecycle Cleanup**: Automatically removes storage records when locked tabs are closed, preventing stale data buildup.
- **⚙️ Comprehensive Options Dashboard**: Change password, regenerate recovery key, view all active locked tabs, unlock individual or all tabs, or perform an emergency extension factory reset.
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

## 🐙 Git & GitHub Setup

Initialize git version control locally and publish to your private repository:

```bash
# 1. Initialize local repository
git init

# 2. Stage all project files
git add .

# 3. Create initial commit
git commit -m "Initial lulululu extension"

# 4. (Optional) Connect your private GitHub remote repository
git remote add origin git@github.com:YOUR_USERNAME/YOUR_PRIVATE_REPO.name.git
git branch -M main
git push -u origin main
```

---

## 🔐 Security & Privacy Architecture

- **No Plaintext Secrets**: Plaintext passwords and recovery keys are **never** written to `chrome.storage.local`, `localStorage`, DOM attributes, console logs, or network requests.
- **Web Crypto Hashing**: Hashing uses native `crypto.subtle.digest("SHA-256", ...)` with a unique 128-bit random salt generated upon setup.
- **Cryptographic Randomness**: Recovery keys and salts are generated exclusively via `crypto.getRandomValues()`.
- **Minimal Permissions Model**:
  ```json
  "permissions": [
    "storage",
    "tabs",
    "scripting"
  ]
  ```
- **Scoped Content Script Injection**: Content scripts are scoped exclusively to `http://*/*` and `https://*/*` web pages to render the lock overlay without requesting broad `<all_urls>` host permissions.
