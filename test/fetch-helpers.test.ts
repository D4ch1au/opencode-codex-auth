import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import * as authModule from '../lib/auth/auth.js';
import {
	classifyAccountErrorResponse,
	shouldRefreshToken,
	refreshAndUpdateToken,
	refreshAccountTokenWithLock,
	extractRequestUrl,
	rewriteUrlForCodex,
	createCodexHeaders,
	extractAccountRateLimits,
	handleErrorResponse,
	parseRetryAfterFromResponse,
} from '../lib/request/fetch-helpers.js';
import type { Auth } from '../lib/types.js';
import { URL_PATHS, OPENAI_HEADERS, OPENAI_HEADER_VALUES, CODEX_CLIENT } from '../lib/constants.js';

describe('Fetch Helpers Module', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	beforeEach(() => {
		vi.spyOn(authModule, 'refreshAccessTokenWithRetry').mockImplementation(async (refreshToken: string) => {
			return authModule.refreshAccessToken(refreshToken);
		});
	});

	describe('shouldRefreshToken', () => {
		it('should return true for non-oauth auth', () => {
			const auth: Auth = { type: 'api', key: 'test-key' };
			expect(shouldRefreshToken(auth)).toBe(true);
		});

		it('should return true when access token is missing', () => {
			const auth: Auth = { type: 'oauth', access: '', refresh: 'refresh-token', expires: Date.now() + 1000 };
			expect(shouldRefreshToken(auth)).toBe(true);
		});

		it('should return true when token is expired', () => {
			const auth: Auth = {
				type: 'oauth',
				access: 'access-token',
				refresh: 'refresh-token',
				expires: Date.now() - 1000 // expired
			};
			expect(shouldRefreshToken(auth)).toBe(true);
		});

		it('should return false for valid oauth token', () => {
			const auth: Auth = {
				type: 'oauth',
				access: 'access-token',
				refresh: 'refresh-token',
				expires: Date.now() + 10000 // valid for 10 seconds
			};
			expect(shouldRefreshToken(auth)).toBe(false);
		});
	});

	describe('refreshAndUpdateToken', () => {
		it('throws when refresh fails', async () => {
			const auth: Auth = { type: 'oauth', access: 'old', refresh: 'bad', expires: 0 };
			const client = { auth: { set: vi.fn() } } as any;
			vi.spyOn(authModule, 'refreshAccessToken').mockResolvedValue({ type: 'failed' } as any);

			await expect(refreshAndUpdateToken(auth, client)).rejects.toThrow();
		});

		it('updates stored auth on success', async () => {
			const auth: Auth = { type: 'oauth', access: 'old', refresh: 'oldr', expires: 0 };
			const client = { auth: { set: vi.fn() } } as any;
			vi.spyOn(authModule, 'refreshAccessToken').mockResolvedValue({
				type: 'success',
				access: 'new',
				refresh: 'newr',
				expires: 123,
			} as any);

			const updated = await refreshAndUpdateToken(auth, client);

			expect(client.auth.set).toHaveBeenCalledWith({
				path: { id: 'openai' },
				body: {
					type: 'oauth',
					access: 'new',
					refresh: 'newr',
					expires: 123,
				},
			});
			expect(updated.type).toBe('oauth');
			if (updated.type === 'oauth') {
				expect(updated.access).toBe('new');
				expect(updated.refresh).toBe('newr');
				expect(updated.expires).toBe(123);
			}
		});
	});

	describe('extractRequestUrl', () => {
		it('should extract URL from string', () => {
			const url = 'https://example.com/test';
			expect(extractRequestUrl(url)).toBe(url);
		});

		it('should extract URL from URL object', () => {
			const url = new URL('https://example.com/test');
			expect(extractRequestUrl(url)).toBe('https://example.com/test');
		});

		it('should extract URL from Request object', () => {
			const request = new Request('https://example.com/test');
			expect(extractRequestUrl(request)).toBe('https://example.com/test');
		});
	});

	describe('rewriteUrlForCodex', () => {
		it('should rewrite /responses to /codex/responses', () => {
			const url = 'https://chatgpt.com/backend-api/responses';
			expect(rewriteUrlForCodex(url)).toBe('https://chatgpt.com/backend-api/codex/responses');
		});

		it('should not modify URL without /responses', () => {
			const url = 'https://chatgpt.com/backend-api/other';
			expect(rewriteUrlForCodex(url)).toBe(url);
		});

		it('should only replace first occurrence', () => {
			const url = 'https://example.com/responses/responses';
			const result = rewriteUrlForCodex(url);
			expect(result).toBe('https://example.com/codex/responses/responses');
		});
	});

		describe('createCodexHeaders', () => {
	const accountId = 'test-account-123';
	const accessToken = 'test-access-token';

		it('should create headers with all required fields when cache key provided', () => {
	    const headers = createCodexHeaders(undefined, accountId, accessToken, { model: 'gpt-5-codex', promptCacheKey: 'session-1' });

	    expect(headers.get('Authorization')).toBe(`Bearer ${accessToken}`);
	    expect(headers.get(OPENAI_HEADERS.ACCOUNT_ID)).toBe(accountId);
	    expect(headers.get(OPENAI_HEADERS.BETA)).toBe(OPENAI_HEADER_VALUES.BETA_RESPONSES);
	    expect(headers.get(OPENAI_HEADERS.ORIGINATOR)).toBe(OPENAI_HEADER_VALUES.ORIGINATOR_CODEX);
	    expect(headers.get(OPENAI_HEADERS.SESSION_ID)).toBe('session-1');
	    expect(headers.get(OPENAI_HEADERS.CONVERSATION_ID)).toBe('session-1');
	    expect(headers.get('accept')).toBe('text/event-stream');
    });

		it('maps usage-limit 404 errors to 429', async () => {
			const body = {
				error: {
					code: 'usage_limit_reached',
					message: 'limit reached',
				},
			};
			const resp = new Response(JSON.stringify(body), { status: 404 });
			const mapped = await handleErrorResponse(resp);
			expect(mapped.status).toBe(429);
			const json = await mapped.json() as any;
			expect(json.error.code).toBe('usage_limit_reached');
		});

		it('leaves non-usage 404 errors unchanged', async () => {
			const body = { error: { code: 'not_found', message: 'nope' } };
			const resp = new Response(JSON.stringify(body), { status: 404 });
			const result = await handleErrorResponse(resp);
			expect(result.status).toBe(404);
			const json = await result.json() as any;
			expect(json.error.code).toBe('not_found');
		});

		it('should remove x-api-key header', () => {
        const init = { headers: { 'x-api-key': 'should-be-removed' } } as any;
        const headers = createCodexHeaders(init, accountId, accessToken, { model: 'gpt-5', promptCacheKey: 'session-2' });

			expect(headers.has('x-api-key')).toBe(false);
		});

		it('should preserve other existing headers', () => {
        const init = { headers: { 'Content-Type': 'application/json' } } as any;
        const headers = createCodexHeaders(init, accountId, accessToken, { model: 'gpt-5', promptCacheKey: 'session-3' });

			expect(headers.get('Content-Type')).toBe('application/json');
		});

		it('should use provided promptCacheKey for both conversation_id and session_id', () => {
			const key = 'ses_abc123';
			const headers = createCodexHeaders(undefined, accountId, accessToken, { promptCacheKey: key });
			expect(headers.get(OPENAI_HEADERS.CONVERSATION_ID)).toBe(key);
			expect(headers.get(OPENAI_HEADERS.SESSION_ID)).toBe(key);
		});

		it('does not set conversation/session headers when no promptCacheKey provided', () => {
			const headers = createCodexHeaders(undefined, accountId, accessToken, { model: 'gpt-5' });
			expect(headers.get(OPENAI_HEADERS.CONVERSATION_ID)).toBeNull();
			expect(headers.get(OPENAI_HEADERS.SESSION_ID)).toBeNull();
		});
    });

	describe('classifyAccountErrorResponse', () => {
		it('classifies 429 as rate_limit', async () => {
			const response = new Response('too many requests', { status: 429 });
			await expect(classifyAccountErrorResponse(response)).resolves.toBe('rate_limit');
		});

		it('classifies usage-limit 404 as rate_limit', async () => {
			const response = new Response(
				JSON.stringify({ error: { code: 'usage_limit_reached' } }),
				{ status: 404 },
			);
			await expect(classifyAccountErrorResponse(response)).resolves.toBe('rate_limit');
		});

		it('classifies 401 and 403 as auth', async () => {
			const unauthorized = new Response('unauthorized', { status: 401 });
			const forbidden = new Response('forbidden', { status: 403 });
			await expect(classifyAccountErrorResponse(unauthorized)).resolves.toBe('auth');
			await expect(classifyAccountErrorResponse(forbidden)).resolves.toBe('auth');
		});

		it('returns none for non-retryable statuses', async () => {
			const response = new Response('bad request', { status: 400 });
			await expect(classifyAccountErrorResponse(response)).resolves.toBe('none');
		});
	});

	describe('extractAccountRateLimits', () => {
		it('extracts primary and secondary usage from codex headers', () => {
			const headers = new Headers({
				'x-codex-primary-used-percent': '42.5',
				'x-codex-primary-window-minutes': '300',
				'x-codex-primary-reset-at': '1742000000',
				'x-codex-secondary-used-percent': '10',
				'x-codex-secondary-window-minutes': '10080',
				'x-codex-secondary-reset-at': '1742600000',
				'x-codex-limit-name': 'codex',
			});

			const snapshot = extractAccountRateLimits(headers, 1234567890);

			expect(snapshot).toEqual({
				limitName: 'codex',
				promoMessage: undefined,
				primary: {
					usedPercent: 42.5,
					remainingPercent: 57.5,
					windowMinutes: 300,
					resetsAt: 1742000000_000,
				},
				secondary: {
					usedPercent: 10,
					remainingPercent: 90,
					windowMinutes: 10080,
					resetsAt: 1742600000_000,
				},
				updatedAt: 1234567890,
			});
		});

		it('returns null when no rate-limit headers are present', () => {
			const headers = new Headers({
				'content-type': 'application/json',
			});

			expect(extractAccountRateLimits(headers)).toBeNull();
		});

		it('clamps used percent into [0, 100] range', () => {
			const headers = new Headers({
				'x-codex-primary-used-percent': '250',
			});

			const snapshot = extractAccountRateLimits(headers);
			expect(snapshot?.primary?.usedPercent).toBe(100);
			expect(snapshot?.primary?.remainingPercent).toBe(0);
		});
	});

	describe('createCodexHeaders fingerprint headers', () => {
		const accountId = 'test-account-123';
		const accessToken = 'test-access-token';

		it('sets User-Agent matching official Codex CLI', () => {
			const headers = createCodexHeaders(undefined, accountId, accessToken);
			expect(headers.get('User-Agent')).toBe(CODEX_CLIENT.USER_AGENT);
		});

		it('sets Version header matching official Codex CLI', () => {
			const headers = createCodexHeaders(undefined, accountId, accessToken);
			expect(headers.get('Version')).toBe(CODEX_CLIENT.VERSION);
		});

		it('sets Connection: Keep-Alive header', () => {
			const headers = createCodexHeaders(undefined, accountId, accessToken);
			expect(headers.get('Connection')).toBe('Keep-Alive');
		});
	});

	describe('parseRetryAfterFromResponse', () => {
		it('returns null for non-429 responses', async () => {
			const response = new Response('ok', { status: 200 });
			expect(await parseRetryAfterFromResponse(response)).toBeNull();
		});

		it('returns null for 429 without usage_limit_reached type', async () => {
			const body = { error: { type: 'rate_limit_exceeded', message: 'slow down' } };
			const response = new Response(JSON.stringify(body), { status: 429 });
			expect(await parseRetryAfterFromResponse(response)).toBeNull();
		});

		it('prefers resets_at over resets_in_seconds', async () => {
			const now = 1700000000000; // ms
			const resetsAtUnix = 1700000300; // 300 seconds in the future (in seconds)
			const body = {
				error: {
					type: 'usage_limit_reached',
					resets_at: resetsAtUnix,
					resets_in_seconds: 100,
				},
			};
			const response = new Response(JSON.stringify(body), { status: 429 });
			const result = await parseRetryAfterFromResponse(response, now);
			expect(result).toBe(300);
		});

		it('falls back to resets_in_seconds when resets_at is in the past', async () => {
			const now = 1700000000000;
			const body = {
				error: {
					type: 'usage_limit_reached',
					resets_at: 1699999000, // in the past
					resets_in_seconds: 120,
				},
			};
			const response = new Response(JSON.stringify(body), { status: 429 });
			const result = await parseRetryAfterFromResponse(response, now);
			expect(result).toBe(120);
		});

		it('returns null when 429 body is empty', async () => {
			const response = new Response('', { status: 429 });
			expect(await parseRetryAfterFromResponse(response)).toBeNull();
		});

		it('returns null when 429 body is not valid JSON', async () => {
			const response = new Response('not json', { status: 429 });
			expect(await parseRetryAfterFromResponse(response)).toBeNull();
		});

		it('returns null when error has no reset fields', async () => {
			const body = { error: { type: 'usage_limit_reached' } };
			const response = new Response(JSON.stringify(body), { status: 429 });
			expect(await parseRetryAfterFromResponse(response)).toBeNull();
		});
	});

		describe('refreshAccountTokenWithLock', () => {
		it('shares in-flight refresh promise for same account id', async () => {
			const refreshSpy = vi.spyOn(authModule, 'refreshAccessToken').mockResolvedValue({
				type: 'success',
				access: 'new-access',
				refresh: 'new-refresh',
				expires: 1000,
			});

			const [resultA, resultB] = await Promise.all([
				refreshAccountTokenWithLock('acct-a', 'refresh-token'),
				refreshAccountTokenWithLock('acct-a', 'refresh-token'),
			]);

			expect(refreshSpy).toHaveBeenCalledTimes(1);
			expect(resultA.type).toBe('success');
			expect(resultB.type).toBe('success');
		});
	});
});
