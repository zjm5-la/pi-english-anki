import type { DatabaseSync } from "node:sqlite";
import { getStat, setStat } from "./db.ts";

export const WEEKLY_CHALLENGE_STAT = "weekly_challenge";
export const WEEKLY_CHALLENGE_MS = 7 * 24 * 3600 * 1000;
/** One catch-up generation may deliver at most this many weeks at once. */
export const WEEKLY_CHALLENGE_MAX_PER_RUN = 20;

export interface WeeklyChallengeState {
	version: 1;
	anchor: string;
	delivered: number;
}

/** Load (or initialize) the weekly ledger. The anchor is the learner's first
 * ever learned_at, so weeks before the feature existed are explicitly owed
 * as backfill ("按周算补卡"). */
export function weeklyChallengeState(db: DatabaseSync, now = new Date()): WeeklyChallengeState {
	try {
		const parsed = JSON.parse(getStat(db, WEEKLY_CHALLENGE_STAT) || "null") as WeeklyChallengeState | null;
		if (parsed?.version === 1 && typeof parsed.anchor === "string" && Number.isFinite(Date.parse(parsed.anchor))
			&& Number.isInteger(parsed.delivered) && parsed.delivered >= 0) return parsed;
	} catch { /* overwrite malformed state */ }
	const firstLearned = (db.prepare("SELECT MIN(learned_at) AS m FROM items").get() as { m: string | null }).m;
	const anchor = firstLearned && Number.isFinite(Date.parse(firstLearned)) ? new Date(firstLearned) : now;
	const fresh: WeeklyChallengeState = { version: 1, anchor: anchor.toISOString(), delivered: 0 };
	setStat(db, WEEKLY_CHALLENGE_STAT, JSON.stringify(fresh));
	return fresh;
}

/** Challenge cards still owed: one per elapsed week since the anchor. */
export function weeklyChallengeOwed(state: WeeklyChallengeState, now = new Date()): number {
	const weeks = Math.floor((now.getTime() - Date.parse(state.anchor)) / WEEKLY_CHALLENGE_MS);
	return Math.max(0, weeks - state.delivered);
}

export function recordWeeklyChallengeDelivery(db: DatabaseSync, state: WeeklyChallengeState, count: number): WeeklyChallengeState {
	const updated: WeeklyChallengeState = { ...state, delivered: state.delivered + count };
	setStat(db, WEEKLY_CHALLENGE_STAT, JSON.stringify(updated));
	return updated;
}

/** Challenging yet common: above the learner's current band, but from the
 * frequent vocabulary that exams and social media actually use. */
export function weeklyChallengePrompt(count: number): string {
	return [
		`每周挑战词任务：为这位学习者制作 ${count} 张有挑战性但必须常用的英文词汇卡（word 或 phrase）。`,
		"选词要求：",
		"- 难度必须明显超出学习者当前的 B1 词汇带，目标 B2–C1；太容易的词不要",
		"- 但必须来自高频常用词汇：新闻、社交媒体、日常书面语中常见的表达（雅思 7 分及以上词表、牛津 3000/5000、COCA 3k–8k 频段这一层次），学习者的目标是考试和看懂英文推文",
		"- 严禁生僻词、古旧词、文学腔、窄专业术语；选母语者刷推读报真会遇到的词",
		"- 优先：高频动词短语、常见搭配、高频实词的次要但常用义项",
		"- 每张卡的例句要像推文或新闻里真实出现的句子",
		`数量：${count} 张，互不相同。`,
	].join("\n");
}
