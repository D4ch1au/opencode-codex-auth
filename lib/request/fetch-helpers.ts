/**
 * Helper functions for the custom fetch implementation
 * These functions break down the complex fetch logic into manageable, testable units
 */

import type { Auth } from "@opencode-ai/sdk";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { refreshAccessToken, refreshAccessTokenWithRetry } from "../auth/auth.js";
import { logRequest } from "../logger.js";
import { getCodexInstructions, getModelFamily } from "../prompts/codex.js";
import { processCodexInstructions } from "../prompts/evil-codex.js";
import { transformRequestBody, normalizeModel } from "./request-transformer.js";
import { convertSseToJson, ensureContentType } from "./response-handler.js";
import type {
	AccountRateLimitSnapshot,
	AccountRateLimitWindow,
	RequestBody,
	TokenResult,
	UserConfig,
} from "../types.js";
import {
	PLUGIN_NAME,
	HTTP_STATUS,
	OPENAI_HEADERS,
	OPENAI_HEADER_VALUES,
	CODEX_CLIENT,
	URL_PATHS,
	ERROR_MESSAGES,
	LOG_STAGES,
} from "../constants.js";


const refreshLocks = new Map<string, Promise<TokenResult>>();

/**
 * Determines if the current auth token needs to be refreshed
 * @param auth - Current authentication state
 * @returns True if token is expired or invalid
 */
export function shouldRefreshToken(auth: Auth): boolean {
	return auth.type !== "oauth" || !auth.access || auth.expires < Date.now();
}

/**
 * Refreshes the OAuth token and updates stored credentials
 * @param currentAuth - Current auth state
 * @param client - Opencode client for updating stored credentials
 * @returns Updated auth (throws on failure)
 */
export async function refreshAndUpdateToken(
	currentAuth: Auth,
	client: OpencodeClient,
	authPathId = "openai",
): Promise<Auth> {
	const refreshToken = currentAuth.type === "oauth" ? currentAuth.refresh : "";
	const refreshResult = await refreshAccessToken(refreshToken);

	if (refreshResult.type === "failed") {
		throw new Error(ERROR_MESSAGES.TOKEN_REFRESH_FAILED);
	}

	// Update stored credentials
	await client.auth.set({
		path: { id: authPathId },
		body: {
			type: "oauth",
			access: refreshResult.access,
			refresh: refreshResult.refresh,
			expires: refreshResult.expires,
		},
	});

	// Update current auth reference if it's OAuth type
	if (currentAuth.type === "oauth") {
		currentAuth.access = refreshResult.access;
		currentAuth.refresh = refreshResult.refresh;
		currentAuth.expires = refreshResult.expires;
	}

	return currentAuth;
}

/**
 * Refresh account tokens with per-account lock to avoid duplicate refresh requests.
 */
export async function refreshAccountTokenWithLock(
	accountId: string,
	refreshToken: string,
): Promise<TokenResult> {
	const existing = refreshLocks.get(accountId);
	if (existing) {
		return existing;
	}

	const refreshPromise = refreshAccessTokenWithRetry(refreshToken)
		.finally(() => {
			refreshLocks.delete(accountId);
		});

	refreshLocks.set(accountId, refreshPromise);
	return refreshPromise;
}

/**
 * Extracts URL string from various request input types
 * @param input - Request input (string, URL, or Request object)
 * @returns URL string
 */
export function extractRequestUrl(input: Request | string | URL): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	return input.url;
}

/**
 * Rewrites OpenAI API URLs to Codex backend URLs
 * @param url - Original URL
 * @returns Rewritten URL for Codex backend
 */
export function rewriteUrlForCodex(url: string): string {
	return url.replace(URL_PATHS.RESPONSES, URL_PATHS.CODEX_RESPONSES);
}

/**
 * Transforms request body and logs the transformation
 * Fetches model-specific Codex instructions based on the request model
 *
 * @param init - Request init options
 * @param url - Request URL
 * @param userConfig - User configuration
 * @param codexMode - Enable CODEX_MODE (bridge prompt instead of tool remap)
 * @returns Transformed body and updated init, or undefined if no body
 */
