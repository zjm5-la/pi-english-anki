import type { DatabaseSync } from "node:sqlite";
import { ADAPTIVE_MAX_NEW_ITEMS, LESSON_WORD_ITEMS, LESSON_CLOZE_ITEMS, type PetConfig } from "./config.ts";
import { dailyLoadPlan, remainingNewCardSlots } from "./adaptive-load.ts";
import { countTodayNew, customQueueCount, getStat, SCHEDULABLE, setStat } from "./db.ts";

export const AUTO_REFILL_STAT = "auto_refill_status";
export type AutoRefillStrategy = "daily" | "reserve";
export function autoRefillStrategy(mode: string | undefined, client = process.env.IELTS_ANKI_CLIENT): AutoRefillStrategy {
	return mode === "rpc" && client === "desktop" ? "daily" : "reserve";
}
export interface AutoRefillStatus {
	version: 1;
	strategy: AutoRefillStrategy;
	phase: "checking" | "generating" | "ready" | "retry_wait" | "quota_reached" | "paused";
	inventory: number;
	queued: number;
	target: number;
	retryAt: string | null;
	reason: string;
	updatedAt: string;
}

/** Daily preparation for the desktop app; ordinary RPC retains its small reserve. */
export function autoRefillPlan(db: DatabaseSync, config: PetConfig, now = new Date(), strategy: AutoRefillStrategy = "reserve") {
	const plan = dailyLoadPlan(db, now, config, false);
	const daily = strategy === "daily";
	const plannedOnly = daily ? "AND (introduction_kind IS NULL OR introduction_kind IN ('planned','custom'))" : "";
	const inventory = Number(db.prepare(`SELECT COUNT(*) AS n FROM items WHERE shown = 0 ${plannedOnly} ${SCHEDULABLE}`).get()?.n ?? 0);
	const queued = customQueueCount(db);
	const introduced = countTodayNew(db, now);
	const unlimitedDaily = daily && !plan.paused && plan.limit === 0;
	const target = daily
		? unlimitedDaily ? Math.max(0, ADAPTIVE_MAX_NEW_ITEMS - introduced) : remainingNewCardSlots(plan, introduced, 0)
		: Math.min(5, remainingNewCardSlots(plan, introduced, 5));
	const paused = config.intervalMinutes <= 0 || plan.paused;
	const phase: AutoRefillStatus["phase"] = paused ? "paused" : target === 0 ? "quota_reached" : (daily || inventory + queued <= 1) && inventory + queued < target ? "checking" : "ready";
	const unlimitedNote = unlimitedDaily ? `（学习不限量，每日自动备课最多 ${ADAPTIVE_MAX_NEW_ITEMS} 张）` : "";
	const status: AutoRefillStatus = {
		version: 1, strategy, phase, inventory, queued, target, retryAt: null,
		reason: (config.intervalMinutes <= 0 ? "自动检查已关闭" : plan.paused ? plan.reason : target === 0 ? unlimitedDaily ? "今日自动备课目标已完成" : "今日新卡额度已用完" : phase === "checking" ? daily ? "正在准备今天剩余的新卡" : "准备自动补充新卡" : daily ? "今天剩余新卡已备齐，复习优先" : queued > 0 ? "已有待放出的卡片，复习优先" : "已备好新卡，复习优先") + unlimitedNote,
		updatedAt: now.toISOString(),
	};
	const slots = paused ? 0 : Math.max(0, target - inventory - queued);
	const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
	let reservedCloze = Number(db.prepare(`SELECT COUNT(*) AS n FROM items WHERE type='cloze' AND (shown=0 OR introduced_at>=?) ${plannedOnly} ${SCHEDULABLE}`).get(dayStart)?.n ?? 0);
	if (daily) {
		for (const row of db.prepare("SELECT payload FROM custom_card_queue").all()) {
			try { if (JSON.parse(String(row.payload)).type === "cloze") reservedCloze++; } catch { /* invalid staged payload is not grammar evidence */ }
		}
	}
	const remainingCloze = plan.adaptive ? Math.max(0, plan.clozeTarget - reservedCloze) : 0;
	const clozeItems = slots >= 2 && remainingCloze > 0 ? LESSON_CLOZE_ITEMS : 0;
	// Each model batch requires at least one word. Leave room for the next
	// grammar slot rather than producing 10+1 now and stranding a lone cloze.
	const laterCloze = daily && clozeItems ? Math.min(remainingCloze - clozeItems, Math.max(0, Math.floor((slots - 2) / 2))) : 0;
	const wordItems = Math.min(LESSON_WORD_ITEMS, Math.max(0, slots - clozeItems - laterCloze * 2));
	return { status, slots, batch: { wordItems, clozeItems }, shouldRefill: phase === "checking" };
}

/** Keep live state fresh without a SQLite write on every one-second poll. */
export function writeAutoRefillStatus(db: DatabaseSync, status: AutoRefillStatus) {
	try {
		const previous = JSON.parse(getStat(db, AUTO_REFILL_STAT) || "null");
		if (previous) {
			const { updatedAt: oldTime, ...oldFields } = previous;
			const { updatedAt: newTime, ...newFields } = status;
			if (JSON.stringify(oldFields) === JSON.stringify(newFields) && Date.parse(newTime) - Date.parse(oldTime) < 15_000) return;
		}
	} catch { /* overwrite malformed status */ }
	setStat(db, AUTO_REFILL_STAT, JSON.stringify(status));
}
