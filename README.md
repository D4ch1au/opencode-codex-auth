![Image 1: opencode-codex-auth](assets/readme-hero.svg)
  
  
**By [D4ch1au](https://github.com/D4ch1au)**
[![npm version](https://img.shields.io/npm/v/opencode-codex-auth.svg)](https://www.npmjs.com/package/opencode-codex-auth)
[![Tests](https://github.com/D4ch1au/opencode-codex-auth/actions/workflows/ci.yml/badge.svg)](https://github.com/D4ch1au/opencode-codex-auth/actions)
[![npm downloads](https://img.shields.io/npm/dm/opencode-codex-auth.svg)](https://www.npmjs.com/package/opencode-codex-auth)
**One install. Every Codex model.**
[Install](#-quick-start) · [Models](#-models) · [Configuration](#-configuration) · [Docs](#-docs)

---
## 💡 Philosophy
> **"One config. Every model."**
OpenCode should feel effortless. This plugin keeps the setup minimal while giving you full GPT‑5.x + Codex access via ChatGPT OAuth.
```
┌─────────────────────────────────────────────────────────┐
│                                                         │
│  ChatGPT OAuth → Codex backend → OpenCode               │
│  One command install, full model presets, done.         │
│                                                         │
└─────────────────────────────────────────────────────────┘
```
---
## 🚀 Quick Start
```bash
npx -y opencode-codex-auth@latest
```
Then:
```bash
opencode auth login
opencode run "write hello world to test.txt" --model=openai/gpt-5.3-codex --variant=medium
```
Legacy OpenCode (v1.0.209 and below):
```bash
npx -y opencode-codex-auth@latest --legacy
opencode run "write hello world to test.txt" --model=openai/gpt-5.3-codex-medium
```
Uninstall:
```bash
npx -y opencode-codex-auth@latest --uninstall
npx -y opencode-codex-auth@latest --uninstall --all
```
---
## 📦 Models
- **gpt-5.3-codex** (low/medium/high/xhigh)
- **gpt-5.2** (none/low/medium/high/xhigh)
- **gpt-5.2-codex** (low/medium/high/xhigh)
- **gpt-5.1-codex-max** (low/medium/high/xhigh)
- **gpt-5.1-codex** (low/medium/high)
- **gpt-5.1-codex-mini** (medium/high)
- **gpt-5.1** (none/low/medium/high)
---
## 🧩 Configuration
- Modern (OpenCode v1.0.210+): `config/opencode-modern.json`
- Legacy (OpenCode v1.0.209 and below): `config/opencode-legacy.json`

Minimal config is intended for smoke testing only; for stable GPT-5.x variants and presets, use the full configs above.
---
## ✅ Features
- ChatGPT Plus/Pro OAuth authentication (official flow)
- Multi-account support: add multiple ChatGPT accounts and rotate automatically on rate limits/auth failures
- 26 model presets across GPT‑5.3 Codex / GPT‑5.2 / GPT‑5.2 Codex / GPT‑5.1 families
- Variant system support (v1.0.210+) + legacy presets
- Multimodal input enabled for all models
- Usage‑aware errors + automatic token refresh

## 🔄 Multi-Account Rotation

Add accounts by running login multiple times:

```bash
opencode auth login
opencode auth login
opencode auth login
```

The plugin stores account pool state in:

- `~/.opencode/codex-auth-accounts.json`

Runtime strategy is configured in:

- `~/.opencode/codex-auth-config.json`

Example:

```json
{
  "codexMode": true,
  "accountSelectionStrategy": "round_robin",
  "rateLimitCooldownSeconds": 300,
  "authFailureCooldownSeconds": 90,
  "maxAccountsPerRequest": 5
}
```

Available strategies:

- `round_robin` (default): rotate through eligible accounts
- `sticky`: keep using last successful account until it cools down or fails

### Account Manager

View and manage your logged-in accounts with an interactive TUI.

**Via `opencode auth login`** (recommended):

Select "Manage Accounts" from the login method list to open the account manager panel directly within OpenCode.

**Via CLI**:

```bash
npx -y opencode-codex-auth@latest --accounts
```

The panel shows each account's status (active, cooldown, disabled, expired), last used time, and lets you:

- Enable/disable individual accounts
- Clear cooldown timers
- Delete accounts
- View detailed account info (token expiry, failure count, cooldown remaining)

---
## 📚 Docs
- Getting Started: `docs/getting-started.md`
- Configuration: `docs/configuration.md`
- Troubleshooting: `docs/troubleshooting.md`
- Architecture: `docs/development/ARCHITECTURE.md`
---
## ⚠️ Usage Notice
This plugin is for **personal development use** with your own ChatGPT Plus/Pro subscription.
For production or multi‑user applications, use the OpenAI Platform API.

**Built for developers who value simplicity.**