export async function transformRequestForCodex(
	init: RequestInit | undefined,
	url: string,
	userConfig: UserConfig,
	codexMode = true,
): Promise<{ body: RequestBody; updatedInit: RequestInit } | undefined> {
	if (!init?.body) return undefined;

	try {
		const body = JSON.parse(init.body as string) as RequestBody;
		const originalModel = body.model;

		// Normalize model first to determine which instructions to fetch
		// This ensures we get the correct model-specific prompt
		const normalizedModel = normalizeModel(originalModel);
		const modelFamily = getModelFamily(normalizedModel);

		// Log original request
		logRequest(LOG_STAGES.BEFORE_TRANSFORM, {
			url,
			originalModel,
			model: body.model,
			hasTools: !!body.tools,
			hasInput: !!body.input,
			inputLength: body.input?.length,
			codexMode,
			body: body as unknown as Record<string, unknown>,
		});

		// Fetch model-specific Codex instructions (cached per model family)
		const rawCodexInstructions = await getCodexInstructions(normalizedModel);

		// Process instructions with evil-opencode mode: remove guardrails and add unrestricted prompt
		const codexInstructions = processCodexInstructions(rawCodexInstructions);

		// Transform request body
		const transformedBody = await transformRequestBody(
			body,
			codexInstructions,
			userConfig,
			codexMode,
		);

		// Log transformed request
		logRequest(LOG_STAGES.AFTER_TRANSFORM, {
			url,
			originalModel,
			normalizedModel: transformedBody.model,
			modelFamily,
			hasTools: !!transformedBody.tools,
			hasInput: !!transformedBody.input,
			inputLength: transformedBody.input?.length,
			reasoning: transformedBody.reasoning as unknown,
			textVerbosity: transformedBody.text?.verbosity,
			include: transformedBody.include,
			body: transformedBody as unknown as Record<string, unknown>,
		});

		return {
			body: transformedBody,
			updatedInit: { ...init, body: JSON.stringify(transformedBody) },
		};
	} catch (e) {
		console.error(`[${PLUGIN_NAME}] ${ERROR_MESSAGES.REQUEST_PARSE_ERROR}:`, e);
		return undefined;
	}
}

/**
 * Creates headers for Codex API requests
 * @param init - Request init options
 * @param accountId - ChatGPT account ID
 * @param accessToken - OAuth access token
 * @returns Headers object with all required Codex headers
 */
export function createCodexHeaders(
    init: RequestInit | undefined,
    accountId: string,
    accessToken: string,
    opts?: { model?: string; promptCacheKey?: string },
): Headers {
	const headers = new Headers(init?.headers ?? {});
	headers.delete("x-api-key");
	headers.set("Authorization", `Bearer ${accessToken}`);
	headers.set(OPENAI_HEADERS.ACCOUNT_ID, accountId);
	headers.set(OPENAI_HEADERS.ORIGINATOR, OPENAI_HEADER_VALUES.ORIGINATOR_CODEX);

	// Fingerprint: User-Agent only — official CLI does NOT send Version,
	// Connection, or OpenAI-Beta headers for SSE connections.
	// Reference: codex-rs/core/src/default_client.rs default_headers()
	headers.set("User-Agent", CODEX_CLIENT.USER_AGENT);

	// Official CLI only sets session_id (not conversation_id).
	// Reference: codex-rs/codex-api/src/requests/headers.rs build_conversation_headers()
    const cacheKey = opts?.promptCacheKey;
    if (cacheKey) {
        headers.set(OPENAI_HEADERS.SESSION_ID, cacheKey);
    } else {
        headers.delete(OPENAI_HEADERS.SESSION_ID);
    }
    headers.set("accept", "text/event-stream");
    return headers;
}

/**
 * Handles error responses from the Codex API
 * @param response - Error response from API
 * @returns Original response or mapped retryable response
 */
