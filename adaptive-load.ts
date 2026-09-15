import type { DatabaseSync } from "node:sqlite";
import {
	ADAPTIVE_MAX_NEW_ITEMS,
	ADAPTIVE_START_NEW_ITEMS,
	LESSON_CLOZE_ITEMS,
	LESSON_WORD_ITEMS,
	type PetConfig,
} from "./config.ts";
import { countTodayNew, getStat, SCHEDULABLE, setStat } from "./db.ts";
import { computeLearnerProfile } from "./learner-profile.ts";

const RAMP_STEP_DAYS = 14;
const MIN_RAMP_EVIDENCE = 30;
const START_STAT = "adaptive_new_started_on";
export const DAILY_LOAD_PLAN_STAT = "adaptive_new_plan";

export interface DailyLoadSignals {
	dayIndex: number;
	dueReviews: number;
	recallEvidence: number;
	recallRate: number | null;
	assistanceRate: number | null;
}

export interface DailyLoadPlan {
	adaptive: boolean;
	limit: number;
	paused: boolean;
	wordTarget: number;
	clozeTarget: number;
	rampTarget: number;
	dueReviews: number;
	reason: string;
}

export interface LessonBatchPlan {
	wordItems: number;
	clozeItems: number;
}

function localDateKey(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function localDayStartIso(date: Date): string {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate()).toISOString();
}

function localDayIndex(startKey: string, now: Date): number {
	const [year, month, day] = startKey.split("-").map(Number);
	if (!year || !month || !day) return 0;
	const start = Date.UTC(year, month - 1, day);
	const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
	return Math.max(0, Math.floor((today - start) / 86_400_000));
}

function targetsFor(limit: number): { wordTarget: number; clozeTarget: number } {
	if (limit <= 0) return { wordTarget: 0, clozeTarget: 0 };
	let clozeTarget = 0;
	if (limit >= 15) clozeTarget = 2;
	else if (limit >= 2) clozeTarget = 1;
	return { wordTarget: limit - clozeTarget, clozeTarget };
}

/** Pure policy: ramp slowly, then cap or pause when quality/load says to. */
export function deriveAdaptiveDailyLoad(
	signals: DailyLoadSignals,
	ceiling = ADAPTIVE_MAX_NEW_ITEMS,
): DailyLoadPlan {
	const safeCeiling = Math.max(1, Math.floor(ceiling));
	const rampTarget = Math.min(
		ADAPTIVE_MAX_NEW_ITEMS,
		ADAPTIVE_START_NEW_ITEMS + Math.floor(Math.max(0, signals.dayIndex) / RAMP_STEP_DAYS),
	);
	let limit = rampTarget;
	let reason = `稳定提升第 ${Math.floor(Math.max(0, signals.dayIndex) / RAMP_STEP_DAYS) + 1} 阶段`;

	if (signals.recallEvidence < MIN_RAMP_EVIDENCE && rampTarget > ADAPTIVE_START_NEW_ITEMS) {
		limit = ADAPTIVE_START_NEW_ITEMS;
		reason = "继续积累答题证据后再提升";
	}
	if (signals.recallRate != null && signals.recallRate < 0.6) {
		limit = Math.min(limit, 11);
		reason = "近期主动回忆正确率偏低";
	} else if (signals.assistanceRate != null && signals.assistanceRate > 0.35) {
		limit = Math.min(limit, 11);
		reason = "近期提示或翻面较多";
	} else if (signals.recallRate != null && signals.recallRate < 0.72) {
		limit = Math.min(limit, 14);
		reason = "近期主动回忆仍需巩固";
	} else if (signals.assistanceRate != null && signals.assistanceRate > 0.25) {
		limit = Math.min(limit, 14);
		reason = "近期辅助依赖略高";
	}

	if (signals.dueReviews >= 60) {
		return {
			adaptive: true,
			limit: 0,
			paused: true,
			wordTarget: 0,
			clozeTarget: 0,
			rampTarget,
			dueReviews: signals.dueReviews,
			reason: "到期复习积压较多，今天只复习",
		};
	}
	if (signals.dueReviews >= 40 && limit > 11) {
		limit = 11;
		reason = "今天到期复习较多，暂缓加量";
	} else if (signals.dueReviews >= 25 && limit > 14) {
		limit = 14;
		reason = "今天先兼顾到期复习";
	}

	limit = Math.min(limit, safeCeiling);
	const targets = targetsFor(limit);
	return {
		adaptive: true,
		limit,
		paused: false,
		...targets,
		rampTarget,
		dueReviews: signals.dueReviews,
		reason,
	};
}

