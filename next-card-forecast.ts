import type { DatabaseSync } from "node:sqlite";
import type { PetConfig } from "./config.ts";
import { dailyLoadPlan, hasNewCardCapacity } from "./adaptive-load.ts";
import { countTodayNew, customQueueCount, getStat, pendingReplacementTypes, SCHEDULABLE, setStat } from "./db.ts";
import type { RuntimeState } from "./runtime-state.ts";

export const NEXT_CARD_FORECAST_STAT = "next_card_forecast";
export type NextCardStatus = "current_card" | "ready" | "waiting_due" | "waiting_check" | "generating" | "quota_reached" | "disabled" | "empty";
export type NextCardSource = "review" | "stored_new" | "replacement" | "custom_queue";
export interface NextCardForecast {
	version: 1;
	status: NextCardStatus;
	activeItemId: number | null;
	hasReadyAfterCurrent: boolean;
	source: NextCardSource | null;
	availableAt: string | null;
	scheduledAt: string | null;
	checkAt: string | null;
	updatedAt: string;
}
export interface ForecastTiming {
	/** Actual local work timer, never inferred from next_check_at. */
	workCheckAt: string | null;
	replacementCheckAt: string | null;
	/** Local generation is useful status information, never a completion promise. */
	localGenerationBusy: boolean;
}
interface StoredCandidate { source: NextCardSource; due: number; priority: number }
const timestamp = (value: unknown): number | null => {
	if (typeof value !== "string" || !value) return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
};
const iso = (value: number | null) => value == null ? null : new Date(value).toISOString();
const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();

/** Read-only projection of existing scheduling rules; never claims cards or plans future quotas. */
export function buildNextCardForecast(db: DatabaseSync, config: PetConfig, timing: ForecastTiming, now = new Date()): NextCardForecast {
	const at = now.getTime();
	const state = db.prepare("SELECT * FROM runtime_state WHERE id=1").get() as unknown as RuntimeState;
	if (!state) return { version: 1, status: "empty", activeItemId: null, hasReadyAfterCurrent: false, source: null, availableAt: null, scheduledAt: null, checkAt: null, updatedAt: now.toISOString() };
	const activeItemId = state.active_item_id;
	const plan = dailyLoadPlan(db, now, config, false);
	const introduced = countTodayNew(db, now);
	const capacity = hasNewCardCapacity(plan, introduced);
	const pendingReplacement = pendingReplacementTypes(db).length > 0;
	const generationBusy = timing.localGenerationBusy || Boolean(state.generation_token && (timestamp(state.generation_until) ?? 0) > at);
	const pacing = timestamp(state.next_check_at) ?? 0;
	const workCheck = config.intervalMinutes > 0 ? timestamp(timing.workCheckAt) : null;
	const replacementCheck = timestamp(timing.replacementCheckAt);
	const checks = [workCheck, replacementCheck].filter((value): value is number => value != null && value >= at);
	const checkAt = checks.length ? Math.min(...checks) : null;
	const rows = db.prepare(`SELECT shown, introduction_kind, due_at FROM items WHERE id <> ? ${SCHEDULABLE}`).all(activeItemId ?? -1);
	const candidates: StoredCandidate[] = [];
	let quotaBlocked = false;
	for (const row of rows) {
		const due = timestamp(row.due_at);
		if (due == null) continue;
		if (row.shown === 1) candidates.push({ source: "review", due, priority: 0 });
		else if (row.introduction_kind === "replacement") candidates.push({ source: "replacement", due, priority: 1 });
		else if (row.introduction_kind == null || row.introduction_kind === "planned" || row.introduction_kind === "custom") {
			if (capacity) candidates.push({ source: "stored_new", due, priority: 2 });
			else quotaBlocked = true;
		}
	}
	const readyAfterCurrent = candidates.filter(candidate => candidate.due <= at).sort((a, b) => a.priority - b.priority || a.due - b.due)[0];
	const base: NextCardForecast = { version: 1, status: "empty", activeItemId, hasReadyAfterCurrent: false, source: null, availableAt: null, scheduledAt: null, checkAt: iso(checkAt), updatedAt: now.toISOString() };
	if (activeItemId != null) return { ...base, status: "current_card", hasReadyAfterCurrent: Boolean(readyAfterCurrent), source: readyAfterCurrent?.source ?? null };

	// Queued payloads are not stored cards until their insertion transaction succeeds.
	const queueSize = customQueueCount(db);
	const customPending = capacity && queueSize > 0;
	if (!capacity && queueSize > 0) quotaBlocked = true;

	const available = (candidate: StoredCandidate) => Math.max(candidate.due, pacing);
	const eligibleAtCheck = workCheck != null && workCheck >= at
		? candidates.filter(candidate => available(candidate) <= workCheck && (candidate.source !== "stored_new" || sameDay(at, workCheck)))
			.sort((a, b) => a.priority - b.priority || a.due - b.due)
		: [];
	// An in-flight LLM may finish before this timer and restore replacement-first
	// ordering, so even that shortcut cannot promise new inventory past a backlog.
	const scheduled = eligibleAtCheck.find(candidate => candidate.source === "review" || !pendingReplacement);
	const first = scheduled ?? candidates.sort((a, b) => available(a) - available(b) || a.priority - b.priority)[0];
	if (first) {
		base.source = first.source;
		base.availableAt = iso(available(first));
		base.status = available(first) <= at ? "ready" : first.due > at ? "waiting_due" : "waiting_check";
		if (scheduled) base.scheduledAt = iso(workCheck);
	} else if (customPending) {
		base.source = "custom_queue";
		base.status = "waiting_check";
		// Queue payloads still need an insertion transaction; they can only
		// support a check time, never a guaranteed card-release countdown.
	} else if (quotaBlocked) base.status = "quota_reached";
	else if (workCheck != null) base.status = "waiting_check";

	// Explicit/manual and background replacement generation can finish even when
	// automatic study checks are disabled. Neither has a promised completion time.
	if (!base.scheduledAt && (generationBusy || pendingReplacement) && base.source !== "review") base.status = "generating";
	else if (config.intervalMinutes <= 0 && !generationBusy && !pendingReplacement) base.status = "disabled";
	return base;
}

/** Only semantic changes publish a new timestamp; reads/countdowns never churn SQLite. */
export function writeNextCardForecast(db: DatabaseSync, forecast: NextCardForecast): boolean {
	const raw = getStat(db, NEXT_CARD_FORECAST_STAT);
	if (raw) {
		try {
			const previous = JSON.parse(raw);
			const { updatedAt: _oldTime, ...oldFields } = previous;
			const { updatedAt: _newTime, ...newFields } = forecast;
			if (JSON.stringify(oldFields) === JSON.stringify(newFields)) return false;
		} catch { /* replace a malformed old projection */ }
	}
	setStat(db, NEXT_CARD_FORECAST_STAT, JSON.stringify(forecast));
	return true;
}
