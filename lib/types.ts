import type { Auth, Provider, Model } from "@opencode-ai/sdk";

/**
 * Plugin configuration from ~/.opencode/openai-codex-auth-config.json
 */
export interface PluginConfig {
	/**
	 * Enable CODEX_MODE (Codex-OpenCode bridge prompt instead of tool remap)
	 * @default true
	 */
	codexMode?: boolean;
	/**
	 * Account selection strategy for multi-account rotation
	 * @default "sticky"
	 */
	accountSelectionStrategy?: AccountSelectionStrategy;
	/**
	 * Cooldown applied after rate limit errors (seconds)
	 * @default 900
	 */
	rateLimitCooldownSeconds?: number;
	/**
	 * Cooldown applied after auth errors (seconds)
	 * @default 270
	 */
	authFailureCooldownSeconds?: number;
	/**
	 * Maximum number of accounts to try per request
	 * @default 1
	 */
	maxAccountsPerRequest?: number;
}

export type AccountSelectionStrategy = "round_robin" | "sticky";

export interface AccountRateLimitWindow {
	usedPercent: number;
	remainingPercent: number;
	windowMinutes?: number;
	resetsAt?: number;
}

export interface AccountRateLimitSnapshot {
	limitName?: string;
	promoMessage?: string;
	primary?: AccountRateLimitWindow;
	secondary?: AccountRateLimitWindow;
	updatedAt: number;
}

export interface OAuthAccountRecord {
	accountId: string;
	access: string;
	refresh: string;
	expires: number;
	addedAt: number;
	updatedAt: number;
	lastUsedAt?: number;
	lastFailureAt?: number;
	failureCount?: number;
	/** Progressive backoff level — incremented on consecutive rate-limit failures, reset on success */
	backoffLevel?: number;
	cooldownUntil?: number;
	disabled?: boolean;
	rateLimits?: AccountRateLimitSnapshot;
}

export interface AccountPoolState {
	version: 1;
	accounts: OAuthAccountRecord[];
	roundRobinCursor: number;
	stickyAccountId?: string;
}

export interface RuntimeAccountConfig {
	strategy: AccountSelectionStrategy;
	rateLimitCooldownSeconds: number;
	authFailureCooldownSeconds: number;
	maxAccountsPerRequest: number;
}

/**
 * User configuration structure from opencode.json
 */
export interface UserConfig {
	global: ConfigOptions;
	models: {
		[modelName: string]: {
			options?: ConfigOptions;
			variants?: Record<string, (ConfigOptions & { disabled?: boolean }) | undefined>;
			[key: string]: unknown;
		};
	};
}

/**
 * Configuration options for reasoning and text settings
 */
export interface ConfigOptions {
	reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
	reasoningSummary?: "auto" | "concise" | "detailed" | "off" | "on";
	textVerbosity?: "low" | "medium" | "high";
	include?: string[];
	/**
	 * Experimental context window override for GPT-5.4 Codex/API.
	 * Sent as `model_context_window`.
	 */
	modelContextWindow?: number;
	/**
	 * Auto-compaction threshold for long-context requests.
	 * Sent as `model_auto_compact_token_limit`.
	 */
	modelAutoCompactTokenLimit?: number;
}

/**
 * Reasoning configuration for requests
 */
export interface ReasoningConfig {
	effort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
	summary: "auto" | "concise" | "detailed" | "off" | "on";
}

/**
 * OAuth server information
 */
export interface OAuthServerInfo {
	port: number;
	ready: boolean;
	close: () => void;
	waitForCode: (state: string) => Promise<{ code: string } | null>;
}

/**
 * PKCE challenge and verifier
 */
export interface PKCEPair {
	challenge: string;
	verifier: string;
}

/**
 * Authorization flow result
 */
export interface AuthorizationFlow {
	pkce: PKCEPair;
	state: string;
	url: string;
}

/**
 * Token exchange success result
 */
export interface TokenSuccess {
	type: "success";
	access: string;
	refresh: string;
	expires: number;
}

/**
 * Token exchange failure result
 */
export interface TokenFailure {
	type: "failed";
}

/**
 * Token exchange result
 */
export type TokenResult = TokenSuccess | TokenFailure;

/**
 * Parsed authorization input
 */
export interface ParsedAuthInput {
	code?: string;
	state?: string;
}

/**
 * JWT payload with ChatGPT account info
 */
export interface JWTPayload {
	"https://api.openai.com/auth"?: {
		chatgpt_account_id?: string;
	};
	[key: string]: unknown;
}

/**
 * Message input item
 */
export interface InputItem {
	id?: string;
	type: string;
	role: string;
	content?: unknown;
	[key: string]: unknown;
}

/**
 * Request body structure
 */
export interface RequestBody {
	model: string;
	store?: boolean;
	stream?: boolean;
	instructions?: string;
	input?: InputItem[];
	tools?: unknown;
	reasoning?: Partial<ReasoningConfig>;
	text?: {
		verbosity?: "low" | "medium" | "high";
	};
	include?: string[];
	providerOptions?: {
		openai?: Partial<ConfigOptions> & { store?: boolean; include?: string[] };
		[key: string]: unknown;
	};
	/** Stable key to enable prompt-token caching on Codex backend */
	prompt_cache_key?: string;
	/** Optional long-context override for supported models (e.g., GPT-5.4). */
	model_context_window?: number;
	/** Optional auto-compaction threshold for long-context runs. */
	model_auto_compact_token_limit?: number;
	max_output_tokens?: number;
	max_completion_tokens?: number;
	[key: string]: unknown;
}

/**
 * SSE event data structure
 */
export interface SSEEventData {
	type: string;
	response?: unknown;
	[key: string]: unknown;
}

/**
 * Cache metadata for Codex instructions
 */
export interface CacheMetadata {
	etag: string | null;
	tag: string;
	lastChecked: number;
	url: string;
}

/**
 * GitHub release data
 */
export interface GitHubRelease {
	tag_name: string;
	[key: string]: unknown;
}

// Re-export SDK types for convenience
export type { Auth, Provider, Model };
