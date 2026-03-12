/**
 * OpenAI ChatGPT (Codex) OAuth Authentication Plugin for opencode
 *
 * COMPLIANCE NOTICE:
 * This plugin uses OpenAI's official OAuth authentication flow (the same method
 * used by OpenAI's official Codex CLI at https://github.com/openai/codex).
 *
 * INTENDED USE: Personal development and coding assistance with your own
 * ChatGPT Plus/Pro subscription.
 *
 * NOT INTENDED FOR: Commercial resale, multi-user services, high-volume
 * automated extraction, or any use that violates OpenAI's Terms of Service.
 *
 * Users are responsible for ensuring their usage complies with:
 * - OpenAI Terms of Use: https://openai.com/policies/terms-of-use/
 * - OpenAI Usage Policies: https://openai.com/policies/usage-policies/
 *
 * For production applications, use the OpenAI Platform API: https://platform.openai.com/
 *
 * @license MIT with Usage Disclaimer (see LICENSE file)
 * @author D4ch1au
 * @repository https://github.com/D4ch1au/opencode-codex-auth
 */

import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import type { Auth } from "@opencode-ai/sdk";
import {
	createAuthorizationFlow,
	exchangeAuthorizationCode,
	parseAuthorizationInput,
	REDIRECT_URI,
} from "./lib/auth/auth.js";
import { openBrowserUrl } from "./lib/auth/browser.js";
import { startLocalOAuthServer } from "./lib/auth/server.js";
import {
	limitAttemptCount,
	markAccountFailure,
	markAccountSuccess,
	saveAccountPoolState,
	selectAccountForRequest,
	shouldRefreshStoredAccount,
	syncCurrentAuthIntoPool,
	updateAccountRateLimits,
	updateAccountTokens,
	upsertTokenSuccessIntoPool,
} from "./lib/account-pool.js";
import {
	getCodexMode,
	getRuntimeAccountConfig,
	loadPluginConfig,
} from "./lib/config.js";
import {
	AUTH_LABELS,
	CODEX_BASE_URL,
	DUMMY_API_KEY,
	LOG_STAGES,
	PROVIDER_ID,
} from "./lib/constants.js";
import { logRequest, logDebug } from "./lib/logger.js";
import { warmCodexInstructionsCache } from "./lib/prompts/codex.js";
import {
	classifyAccountErrorResponse,
	createCodexHeaders,
	extractAccountRateLimits,
	extractRequestUrl,
	handleErrorResponse,
	handleSuccessResponse,
	parseRetryAfterFromResponse,
	refreshAccountTokenWithLock,
	rewriteUrlForCodex,
	transformRequestForCodex,
} from "./lib/request/fetch-helpers.js";
import type { UserConfig } from "./lib/types.js";
import { manageAccounts } from "./lib/ui/account-manager.js";

/**
 * OpenAI Codex OAuth authentication plugin for opencode
 *
 * This plugin enables opencode to use OpenAI's Codex backend via ChatGPT Plus/Pro
 * OAuth authentication, allowing users to leverage their ChatGPT subscription
 * instead of OpenAI Platform API credits.
 *
 * @example
 * ```json
 * {
 *   "plugin": ["opencode-codex-auth"],
 *   "model": "openai/gpt-5-codex"
 * }
 * ```
 */
