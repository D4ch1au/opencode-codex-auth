import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type {
	AccountSelectionStrategy,
	PluginConfig,
	RuntimeAccountConfig,
} from "./types.js";

const CONFIG_PATH = join(homedir(), ".opencode", "codex-auth-config.json");

/**
 * Default plugin configuration
 * CODEX_MODE is enabled by default for better Codex CLI parity
 */
const DEFAULT_CONFIG: PluginConfig = {
	codexMode: true,
	accountSelectionStrategy: "round_robin",
	rateLimitCooldownSeconds: 300,
	authFailureCooldownSeconds: 90,
	maxAccountsPerRequest: 5,
};

const ALLOWED_SELECTION_STRATEGIES: ReadonlySet<AccountSelectionStrategy> = new Set([
	"round_robin",
	"sticky",
]);

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return fallback;
	}
	const int = Math.trunc(value);
	if (int < min) return min;
	if (int > max) return max;
	return int;
}

function normalizePluginConfig(userConfig: Partial<PluginConfig>): PluginConfig {
	const strategyCandidate = userConfig.accountSelectionStrategy;
	const strategy =
		typeof strategyCandidate === "string"
		&& ALLOWED_SELECTION_STRATEGIES.has(strategyCandidate as AccountSelectionStrategy)
			? (strategyCandidate as AccountSelectionStrategy)
			: DEFAULT_CONFIG.accountSelectionStrategy;

	return {
		...DEFAULT_CONFIG,
		...userConfig,
		accountSelectionStrategy: strategy,
		rateLimitCooldownSeconds: clampInteger(
			userConfig.rateLimitCooldownSeconds,
			DEFAULT_CONFIG.rateLimitCooldownSeconds ?? 300,
			1,
			7200,
		),
		authFailureCooldownSeconds: clampInteger(
			userConfig.authFailureCooldownSeconds,
			DEFAULT_CONFIG.authFailureCooldownSeconds ?? 90,
			0,
			3600,
		),
		maxAccountsPerRequest: clampInteger(
			userConfig.maxAccountsPerRequest,
			DEFAULT_CONFIG.maxAccountsPerRequest ?? 5,
			1,
			32,
		),
	};
}

/**
 * Load plugin configuration from ~/.opencode/openai-codex-auth-config.json
 * Falls back to defaults if file doesn't exist or is invalid
 *
 * @returns Plugin configuration
 */
export function loadPluginConfig(): PluginConfig {
	try {
		if (!existsSync(CONFIG_PATH)) {
			return DEFAULT_CONFIG;
		}

		const fileContent = readFileSync(CONFIG_PATH, "utf-8");
		const userConfig = JSON.parse(fileContent) as Partial<PluginConfig>;

		return normalizePluginConfig(userConfig);
	} catch (error) {
		console.warn(
			`[opencode-codex-auth] Failed to load config from ${CONFIG_PATH}:`,
			(error as Error).message
		);
		return DEFAULT_CONFIG;
	}
}

/**
 * Get the effective CODEX_MODE setting
 * Priority: environment variable > config file > default (true)
 *
 * @param pluginConfig - Plugin configuration from file
 * @returns True if CODEX_MODE should be enabled
 */
export function getCodexMode(pluginConfig: PluginConfig): boolean {
	// Environment variable takes precedence
	if (process.env.CODEX_MODE !== undefined) {
		return process.env.CODEX_MODE === "1";
	}

	// Use config setting (defaults to true)
	return pluginConfig.codexMode ?? true;
}

export function getRuntimeAccountConfig(pluginConfig: PluginConfig): RuntimeAccountConfig {
	return {
		strategy: pluginConfig.accountSelectionStrategy ?? "round_robin",
		rateLimitCooldownSeconds: pluginConfig.rateLimitCooldownSeconds ?? 300,
		authFailureCooldownSeconds: pluginConfig.authFailureCooldownSeconds ?? 90,
		maxAccountsPerRequest: pluginConfig.maxAccountsPerRequest ?? 5,
	};
}