function adaptiveStartKey(db: DatabaseSync, now: Date, persist = true): string {
	const stored = getStat(db, START_STAT);
	if (stored && /^\d{4}-\d{2}-\d{2}$/.test(stored)) return stored;
	const today = localDateKey(now);
	if (persist) setStat(db, START_STAT, today);
	return today;
}

function countDueReviewsToday(db: DatabaseSync, now: Date): number {
	const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
	const row = db.prepare(
		`SELECT COUNT(*) AS n FROM items WHERE shown = 1 AND reviews > 0 AND due_at < ? ${SCHEDULABLE}`,
	).get(tomorrow) as { n: number };
	return Number(row.n);
}

function persistDailyLoadPlan(db: DatabaseSync, now: Date, plan: DailyLoadPlan): DailyLoadPlan {
	const serialized = JSON.stringify({
		date: localDateKey(now),
		adaptive: plan.adaptive,
		limit: plan.limit,
		paused: plan.paused,
		wordTarget: plan.wordTarget,
		clozeTarget: plan.clozeTarget,
		reason: plan.reason,
	});
	if (getStat(db, DAILY_LOAD_PLAN_STAT) !== serialized) {
		setStat(db, DAILY_LOAD_PLAN_STAT, serialized);
	}
	return plan;
}

/** Current effective quota. Configured dailyNewLimit is the adaptive ceiling. */
export function dailyLoadPlan(db: DatabaseSync, now: Date, config: PetConfig, persist = true): DailyLoadPlan {
	if (!config.adaptiveNewCards || config.dailyNewLimit === 0) {
		const targets = targetsFor(config.dailyNewLimit);
		const fixed = {
			adaptive: false,
			limit: config.dailyNewLimit,
			paused: false,
			...targets,
			rampTarget: config.dailyNewLimit,
			dueReviews: 0,
			reason: config.dailyNewLimit === 0 ? "固定为不限量" : "固定额度",
		};
		return persist ? persistDailyLoadPlan(db, now, fixed) : fixed;
	}

	const profile = computeLearnerProfile(db, now);
	const start = adaptiveStartKey(db, now, persist);
	const adaptive = deriveAdaptiveDailyLoad({
		dayIndex: localDayIndex(start, now),
		dueReviews: countDueReviewsToday(db, now),
		recallEvidence: profile.recallForward.evidence,
		recallRate: profile.recallForward.rate,
		assistanceRate: profile.assistance.rate,
	}, config.dailyNewLimit);
	return persist ? persistDailyLoadPlan(db, now, adaptive) : adaptive;
}

export function hasNewCardCapacity(plan: DailyLoadPlan, introducedToday: number): boolean {
	if (plan.paused) return false;
	return plan.limit === 0 || introducedToday < plan.limit;
}

export function remainingNewCardSlots(
	plan: DailyLoadPlan,
	introducedToday: number,
	unlimitedFallback: number,
): number {
	if (plan.paused) return 0;
	if (plan.limit === 0) return unlimitedFallback;
	return Math.max(0, plan.limit - introducedToday);
}

/** At most 10 lexical + 1 cloze per LLM call; a second call fills the daily plan. */
export function nextAdaptiveLessonBatch(
	db: DatabaseSync,
	now: Date,
	plan: DailyLoadPlan,
): LessonBatchPlan | undefined {
	if (!plan.adaptive || plan.paused) return undefined;
	const introduced = countTodayNew(db, now);
	const remaining = Math.max(0, plan.limit - introduced);
	if (remaining === 0) return undefined;

	const row = db.prepare(
		"SELECT COUNT(*) AS n FROM items WHERE type = 'cloze' AND introduction_kind IN ('planned','custom') AND introduced_at >= ?",
	).get(localDayStartIso(now)) as { n: number };
	const remainingCloze = Math.max(0, plan.clozeTarget - Number(row.n));
	const batchSize = Math.min(LESSON_WORD_ITEMS + LESSON_CLOZE_ITEMS, remaining);
	const clozeItems = remainingCloze > 0 && batchSize >= 2 ? LESSON_CLOZE_ITEMS : 0;
	const wordItems = Math.min(LESSON_WORD_ITEMS, batchSize - clozeItems);
	if (wordItems < 1) return undefined;
	return { wordItems, clozeItems };
}

export function formatDailyLoadPlan(plan: DailyLoadPlan): string {
	if (!plan.adaptive) {
		return plan.limit === 0 ? "新卡计划：不限量" : `新卡计划：固定 ${plan.limit} 张/天`;
	}
	if (plan.paused) return `自动新卡：今日暂停新增（${plan.reason}，到期 ${plan.dueReviews} 张）`;
	return `自动新卡：今日上限 ${plan.limit} 张（${plan.wordTarget} 词/词组 + ${plan.clozeTarget} 语法填空）· ${plan.reason}`;
}
