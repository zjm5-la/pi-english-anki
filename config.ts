import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// -- Configuration --------------------------------------------------------

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface PetConfig {
	provider?: string;
	model?: string;
	/** Reasoning/thinking level passed to the model. Omit for provider default. */
	thinkingLevel?: ThinkingLevel;
	/** Minutes between automatic lesson/review checks. Zero disables the timer. */
	intervalMinutes: number;
	/** Fixed daily limit, or the hard ceiling when adaptiveNewCards is enabled. */
	dailyNewLimit: number;
	/** Let recent recall quality and due-review load choose today's limit. */
	adaptiveNewCards: boolean;
	showWidget: boolean;
	verbose: boolean;
}

/** Maximum composition of one generation call; adaptive days may use two calls. */
export const LESSON_WORD_ITEMS = 10;
export const LESSON_CLOZE_ITEMS = 1;
export const ADAPTIVE_START_NEW_ITEMS = 17;
export const ADAPTIVE_MAX_NEW_ITEMS = 22;
/** Each generation call is words-majority: phrases may not exceed this count. */
export const LESSON_MAX_PHRASES = 3;

/** Upper bound on cards a single /anki:add may enqueue (safety clamp). */
export const MAX_CUSTOM_PER_ADD = 20;

export const DEFAULTS: PetConfig = {
	intervalMinutes: 10,
	dailyNewLimit: ADAPTIVE_MAX_NEW_ITEMS,
	adaptiveNewCards: true,
	showWidget: true,
	verbose: false,
};

/** Models to try in order when no explicit model is configured. */
export const AUTO_DETECT_MODELS = [
	"gpt-5.4-mini",
	"deepseek-v4-flash",
	"grok-4.3",
	"glm-5.2",
];
export function loadConfig(cwd: string): PetConfig {
	const globalPath = join(getAgentDir(), "kaomoji-english-tutor.json");
	const projectPath = join(cwd, ".pi", "kaomoji-english-tutor.json");

	let config: PetConfig = { ...DEFAULTS };

	for (const path of [globalPath, projectPath]) {
		if (existsSync(path)) {
			try {
				const parsed = JSON.parse(readFileSync(path, "utf-8"));
				config = { ...config, ...parsed };
			} catch (err) {
				console.error(`[kaomoji-english-tutor] Failed to load config from ${path}: ${err}`);
			}
		}
	}

	if (!Number.isFinite(config.intervalMinutes) || config.intervalMinutes < 0 || config.intervalMinutes > 1440) {
		config.intervalMinutes = DEFAULTS.intervalMinutes;
	}
	if (!Number.isFinite(config.dailyNewLimit) || config.dailyNewLimit < 0) {
		config.dailyNewLimit = DEFAULTS.dailyNewLimit;
	} else {
		config.dailyNewLimit = Math.floor(config.dailyNewLimit);
	}
	return config;
}