export async function handleErrorResponse(
    response: Response,
): Promise<Response> {
	const mapped = await mapUsageLimit404(response);
	const finalResponse = mapped ?? response;

	logRequest(LOG_STAGES.ERROR_RESPONSE, {
		status: finalResponse.status,
		statusText: finalResponse.statusText,
	});

	return finalResponse;
}

/**
 * Handles successful responses from the Codex API
 * Converts SSE to JSON for non-streaming requests (generateText)
 * Passes through SSE for streaming requests (streamText)
 * @param response - Success response from API
 * @param isStreaming - Whether this is a streaming request (stream=true in body)
 * @returns Processed response (SSE→JSON for non-streaming, stream for streaming)
 */
export async function handleSuccessResponse(
    response: Response,
    isStreaming: boolean,
): Promise<Response> {
    const responseHeaders = ensureContentType(response.headers);

	// For non-streaming requests (generateText), convert SSE to JSON
	if (!isStreaming) {
		return await convertSseToJson(response, responseHeaders);
	}

	// For streaming requests (streamText), return stream as-is
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers: responseHeaders,
	});
}

const PRIMARY_USED_SUFFIX = "-primary-used-percent";
const SECONDARY_USED_SUFFIX = "-secondary-used-percent";

function parseHeaderNumber(
	headers: Map<string, string>,
	key: string,
): number | undefined {
	const raw = headers.get(key);
	if (!raw) return undefined;
	const value = Number(raw);
	return Number.isFinite(value) ? value : undefined;
}

function parseHeaderInteger(
	headers: Map<string, string>,
	key: string,
): number | undefined {
	const raw = headers.get(key);
	if (!raw) return undefined;
	const value = Number.parseInt(raw, 10);
	return Number.isFinite(value) ? value : undefined;
}

function pickRateLimitPrefix(headers: Map<string, string>): string | undefined {
	if (
		headers.has(`x-codex${PRIMARY_USED_SUFFIX}`)
		|| headers.has(`x-codex${SECONDARY_USED_SUFFIX}`)
	) {
		return "x-codex";
	}

	for (const key of headers.keys()) {
		if (key.endsWith(PRIMARY_USED_SUFFIX)) {
			return key.slice(0, -PRIMARY_USED_SUFFIX.length);
		}
		if (key.endsWith(SECONDARY_USED_SUFFIX)) {
			return key.slice(0, -SECONDARY_USED_SUFFIX.length);
		}
	}

	return undefined;
}

function parseRateLimitWindow(
	headers: Map<string, string>,
	prefix: string,
	window: "primary" | "secondary",
): AccountRateLimitWindow | undefined {
	const usedPercent = parseHeaderNumber(headers, `${prefix}-${window}-used-percent`);
	if (usedPercent === undefined) return undefined;

	const clampedUsed = Math.min(100, Math.max(0, usedPercent));
	const remainingPercent = Math.min(100, Math.max(0, 100 - clampedUsed));
	const windowMinutes = parseHeaderInteger(headers, `${prefix}-${window}-window-minutes`);
	const resetAtSeconds = parseHeaderInteger(headers, `${prefix}-${window}-reset-at`);

	return {
		usedPercent: clampedUsed,
		remainingPercent,
		windowMinutes,
		resetsAt: resetAtSeconds !== undefined ? resetAtSeconds * 1000 : undefined,
	};
}

export function extractAccountRateLimits(
	headers: Headers,
	now = Date.now(),
): AccountRateLimitSnapshot | null {
	const normalizedHeaders = new Map<string, string>();
	for (const [name, value] of headers.entries()) {
		normalizedHeaders.set(name.toLowerCase(), value);
	}

	const prefix = pickRateLimitPrefix(normalizedHeaders);
	if (!prefix) return null;

	const primary = parseRateLimitWindow(normalizedHeaders, prefix, "primary");
	const secondary = parseRateLimitWindow(normalizedHeaders, prefix, "secondary");
	if (!primary && !secondary) return null;

	return {
		primary,
		secondary,
		limitName: normalizedHeaders.get(`${prefix}-limit-name`) || undefined,
		promoMessage: normalizedHeaders.get(`${prefix}-promo-message`) || undefined,
		updatedAt: now,
	};
}