export const OpenAIAuthPlugin: Plugin = async ({ client }: PluginInput) => {
	const buildManualOAuthFlow = (pkce: { verifier: string }, url: string) => ({
		url,
		method: "code" as const,
		instructions: AUTH_LABELS.INSTRUCTIONS_MANUAL,
		callback: async (input: string) => {
			const parsed = parseAuthorizationInput(input);
			if (!parsed.code) {
				return { type: "failed" as const };
			}
			const tokens = await exchangeAuthorizationCode(
				parsed.code,
				pkce.verifier,
				REDIRECT_URI,
			);
			if (tokens?.type === "success") {
				upsertTokenSuccessIntoPool(tokens);
				return tokens;
			}
			return { type: "failed" as const };
		},
	});
	return {
		auth: {
			provider: PROVIDER_ID,
			/**
			 * Loader function that configures OAuth authentication and request handling
			 *
			 * This function:
			 * 1. Validates OAuth authentication
			 * 2. Extracts ChatGPT account ID from access token
			 * 3. Loads user configuration from opencode.json
			 * 4. Fetches Codex system instructions from GitHub (cached)
			 * 5. Returns SDK configuration with custom fetch implementation
			 *
			 * @param getAuth - Function to retrieve current auth state
			 * @param provider - Provider configuration from opencode.json
			 * @returns SDK configuration object or empty object for non-OAuth auth
			 */
			async loader(getAuth: () => Promise<Auth>, provider: unknown) {
				const auth = await getAuth();

				// Only handle OAuth auth type, skip API key auth
				if (auth.type !== "oauth") {
					return {};
				}

				const syncResult = syncCurrentAuthIntoPool(auth);
				if (syncResult.pool.accounts.length === 0) {
					logDebug("No valid OAuth account could be loaded into account pool");
					return {};
				}
				// Extract user configuration (global + per-model options)
				const providerConfig = provider as
					| { options?: Record<string, unknown>; models?: UserConfig["models"] }
					| undefined;
				const userConfig: UserConfig = {
					global: providerConfig?.options || {},
					models: providerConfig?.models || {},
				};

				// Load plugin configuration and determine CODEX_MODE
				// Priority: CODEX_MODE env var > config file > default (true)
				const pluginConfig = loadPluginConfig();
				const codexMode = getCodexMode(pluginConfig);
				const runtimeAccountConfig = getRuntimeAccountConfig(pluginConfig);

				// Pre-warm Codex instructions cache (fire-and-forget, non-blocking)
				warmCodexInstructionsCache();

				// Return SDK configuration
				return {
					apiKey: DUMMY_API_KEY,
					baseURL: CODEX_BASE_URL,
					/**
					 * Custom fetch implementation for Codex API
					 *
					 * Handles:
					 * - Token refresh when expired
					 * - URL rewriting for Codex backend
					 * - Request body transformation
					 * - OAuth header injection
					 * - SSE to JSON conversion for non-tool requests
					 * - Error handling and logging
					 *
					 * @param input - Request URL or Request object
					 * @param init - Request options
					 * @returns Response from Codex API
					 */
					async fetch(
						input: Request | string | URL,
						init?: RequestInit,
					): Promise<Response> {
						const latestAuth = await getAuth();
						const synced = syncCurrentAuthIntoPool(latestAuth);
						const accountPool = synced.pool;
						const primaryAccountId = synced.activeAccount?.accountId;

						if (accountPool.accounts.length === 0) {
							return new Response(
								JSON.stringify({
									error: {
										code: "no_oauth_accounts",
										message:
											"No OAuth accounts are available. Run `opencode auth login` to add an account.",
									},
								}),
								{
									status: 429,
									headers: {
										"content-type": "application/json",
									},
								},
							);
						}

						// Step 2: Extract and rewrite URL for Codex backend
						const originalUrl = extractRequestUrl(input);
						const url = rewriteUrlForCodex(originalUrl);

						// Step 3: Transform request body with model-specific Codex instructions
					// Instructions are fetched per model family (gpt-5.4, gpt-5.3-codex, gpt-5.2-codex, codex-max, codex, gpt-5.2, gpt-5.1)
						// Capture original stream value before transformation
						// generateText() sends no stream field, streamText() sends stream=true
						const originalBody = init?.body ? JSON.parse(init.body as string) : {};
						const isStreaming = originalBody.stream === true;

						const transformation = await transformRequestForCodex(
							init,
							url,
							userConfig,
							codexMode,
						);
						const requestInit = transformation?.updatedInit ?? init;

						const attemptLimit = limitAttemptCount(accountPool, runtimeAccountConfig);
						const attemptedAccounts = new Set<string>();
						let lastResponse: Response | null = null;

						for (let attempt = 0; attempt < attemptLimit; attempt += 1) {
							const now = Date.now();
							const selectedAccount = selectAccountForRequest(
								accountPool,
								runtimeAccountConfig.strategy,
								now,
							);

							if (!selectedAccount) {
								break;
							}

							if (attemptedAccounts.has(selectedAccount.accountId)) {
								continue;
							}

					attemptedAccounts.add(selectedAccount.accountId);

					if (shouldRefreshStoredAccount(selectedAccount, now)) {
								const refreshResult = await refreshAccountTokenWithLock(
									selectedAccount.accountId,
									selectedAccount.refresh,
								);

								if (refreshResult.type === "failed") {
									markAccountFailure(
										accountPool,
										selectedAccount.accountId,
										runtimeAccountConfig.authFailureCooldownSeconds,
										now,
									);
									saveAccountPoolState(accountPool);
									continue;
								}

								const updated = updateAccountTokens(
									accountPool,
									selectedAccount.accountId,
									refreshResult,
									now,
								);
								saveAccountPoolState(accountPool);

								if (updated && primaryAccountId === updated.accountId) {
									await client.auth.set({
										path: { id: PROVIDER_ID },
										body: {
											type: "oauth",
											access: updated.access,
											refresh: updated.refresh,
											expires: updated.expires,
										},
									});
								}
							}

							const activeAccount =
								accountPool.accounts.find(
									(account) => account.accountId === selectedAccount.accountId,
								)
								?? selectedAccount;

							const requestOptions = {
								model: transformation?.body.model,
								promptCacheKey: transformation?.body.prompt_cache_key,
							};
							let responseAccountId = activeAccount.accountId;
							let hasRateLimitSnapshot = false;

							let headers = createCodexHeaders(
								requestInit,
								activeAccount.accountId,
								activeAccount.access,
								requestOptions,
							);

							let response = await fetch(url, {
								...requestInit,
								headers,
							});

							logRequest(LOG_STAGES.RESPONSE, {
								accountId: activeAccount.accountId,
								status: response.status,
								ok: response.ok,
								statusText: response.statusText,
								headers: Object.fromEntries(response.headers.entries()),
							});

							const initialRateLimits = extractAccountRateLimits(response.headers);
							if (initialRateLimits) {
								hasRateLimitSnapshot =
									updateAccountRateLimits(
										accountPool,
										responseAccountId,
										initialRateLimits,
										Date.now(),
									) !== null;
							}

							let errorClass = response.ok
								? "none"
								: await classifyAccountErrorResponse(response);

							if (errorClass === "auth") {
								const refreshResult = await refreshAccountTokenWithLock(
									activeAccount.accountId,
									activeAccount.refresh,
								);

								if (refreshResult.type === "success") {
									const updated = updateAccountTokens(
										accountPool,
										activeAccount.accountId,
										refreshResult,
										Date.now(),
									);
									saveAccountPoolState(accountPool);

									if (updated && primaryAccountId === updated.accountId) {
										await client.auth.set({
											path: { id: PROVIDER_ID },
											body: {
												type: "oauth",
												access: updated.access,
												refresh: updated.refresh,
												expires: updated.expires,
											},
										});
									}

									if (updated) {
										responseAccountId = updated.accountId;
										headers = createCodexHeaders(
											requestInit,
											updated.accountId,
											updated.access,
											requestOptions,
										);

										response = await fetch(url, {
											...requestInit,
											headers,
										});

										logRequest(LOG_STAGES.RESPONSE, {
											accountId: updated.accountId,
											status: response.status,
											ok: response.ok,
											statusText: response.statusText,
											headers: Object.fromEntries(response.headers.entries()),
										});

										const refreshedRateLimits = extractAccountRateLimits(
											response.headers,
										);
										if (refreshedRateLimits) {
											hasRateLimitSnapshot =
												updateAccountRateLimits(
													accountPool,
													responseAccountId,
													refreshedRateLimits,
													Date.now(),
												) !== null
												|| hasRateLimitSnapshot;
										}

										errorClass = response.ok
											? "none"
											: await classifyAccountErrorResponse(response);
									}
								}
							}

							if (response.ok) {
								markAccountSuccess(accountPool, responseAccountId, Date.now());
								saveAccountPoolState(accountPool);
								return await handleSuccessResponse(response, isStreaming);
							}

							if (errorClass === "rate_limit" || errorClass === "auth") {
								let cooldownSeconds: number;

								if (errorClass === "rate_limit") {
									const serverRetryAfter = await parseRetryAfterFromResponse(response);
									cooldownSeconds =
										serverRetryAfter != null
											? Math.max(serverRetryAfter, 60)
											: runtimeAccountConfig.rateLimitCooldownSeconds;
								} else {
									cooldownSeconds = runtimeAccountConfig.authFailureCooldownSeconds;
								}

								markAccountFailure(
									accountPool,
									responseAccountId,
									cooldownSeconds,
									Date.now(),
								);
								saveAccountPoolState(accountPool);
								lastResponse = response;
								continue;
							}

							if (hasRateLimitSnapshot) {
								saveAccountPoolState(accountPool);
							}

							return await handleErrorResponse(response);
						}

						if (lastResponse) {
							return await handleErrorResponse(lastResponse);
						}

						return new Response(
							JSON.stringify({
								error: {
									code: "all_accounts_unavailable",
									message:
										"All configured OAuth accounts are temporarily unavailable. Please retry after cooldown or add more accounts.",
								},
							}),
							{
								status: 429,
								headers: {
									"content-type": "application/json",
								},
							},
						);
					},
				};
			},
				methods: [
					{
						label: AUTH_LABELS.OAUTH,
						type: "oauth" as const,
					/**
					 * OAuth authorization flow
					 *
					 * Steps:
					 * 1. Generate PKCE challenge and state for security
					 * 2. Start local OAuth callback server on port 1455
					 * 3. Open browser to OpenAI authorization page
					 * 4. Wait for user to complete login
					 * 5. Exchange authorization code for tokens
					 *
					 * @returns Authorization flow configuration
					 */
					authorize: async () => {
						const { pkce, state, url } = await createAuthorizationFlow();
						const serverInfo = await startLocalOAuthServer({ state });

						// Attempt to open browser automatically
						openBrowserUrl(url);

						if (!serverInfo.ready) {
							serverInfo.close();
							return buildManualOAuthFlow(pkce, url);
						}

						return {
							url,
							method: "auto" as const,
							instructions: AUTH_LABELS.INSTRUCTIONS,
							callback: async () => {
								const result = await serverInfo.waitForCode(state);
								serverInfo.close();

								if (!result) {
									return { type: "failed" as const };
								}

							const tokens = await exchangeAuthorizationCode(
								result.code,
								pkce.verifier,
								REDIRECT_URI,
							);

							if (tokens?.type === "success") {
								upsertTokenSuccessIntoPool(tokens);
								return tokens;
							}

							return { type: "failed" as const };
						},
					};
					},
					},
					{
						label: AUTH_LABELS.OAUTH_MANUAL,
						type: "oauth" as const,
						authorize: async () => {
							const { pkce, url } = await createAuthorizationFlow();
							return buildManualOAuthFlow(pkce, url);
						},
					},
				{
					label: AUTH_LABELS.API_KEY,
					type: "api" as const,
				},
				{
					label: AUTH_LABELS.MANAGE_ACCOUNTS,
					type: "api" as const,
					authorize: async () => {
						await manageAccounts();
						return { type: "failed" as const };
					},
				},
		],
		},
	};
};

export default OpenAIAuthPlugin;
