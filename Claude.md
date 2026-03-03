# Claude.md

## Recent Changes

### 2026-03-03

- Added multi-account account-pool storage in `lib/account-pool.ts` with cooldown/failure tracking and selection state.
- Added plugin config fields for account routing in `lib/types.ts` and `lib/config.ts`:
  - `accountSelectionStrategy`
  - `rateLimitCooldownSeconds`
  - `authFailureCooldownSeconds`
  - `maxAccountsPerRequest`
- Updated `index.ts` fetch flow to:
  - sync current OAuth token into account pool
  - select accounts per request (`round_robin` or `sticky`)
  - refresh per-account token with lock
  - retry on rate-limit/auth failures by rotating accounts
- Added per-account refresh lock and response classification helpers in `lib/request/fetch-helpers.ts`.
- Added tests:
  - `test/account-pool.test.ts`
  - updates to `test/fetch-helpers.test.ts`
  - updates to `test/plugin-config.test.ts`
- Updated `README.md` with multi-account rotation usage and config examples.
- Added GPT-5.3 Codex model support end-to-end:
  - model normalization and map entries in `lib/request/helpers/model-map.ts` and `lib/request/request-transformer.ts`
  - model family prompt selection + cache key in `lib/prompts/codex.ts`
  - config templates in `config/opencode-modern.json` and `config/opencode-legacy.json`
  - cache cleanup entries in `scripts/install-opencode-codex-auth.js`
  - test coverage updates in `test/request-transformer.test.ts`, `test/codex.test.ts`, `test/config.test.ts`, and `test/install-script.test.ts`
- Hardened after Oracle review:
  - added bundled fallback instructions file `lib/prompts/codex-instructions.md` and build copy step in `package.json`
  - fixed prefixed model per-model option lookup (`openai/...`) in `lib/request/request-transformer.ts`
  - `--uninstall --all` now removes `~/.opencode/codex-auth-accounts.json`
  - expanded uninstall tests for account-pool and GPT-5.3 cache cleanup