export type AccountErrorClass = "none" | "auth" | "rate_limit";

function hasUsageLimitSignal(text: string): boolean {
	return /usage_limit_reached|usage_not_included|rate_limit_exceeded|usage limit/i.test(text);
}

/**
 * Classify response for multi-account retry behavior.
 */
export async function classifyAccountErrorResponse(
	response: Response,
): Promise<AccountErrorClass> {
	if (response.status === HTTP_STATUS.UNAUTHORIZED || response.status === HTTP_STATUS.TOO_MANY_REQUESTS) {
		return response.status === HTTP_STATUS.UNAUTHORIZED ? "auth" : "rate_limit";
	}

	if (response.status === HTTP_STATUS.NOT_FOUND) {
		const clone = response.clone();
		let payload = "";
		try {
			payload = await clone.text();
		} catch {
			payload = "";
		}

		if (!payload) return "none";

		let code = "";
		try {
			const parsed = JSON.parse(payload) as {
				error?: { code?: unknown; type?: unknown };
			};
			const rawCode = parsed.error?.code ?? parsed.error?.type;
			code = typeof rawCode === "string" ? rawCode : "";
		} catch {
			code = "";
		}

		if (hasUsageLimitSignal(`${code} ${payload}`.toLowerCase())) {
			return "rate_limit";
		}
	}

	if (response.status === HTTP_STATUS.FORBIDDEN) {
		return "auth";
	}

	return "none";
}

/**
 * Parse server-specified retry-after duration from a rate-limit error response.
 * Matches CLIProxyAPI's `parseCodexRetryAfter` logic:
 *  - Only applies to 429 responses with `error.type === "usage_limit_reached"`
 *  - Prefers `error.resets_at` (Unix timestamp) over `error.resets_in_seconds`
 *
 * @returns Cooldown duration in **seconds**, or `null` when unavailable.
 */
export async function parseRetryAfterFromResponse(
	response: Response,
	now = Date.now(),
): Promise<number | null> {
	if (response.status !== HTTP_STATUS.TOO_MANY_REQUESTS) return null;

	const clone = response.clone();
	let body: string;
	try {
		body = await clone.text();
	} catch {
		return null;
	}
	if (!body) return null;

	try {
		const parsed = JSON.parse(body) as {
			error?: {
				type?: string;
				resets_at?: number;
				resets_in_seconds?: number;
			};
		};

		if (parsed?.error?.type !== "usage_limit_reached") return null;

		// Prefer resets_at (absolute Unix timestamp in seconds)
		const resetsAt = parsed.error.resets_at;
		if (typeof resetsAt === "number" && resetsAt > 0) {
			const resetAtMs = resetsAt * 1000;
			if (resetAtMs > now) {
				return Math.ceil((resetAtMs - now) / 1000);
			}
		}

		// Fallback to resets_in_seconds (relative duration)
		const resetsInSeconds = parsed.error.resets_in_seconds;
		if (typeof resetsInSeconds === "number" && resetsInSeconds > 0) {
			return Math.ceil(resetsInSeconds);
		}
	} catch {
		// JSON parse error — no retry info available
	}

	return null;
}

async function mapUsageLimit404(response: Response): Promise<Response | null> {
	if (response.status !== HTTP_STATUS.NOT_FOUND) return null;

	const clone = response.clone();
	let text = "";
	try {
		text = await clone.text();
	} catch {
		text = "";
	}
	if (!text) return null;

	let code = "";
	try {
		const parsed = JSON.parse(text) as any;
		code = (parsed?.error?.code ?? parsed?.error?.type ?? "").toString();
	} catch {
		code = "";
	}

	const haystack = `${code} ${text}`.toLowerCase();
	if (!/usage_limit_reached|usage_not_included|rate_limit_exceeded|usage limit/i.test(haystack)) {
		return null;
	}

	const headers = new Headers(response.headers);
	return new Response(response.body, {
		status: HTTP_STATUS.TOO_MANY_REQUESTS,
		statusText: "Too Many Requests",
		headers,
	});
}
