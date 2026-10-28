import { CHAT_SYSTEM_PROMPT, chatEditReview, createChatDispatcher, parseChatRequest, runChat } from "./chat.ts";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Rating } from "fsrs.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { PiSdkLlmClient, type PiSdkRuntimeFactory } from "./pi-sdk-llm.ts";
import { dailyLoadPlan, formatDailyLoadPlan, hasNewCardCapacity, nextAdaptiveLessonBatch, remainingNewCardSlots } from "./adaptive-load.ts";
import { AUTO_DETECT_MODELS, DEFAULTS, LESSON_CLOZE_ITEMS, LESSON_WORD_ITEMS, loadConfig, MAX_CUSTOM_PER_ADD, type PetConfig, type ThinkingLevel } from "./config.ts";
import { advanceReview, advanceReviewDirectional, appendGenLog, bumpStat, computeMasteryStage, consumeReplacement, contentFingerprint, countTodayNew, customQueueCount, dueDirection, directionFsrsState, earliestUpcomingReviewDue, enqueueCustomCard, enqueueReplacement, getDueItem, getGenLog, getStat, insertItem, knownList, listCustomQueue, markShown, openDb, pendingReplacementTypes, recognitionDueFloorAfterProduction, removeCustomQueueRows, replacementKnownList, SCHEDULABLE, setStat, touchClient, touchStreak, type CustomQueueRow, type ItemRow } from "./db.ts";
import { EMPTY_SENTENCE_CYCLE, activeItem, getRuntimeState, latestMasteredItem, myCoordinatorId, pacingReady, resetPacing, setRuntimeState, type AssistanceLevel, type PendingAttempt, type RecallDirection, type RuntimeState } from "./runtime-state.ts";
import { effectiveRecallRating, quarantineCorruptFsrs, scheduleNext } from "./fsrs.ts";
import { formatVocabReport, screeningEase, studyOrder, vocabularyReport } from "./lexical-band.ts";
import { backfillCardImages } from "./card-image.ts";
import { buildConversation } from "./conversation.ts";
import { MAX_LESSON_REVISIONS, MAX_DUPLICATE_RETRIES, critiqueLesson, evaluateAttempt, evaluateSentenceAttempt, generateLesson, generateReplacement, parseGeneratedItem, type AnswerEvaluation, type CritiqueIssue, type GeneratedItem, type LessonBatch, type LessonDecision, type ReplacementDecision, type SentenceEvaluation } from "./llm.ts";
import { FACES, TYPE_LABELS, formatStatusLine, forwardCue, parseJsonCol, recallQuestionText, renderCard, sentenceExercise, sentenceQuestionText, spellingComparisonLines, type ForwardCue, type SentenceExerciseView } from "./render.ts";
import { ensureSentenceCycle, ensureSentenceExercise, insertEvaluatedAttempt } from "./sentence-cycle.ts";
import { dbFilePath, isSyncEnabled, peekRemoteNewer, pullIfNewer, pushSnapshot } from "./sync.ts";
import { computeLearnerProfile, deriveBudget, formatAttemptLogBlock, formatProfileStatsLine, recentAttemptLog, smoothBudget, type AdaptiveContext } from "./learner-profile.ts";

import { interruptOrphanedTeachRequests, parseTeachRequest, readTeachReceipt, writeTeachReceipt, type TeachPhase, type TeachRequest } from "./teach-request.ts";

import { autoRefillPlan, autoRefillStrategy, writeAutoRefillStatus, type AutoRefillStrategy } from "./auto-refill.ts";
import { buildNextCardForecast, writeNextCardForecast, type NextCardForecast } from "./next-card-forecast.ts";
import { beginStudyUndo, finishStudyUndo, beginUndoContinuation, finishUndoContinuation, withUndoContinuation, continueStudyUndoAction, initializeStudyUndo, invalidateStudyUndo, refreshStudyUndo, readStudyUndo, bindUndoReplacement, undoStudyAction } from "./study-undo.ts";

export { contentFingerprint };

// -- Synonym retry ----------------------------------------------------------
/** Synonyms already offered for the card on screen, with the latest hint.
 * Shared through the DB so every session sees the same retry; it only counts
 * while `active_retry_count` > 0, which every card claim resets. */
const SYNONYM_TRIES_STAT = "synonym_tries";

function readSynonymTries(db: DatabaseSync, itemId: number, direction: RecallDirection): { answers: string[]; hint: string } | undefined {
	const row = db.prepare("SELECT value FROM stats WHERE key = ?").get(SYNONYM_TRIES_STAT) as { value: string } | undefined;
	try {
		const parsed = JSON.parse(row?.value ?? "") as { itemId?: unknown; direction?: unknown; answers?: unknown; hint?: unknown };
		if (parsed.itemId !== itemId || parsed.direction !== direction || !Array.isArray(parsed.answers)) return undefined;
		return { answers: parsed.answers.filter((answer): answer is string => typeof answer === "string"), hint: typeof parsed.hint === "string" ? parsed.hint : "" };
	} catch {
		return undefined;
	}
}

// -- Screening sweep --------------------------------------------------------
// The config FILE is the source of truth for screening mode: sessions hold
// stale in-memory copies, so behaviour gates re-read the flag through this
// tiny 5s cache instead of trusting `config`. Paths that move a card read it
// `fresh`: a stale cache would undo or claim cards against another session.
let screeningCache: { value: boolean; at: number } | undefined;
const SCREENING_CARD_STAT = "screening_card";
/** Cards the learner missed in a sweep: never offered by screening again,
 * left for normal study to introduce on its own schedule. Items by id,
 * queued cards by their (stable) custom_card_queue row id. */
const SCREENING_MISSED_STAT = "screening_missed";
interface ScreeningCard { itemId: number; wasShown: boolean; queueRow?: CustomQueueRow }
function screeningActive(fresh = false): boolean {
	const now = Date.now();
	if (fresh || !screeningCache || now - screeningCache.at > 5_000) {
		let value = false;
		try {
			const raw = readFileSync(join(getAgentDir(), "kaomoji-english-tutor.json"), "utf-8");
			const parsed = JSON.parse(raw);
			if (typeof parsed.screeningMode === "boolean") value = parsed.screeningMode;
		} catch { /* default off */ }
		screeningCache = { value, at: now };
	}
	return screeningCache.value;
}

// -- Timing & pacing knobs (closure orchestration) ---------------------------

/**
 * Single global learning slot shared across every concurrent Pi session.
 * One row (id=1) in SQLite is the single source of truth; each process keeps
 * only a local cache of the active card for rendering. State transitions that
 * must happen at most once globally (rating, skip, claiming a due card) run in
 * short `BEGIN IMMEDIATE` transactions with optimistic CAS checks.
 */

/** Expiry and renewal cadence of the coordinator lease. */
const COORDINATOR_LEASE_MS = 15_000;
const COORDINATOR_HEARTBEAT_MS = 5_000;
const GENERATION_LEASE_MS = 5 * 60_000;
/** How often each process polls SQLite for cross-session changes. */
const SYNC_POLL_MS = 1000;
/** Grace window a session has to own an in-flight replacement generation. */
const REPLACEMENT_GRACE_MS = 8000;
const ANSWER_THINKING_INTERVAL_MS = 120;
const ANSWER_THINKING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// -- Extension ------------------------------------------------------------

export interface KaomojiEnglishTutorExtensionOptions {
	/** Dependency injection seam for isolated SDK transport tests. */
	runtimeFactory?: PiSdkRuntimeFactory;
}

export default function piEnglishAnkiExtension(
	pi: ExtensionAPI,
	options: KaomojiEnglishTutorExtensionOptions = {},
) {
	const llm = new PiSdkLlmClient(options.runtimeFactory);

	// -- State ------------------------------------------------------------
	let config: PetConfig = { ...DEFAULTS };
	const loadPlan = (database: DatabaseSync, now = new Date()) => dailyLoadPlan(database, now, config);
	const statsLine = (database: DatabaseSync) => formatStatusLine(database, loadPlan(database), screeningActive());
	const queueEta = (database: DatabaseSync, total: number) => {
		const plan = loadPlan(database);
		if (!plan.adaptive && plan.limit === 0) return "不限速，将尽快放出";
		const pace = Math.max(1, plan.limit || Math.min(plan.rampTarget, config.dailyNewLimit));
		return `按当前${plan.adaptive ? "自动" : "固定"}节奏预计 ${Math.ceil(total / pace)} 天放完`;
	};
	let db: DatabaseSync | null = null;
	let resolvedModelName = "";
	let lastError = "";
	let pendingChat = false;
	const dispatchChat = createChatDispatcher();
	let pendingLLMCall = false;
	let pendingLLMCallAt = 0;
	let lastRejectedConversation = "";
	let manualTeachRequest: TeachRequest | undefined;
	/** Manual /anki:teach topics waiting for the in-flight generation (in-process FIFO). */
	const teachQueue: TeachRequest[] = [];
	const pendingTeachRequests = new Map<string, TeachRequest>();
	let manualWork: { request: TeachRequest; token: string; startedAt: number } | undefined;
	const MANUAL_TEACH_DEADLINE_MS = 25 * 60_000;
	let lastRejectedReplacementKey = "";
	let replacementRetryAt = 0;
	let replacementTimer: ReturnType<typeof setTimeout> | undefined;
	const REPLACEMENT_RETRY_MS = 30_000;
	let replacementRunning = false;
	let autoRefillTimer: ReturnType<typeof setTimeout> | undefined;
	let autoRefillRunning = false;
	let autoRefillRetryAt = 0;
	let sessionGeneration = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let workCheckAt: string | null = null;
	let replacementCheckAt: string | null = null;
	let pollTimer: ReturnType<typeof setTimeout> | undefined;
	let answerThinkingTimer: ReturnType<typeof setInterval> | undefined;
	/** Raw lines of the latest real widget render; the judging animation overlays these. */
	let lastWidgetLines: string[] = [];
	/** While true, the judging animation owns the widget and other renders are dropped. */
	let answerJudging = false;
	let latestCtx: ExtensionContext | undefined;
	/** Per-runtime identity; distinct even when two processes open the same logical session. */
	const instanceToken = randomUUID();
	/** Current session id, for the coordinator lease identity. */
	let sessionId = "";
	/** My `sessionId::instanceToken` coordinator identity. */
	let myId = "";
	let lastCoordinatorRenewal = 0;
	let lastClientHeartbeat = 0;
	/** Last active_version we rendered locally (to detect cross-session card changes). */
	let localVersion = -1;
	/** Cached `PRAGMA data_version` to avoid redundant SQLite reads. */
	let lastDataVersion: number | null = null;
	/** Most recently shown card awaiting a rating/skip decision (mirrors the global slot). */
	let pendingItemId: number | null = null;
	/** Whether the pending card is currently showing its answer side (local-only). */
	let pendingFlipped = false;
	/** Whether the pending card is a review (vs first showing / training). */
	let pendingIsReview = false;
	let pendingDirection: RecallDirection = "forward";
	let pendingAssistance: AssistanceLevel = "none";
	/** Screening sweep round (process-local, reset on every toggle): items and queue rows already offered. */
	const screeningSwept = new Set<number>();
	const screeningSweptQueue = new Set<number>();

	function isCtxStale(ctx: ExtensionContext): boolean {
		try {
			void ctx.hasUI;
			return false;
		} catch {
			return true;
		}
	}

	/** The owner alone publishes real timer promises; expired owners publish no countdown. */
	function publishForecast(allowTimers = true) {
		if (!db || !myId || db.isTransaction) return;
		try {
			db.exec("BEGIN IMMEDIATE");
			const now = new Date();
			const state = getRuntimeState(db);
			const liveOwner = Boolean(state.coordinator && state.coordinator_until && Date.parse(state.coordinator_until) > now.getTime());
			if (liveOwner && state.coordinator !== myId) { db.exec("ROLLBACK"); return; }
			const ownTimers = allowTimers && liveOwner && state.coordinator === myId;
			// After an owner expires, followers may only remove stale promises.
			// Their differing local settings must not compete to describe the deck.
			writeNextCardForecast(db, !liveOwner ? {
				version: 1, status: state.active_item_id == null ? "waiting_check" : "current_card",
				activeItemId: state.active_item_id, hasReadyAfterCurrent: false, source: null,
				availableAt: null, scheduledAt: null, checkAt: null, updatedAt: now.toISOString(),
			} : withScreeningForecast(buildNextCardForecast(db, config, {
				workCheckAt: ownTimers ? workCheckAt : null,
				replacementCheckAt: ownTimers ? replacementCheckAt : null,
				localGenerationBusy: ownTimers && pendingLLMCall,
			}, now)));
			db.exec("COMMIT");
		} catch (err) {
			try { db.exec("ROLLBACK"); } catch { /* no transaction */ }
			console.error(`[pi-english-anki] Forecast update failed: ${err}`);
		}
	}

	/** A sweep serves its next card the moment the current one is rated. */
	function withScreeningForecast(forecast: NextCardForecast): NextCardForecast {
		return screeningActive() && forecast.status === "current_card" ? { ...forecast, hasReadyAfterCurrent: true } : forecast;
	}

	function teachProgress(request: TeachRequest | undefined, phase: TeachPhase, errorCode?: string, itemIds?: number[]) {
		if (!db || !request?.requestId) return;
		writeTeachReceipt(db, { requestId: request.requestId, topic: request.topic, phase,
			itemsAdded: itemIds?.length ?? 0, ...(itemIds ? { itemIds } : {}), ...(errorCode ? { errorCode } : {}),
			updatedAt: new Date().toISOString(), ownerId: myId });
		if (phase === "succeeded" || phase === "failed") pendingTeachRequests.delete(request.requestId);
	}

	function ownsTeachRequest(request: TeachRequest): boolean {
		if (!request.requestId) return true;
		if (!db) return false;
		const receipt = readTeachReceipt(db, request.requestId);
		return receipt?.ownerId === myId && receipt.phase !== "succeeded" && receipt.phase !== "failed";
	}

	function interruptManualRequests() {
		for (const request of pendingTeachRequests.values()) teachProgress(request, "failed", "REQUEST_INTERRUPTED");
		pendingTeachRequests.clear();
		teachQueue.length = 0;
		manualTeachRequest = undefined;
		manualWork = undefined;
	}

	function resetState() {
		lastError = "";
		pendingLLMCall = false;
		pendingLLMCallAt = 0;
		lastRejectedConversation = "";
		lastRejectedReplacementKey = "";
		replacementRetryAt = 0;
		replacementRunning = false;
		autoRefillRunning = false;
		autoRefillRetryAt = 0;
		resolvedModelName = "";
	}

	function clearPendingLocals() {
		pendingItemId = null;
		pendingFlipped = false;
		pendingIsReview = false;
		pendingDirection = "forward";
		pendingAssistance = "none";
	}

	/** Clear a locally stuck call after the global generation lease has had time to expire. */
	function resetHungLlmCall(): boolean {
		// A manual pipeline includes generation, review, and revisions. Its own
		// deadline/lease renewal applies; the automatic 180s reset must not race it.
		if (manualWork) return false;
		if (!pendingLLMCall || Date.now() - pendingLLMCallAt < 180_000) return false;
		pendingLLMCall = false;
		pendingLLMCallAt = 0;
		if (db) setStat(db, "last_gen_status", "hung_llm_reset");
		return true;
	}

	/** Start the next queued manual teach once no generation is in flight. */
	function drainTeachQueue() {
		if (teachQueue.length === 0 || pendingLLMCall || !db) return;
		const ctx = latestCtx;
		if (!ctx || isCtxStale(ctx)) return;
		const state = getRuntimeState(db);
		if (state.generation_token && state.generation_until && Date.now() < Date.parse(state.generation_until)) return;
		const request = teachQueue.shift();
		if (!request) return;
		if (!ownsTeachRequest(request)) {
			if (request.requestId) pendingTeachRequests.delete(request.requestId);
			drainTeachQueue();
			return;
		}
		manualTeachRequest = request;
		if (!request.requestId) ctx.ui.notify(`开始执行排队的备课：「${request.topic}」`, "info");
		void generateAndInsert(ctx, new Date())
			.catch((err) => { teachProgress(request, "failed", "TEACH_GENERATION_FAILED"); console.error(`[pi-english-anki] queued teach failed: ${err}`); })
			.finally(() => scheduleTimer());
	}

	function stopTimer() {
		if (timer) clearTimeout(timer);
		timer = undefined;
		workCheckAt = null;
	}

	function stopAnswerThinking() {
		answerJudging = false;
		if (answerThinkingTimer) clearInterval(answerThinkingTimer);
		answerThinkingTimer = undefined;
	}

	function startAnswerThinking(ctx: ExtensionContext, expectedGeneration: number) {
		stopAnswerThinking();
		// Overlay the spinner on the card being judged so the widget keeps a
		// stable height; replacing the card with a bare 2-line spinner collapses
		// and re-expands the layout on every interleaved render (flicker).
		const base = lastWidgetLines;
		let frame = 0;
		const render = () => {
			if (sessionGeneration !== expectedGeneration || isCtxStale(ctx)) {
				stopAnswerThinking();
				return;
			}
			updateWidget(ctx, FACES.review, [
				...base,
				`${ANSWER_THINKING_FRAMES[frame % ANSWER_THINKING_FRAMES.length]} 正在判断你的答案…`,
			], true);
			frame++;
		};
		answerJudging = true;
		render();
		answerThinkingTimer = setInterval(render, ANSWER_THINKING_INTERVAL_MS);
		answerThinkingTimer.unref?.();
	}

	function intervalMs(): number {
		return Math.max(0, config.intervalMinutes) * 60_000;
	}

	async function syncAfterTick() {
		if (!db) return;
		try {
			const r = await pushSnapshot(db);
			if (r.status === "pushed") appendGenLog(db, `sync_pushed: ${r.localTs ?? ""}`);
			else if (r.status === "remote_newer") appendGenLog(db, "sync_remote_newer: 云端有更新的进度，/anki:pull 拉取");
			else if (r.status === "error") appendGenLog(db, `sync_error: ${r.message ?? ""}`);
		} catch { /* sync must never break the tick */ }
	}

	function stopReplacementTimer() {
		if (replacementTimer) clearTimeout(replacementTimer);
		replacementTimer = undefined;
		replacementCheckAt = null;
	}

	/** Refill stored inventory independently of the currently displayed card. */
	function scheduleReplacementWork() {
		if (!config.autoTeach || replacementTimer || replacementRunning || !db || !latestCtx || pendingReplacementTypes(db).length === 0) return;
		const generation = sessionGeneration;
		const delay = Math.max(0, replacementRetryAt - Date.now());
		replacementCheckAt = new Date(Date.now() + delay).toISOString();
		replacementTimer = setTimeout(() => {
			replacementTimer = undefined;
			replacementCheckAt = null;
			publishForecast();
			const ctx = latestCtx;
			if (generation !== sessionGeneration || !db || !ctx || isCtxStale(ctx)) return;
			// Claims are pure DB work: any wake claims before generation backoff,
			// so a due card never waits for the work timer just because this loop
			// owns replacement generation.
			if (activeItem(db) == null) {
				const due = claimDueItem(new Date());
				if (due) {
					if (!showItem(ctx, due)) renderGlobalCard(ctx);
					return;
				}
			}
			if (Date.now() < replacementRetryAt) { scheduleReplacementWork(); return; }
			if ((pendingLLMCall && !resetHungLlmCall()) || answerJudging) {
				replacementRetryAt = Date.now() + REPLACEMENT_RETRY_MS;
				scheduleReplacementWork();
				return;
			}
			const type = pendingReplacementTypes(db)[0];
			if (!type) return;
			replacementRunning = true;
			void generateReplacementAndInsert(ctx, type).then((inserted) => {
				if (generation === sessionGeneration) replacementRetryAt = inserted ? 0 : Date.now() + REPLACEMENT_RETRY_MS;
			}, (err) => {
				if (generation === sessionGeneration) replacementRetryAt = Date.now() + REPLACEMENT_RETRY_MS;
				console.error(`[pi-english-anki] Background replacement failed: ${err}`);
			}).finally(() => {
				if (generation !== sessionGeneration) return;
				replacementRunning = false;
				scheduleReplacementWork();
			});
		}, delay);
		(replacementTimer as unknown as { kaomojiReplacement?: boolean }).kaomojiReplacement = true;
		replacementTimer.unref?.();
		publishForecast();
	}

	function stopAutoRefillTimer() {
		if (autoRefillTimer) clearTimeout(autoRefillTimer);
		autoRefillTimer = undefined;
	}

	/** Desktop study prepares today’s remaining cards; ordinary RPC keeps a small reserve. */
	function scheduleAutoRefillWork() {
		if (!db || latestCtx?.mode !== "rpc" || !ensureCoordinator(new Date())) return;
		const strategy = autoRefillStrategy(latestCtx.mode);
		const plan = autoRefillPlan(db, config, new Date(), strategy);
		const state = getRuntimeState(db);
		if (autoRefillRunning) {
			writeAutoRefillStatus(db, { ...plan.status, phase: "generating", reason: "后台准备新卡，可继续复习" });
			return;
		}
		if (!plan.shouldRefill) { stopAutoRefillTimer(); writeAutoRefillStatus(db, plan.status); return; }
		if (autoRefillRetryAt > Date.now()) {
			writeAutoRefillStatus(db, { ...plan.status, phase: "retry_wait", retryAt: new Date(autoRefillRetryAt).toISOString(), reason: "补卡暂未成功，稍后自动重试" });
			return;
		}
		const busy = pendingLLMCall || answerJudging || teachQueue.length > 0 || pendingReplacementTypes(db).length > 0 ||
			Boolean(state.generation_token && Date.parse(state.generation_until ?? "") > Date.now());
		writeAutoRefillStatus(db, { ...plan.status, reason: busy ? "等待当前任务结束后自动补卡" : plan.status.reason });
		if (busy || autoRefillTimer) return;
		const generation = sessionGeneration;
		autoRefillTimer = setTimeout(() => {
			autoRefillTimer = undefined;
			const ctx = latestCtx;
			if (generation !== sessionGeneration || !db || !ctx || isCtxStale(ctx)) return;
			const fresh = autoRefillPlan(db, config, new Date(), strategy);
			const runtime = getRuntimeState(db);
			if (!fresh.shouldRefill || pendingLLMCall || answerJudging || teachQueue.length > 0 || pendingReplacementTypes(db).length > 0 ||
				Boolean(runtime.generation_token && Date.parse(runtime.generation_until ?? "") > Date.now())) return;
			autoRefillRunning = true;
			writeAutoRefillStatus(db, { ...fresh.status, phase: "generating", reason: "后台准备新卡，可继续复习" });
			void generateAndInsert(ctx, new Date(), fresh.batch, true, strategy).then((added) => {
				if (generation === sessionGeneration) autoRefillRetryAt = added ? 0 : Date.now() + 30_000;
			}, (err) => {
				if (generation === sessionGeneration) autoRefillRetryAt = Date.now() + 30_000;
				console.error(`[pi-english-anki] Background inventory failed: ${err}`);
			}).finally(() => {
				if (generation !== sessionGeneration) return;
				autoRefillRunning = false;
				scheduleAutoRefillWork();
			});
		}, 0);
		(autoRefillTimer as unknown as { kaomojiAutoRefill?: boolean }).kaomojiAutoRefill = true;
		autoRefillTimer.unref?.();
	}

	function scheduleTimer(delay = intervalMs()) {
		stopTimer();
		if (!latestCtx || config.intervalMinutes <= 0 || db == null || activeItem(db) != null) { publishForecast(); return; }
		const state = getRuntimeState(db);
		const pacingDelay = state.next_check_at
			? new Date(state.next_check_at).getTime() - Date.now()
			: 0;
		// A free (unpaced) delay never sleeps past an upcoming review due time:
		// waking early is harmless, waking late hides a due card for a full
		// interval. Paced delays were already capped at write time.
		const effectiveDelay = pacingDelay > 0 ? pacingDelay : Math.min(delay, earliestDueDelay());
		workCheckAt = new Date(Date.now() + Math.max(0, effectiveDelay)).toISOString();
		timer = setTimeout(() => {
			timer = undefined;
			workCheckAt = null;
			publishForecast();
			void runTimerTick().then(syncAfterTick, syncAfterTick);
		}, Math.max(0, effectiveDelay));
		timer.unref?.();
		publishForecast();
	}

	async function runTimerTick() {
		const ctx = latestCtx;
		const generation = sessionGeneration;
		if (!ctx || isCtxStale(ctx) || config.intervalMinutes <= 0) return;
		if (pendingLLMCall && !resetHungLlmCall()) {
			// Background inventory work must not delay already-stored study cards.
			const due = claimDueItem(new Date());
			if (due) showItem(ctx, due);
			else scheduleTimer(Math.min(30_000, intervalMs()));
			return;
		}
		try {
			await petTick(ctx);
		} catch (err) {
			console.error(`[pi-english-anki] Timer tick failed: ${err}`);
		}
		if (sessionGeneration !== generation) return;
		// Keep re-evaluating unless leaving a locally-rated card up for this session.
		if (pendingItemId == null) scheduleTimer();
	}


	/** Close the session-scoped SQLite connection before reload/switch/exit. */
	function closeDb() {
		stopPolling();
		stopAutoRefillTimer();
		const current = db;
		db = null;
		if (!current) return;
		try {
			current.close();
		} catch (err) {
			console.error(`[pi-english-anki] Failed to close DB: ${err}`);
		}
	}

	/** Attach this session to the freshly opened DB: identity, card render, polling. */
	function attachDb(ctx: ExtensionContext) {
		resolveModel(ctx);
		if (!db) return;
		initializeStudyUndo(db);
		ensureCoordinator(new Date(), true);
		setStat(db, "pet_alive", new Date().toISOString());
		setStat(db, "pet_config_model", `${config.provider}/${config.model}`);
		touchClient(db, myId);
		// Rebuild the active global card so this session converges immediately.
		if (activeItem(db)) {
			renderGlobalCard(ctx);
		} else if (localVersion < 0) {
			updateWidget(ctx, FACES.idle, [statsLine(db)]);
		}
		startPolling();
		scheduleReplacementWork();
		scheduleAutoRefillWork();
	}

	// -- Coordinator lease & cross-session sync ----------------------------

	/** Stop the cross-session poll timer. */
	function stopPolling() {
		if (pollTimer) clearTimeout(pollTimer);
		pollTimer = undefined;
	}

	function leaseMs(): number {
		return COORDINATOR_LEASE_MS;
	}

	/** I hold the current, unexpired coordinator lease. */
	function iAmCoordinator(state: RuntimeState, now: Date): boolean {
		return Boolean(
			myId &&
			state.coordinator === myId &&
			state.coordinator_until &&
			now.getTime() < new Date(state.coordinator_until).getTime()
		);
	}

	/** Acquire/renew leadership, or force takeover after real user activity. */
	function ensureCoordinator(now = new Date(), force = false): boolean {
		if (!db || !myId) return false;
		try {
			db.exec("BEGIN IMMEDIATE");
			const state = getRuntimeState(db);
			const expired = !state.coordinator || !state.coordinator_until ||
				now.getTime() >= new Date(state.coordinator_until).getTime();
			if (!force && state.coordinator !== myId && !expired) {
				db.exec("ROLLBACK");
				return false;
			}
			const changedOwner = state.coordinator !== myId;
			setRuntimeState(db, {
				coordinator: myId,
				coordinator_until: new Date(now.getTime() + leaseMs()).toISOString(),
				last_activity: now.toISOString(),
				...(changedOwner ? { generation_token: null, generation_until: null } : {}),
			});
			db.exec("COMMIT");
			lastCoordinatorRenewal = now.getTime();
			return true;
		} catch (err) {
			try { db.exec("ROLLBACK"); } catch { /* no transaction */ }
			console.error(`[pi-english-anki] Coordinator lease failed: ${err}`);
			return false;
		}
	}

	/** Release only this runtime's ownership; never disturb a newer session. */
	function releaseCoordinator() {
		if (!db || !myId) return;
		publishForecast(false);
		db.prepare(
			"UPDATE runtime_state SET coordinator = NULL, coordinator_until = NULL, generation_token = NULL, generation_until = NULL WHERE id = 1 AND coordinator = ?",
		).run(myId);
	}

	/** Claim one generation token without holding a transaction across the LLM call. */
	function claimGeneration(now = new Date(), manual = false): string | null {
		if (!db || !myId || (!manual && !ensureCoordinator(now))) return null;
		const token = randomUUID();
		try {
			db!.exec("BEGIN IMMEDIATE");
			const state = getRuntimeState(db!);
			const generationBusy = Boolean(
				state.generation_token && state.generation_until &&
				now.getTime() < new Date(state.generation_until).getTime()
			);
			if ((!manual && !iAmCoordinator(state, now)) || generationBusy) {
				db!.exec("ROLLBACK");
				return null;
			}
			setRuntimeState(db!, {
				...(manual ? { coordinator: myId, coordinator_until: new Date(now.getTime() + leaseMs()).toISOString(), last_activity: now.toISOString() } : {}),
				generation_token: token,
				generation_until: new Date(now.getTime() + GENERATION_LEASE_MS).toISOString(),
			});
			db!.exec("COMMIT");
			if (manual) lastCoordinatorRenewal = now.getTime();
			return token;
		} catch (err) {
			try { db!.exec("ROLLBACK"); } catch { /* no transaction */ }
			console.error(`[pi-english-anki] Generation lease failed: ${err}`);
			return null;
		}
	}

	function ownsGeneration(state: RuntimeState, token: string, now = new Date()): boolean {
		return Boolean(
			iAmCoordinator(state, now) &&
			state.generation_token === token &&
			state.generation_until &&
			now.getTime() < new Date(state.generation_until).getTime()
		);
	}

	function releaseGeneration(token: string) {
		if (!db) return;
		db.prepare(
			"UPDATE runtime_state SET generation_token = NULL, generation_until = NULL WHERE id = 1 AND coordinator = ? AND generation_token = ?",
		).run(myId, token);
	}

	/** Rebuild persisted sentence-correction teaching after polls, reattachment, or reload. */
	function sentenceCorrectionLines(item: ItemRow, state: RuntimeState): string[] | undefined {
		if (
			!db || item.type !== "sentence" || state.active_cycle_outcome !== "again" ||
			state.active_retry_count <= 0 || !state.active_review_cycle_id || state.active_exercise_id == null
		) return undefined;
		const attempt = db.prepare(
			"SELECT verdict,answer_text,error_tags_json,feedback_json FROM attempts WHERE item_id = ? AND review_cycle_id = ? AND exercise_id = ? AND verdict IN ('partial','incorrect') ORDER BY completed_at DESC,id DESC LIMIT 1",
		).get(item.id, state.active_review_cycle_id, state.active_exercise_id) as { verdict: "partial" | "incorrect"; answer_text: string | null; error_tags_json: string | null; feedback_json: string | null } | undefined;
		if (!attempt) return undefined;
		const feedback = parseJsonCol<{ feedback?: string; correctedAnswer?: string }>(attempt.feedback_json);
		const errorTags = parseJsonCol<string[]>(attempt.error_tags_json) ?? [];
		const exercise = sentenceExercise(item);
		if (!exercise) return undefined;
		const lines = [
			attempt.verdict === "partial"
				? `△ 差一点：${feedback?.feedback || "有一个小问题"}`
				: `✗ 再试一次：${feedback?.feedback || "意思或表达还不对"}`,
		];
		lines.push(...spellingComparisonLines(attempt.answer_text, feedback?.correctedAnswer, errorTags));
		if (state.active_retry_count === 1) lines.push(`提示：${exercise.hint}`);
		if (state.active_retry_count >= 2) lines.push(`参考：${feedback?.correctedAnswer || exercise.reference}`);
		lines.push(...renderCard(item, state.active_kind === "review", FACES.error, false, "forward"));
		return lines;
	}

	/** Bump the global card version and cache the rendered state locally. */
	function recordRendered(state: RuntimeState | undefined) {
		if (!state) {
			localVersion = -1;
			return;
		}
		localVersion = state.active_version;
	}

	/** Non-sentence cards always use active recall, including persisted teach states. */
	function effectiveIsReview(item: ItemRow, state: RuntimeState): boolean {
		return state.active_kind === "review" || item.type !== "sentence";
	}

	/**
	 * Re-render the widget from the global active card. Returns true when the
	 * global card changed (so the caller knows a stale local panel should close).
	 */
	function renderGlobalCard(ctx: ExtensionContext): boolean {
		if (!db) return false;
		releaseStaleScreeningCard();
		let state = getRuntimeState(db);
		const item = activeItem(db);
		if (item?.type === "sentence") state = withUndoContinuation(db, () => ensureSentenceCycle(db!, item!, state));
		const changed = state.active_version !== localVersion;
		if (item && state.active_kind) {
			const isReview = effectiveIsReview(item, state);
			pendingItemId = state.active_item_id;
			pendingIsReview = isReview;
			pendingDirection = state.active_direction;
			if (changed) {
				pendingFlipped = state.active_assistance_level === "revealed";
				pendingAssistance = state.active_assistance_level;
			}
			const correction = sentenceCorrectionLines(item, state);
			const face = correction ? FACES.error : isReview ? FACES.review : FACES.teach;
			const lines = correction ?? renderCard(item, isReview, face, pendingFlipped, pendingDirection, activeForwardCue(item, pendingDirection));
			lines.push(statsLine(db));
			updateWidget(ctx, face, lines);
			recordRendered(state);
		} else {
			// No global card: reflect cleared state (respecting pacing status line).
			clearPendingLocals();
			if (changed || localVersion < 0) {
				updateWidget(ctx, FACES.idle, [statsLine(db)]);
				recordRendered(state);
			}
		}
		return changed;
	}

	/**
	 * Poll SQLite for cross-session changes (~1s) using PRAGMA data_version.
	 * Re-renders the global card and resumes timer work after another session
	 * rates/skips the active card so every process converges on the same card.
	 */
	function startPolling() {
		stopPolling();
		if (!db || !latestCtx) return;
		try {
			lastDataVersion = Number(db.prepare("PRAGMA data_version").get()?.data_version ?? 0);
			renderGlobalCard(latestCtx);
		} catch {
			lastDataVersion = null;
		}
		const tick = () => {
			if (!db || !latestCtx || isCtxStale(latestCtx)) {
				pollTimer = undefined;
				return;
			}
			try {
				const version = Number(db.prepare("PRAGMA data_version").get()?.data_version ?? 0);
				if (lastDataVersion === null || version !== lastDataVersion) {
					lastDataVersion = version;
					const previousActive = pendingItemId;
					renderGlobalCard(latestCtx);
					const state = getRuntimeState(db);
					if (state.active_item_id != null) {
						stopTimer();
					} else if (previousActive != null && config.intervalMinutes > 0) {
						// scheduleTimer respects the persisted next_check_at pacing boundary.
						scheduleTimer(0);
					}
				}
				if (Date.now() - lastClientHeartbeat >= COORDINATOR_HEARTBEAT_MS) {
					touchClient(db, myId);
					lastClientHeartbeat = Date.now();
					interruptOrphanedTeachRequests(db);
				}
				const state = getRuntimeState(db);
				if (manualWork && state.generation_token === manualWork.token && state.coordinator === myId) {
					if (Date.now() - manualWork.startedAt >= MANUAL_TEACH_DEADLINE_MS) {
						teachProgress(manualWork.request, "failed", "TEACH_TIMEOUT");
						releaseGeneration(manualWork.token);
					} else if (Date.parse(state.generation_until ?? "") - Date.now() < GENERATION_LEASE_MS - 60_000) {
						setRuntimeState(db, { generation_until: new Date(Date.now() + GENERATION_LEASE_MS).toISOString() });
					}
				}
				drainTeachQueue();
				scheduleReplacementWork();
				scheduleAutoRefillWork();
				const generationExpired = Boolean(
					pendingLLMCall && (!state.generation_until || Date.now() >= new Date(state.generation_until).getTime())
				);
				if (!generationExpired && state.coordinator === myId && Date.now() - lastCoordinatorRenewal >= COORDINATOR_HEARTBEAT_MS) {
					ensureCoordinator(new Date());
				}
				publishForecast();
				refreshStudyUndo(db);
			} catch (err) {
				console.error(`[pi-english-anki] Sync poll failed: ${err}`);
			}
			pollTimer = setTimeout(tick, SYNC_POLL_MS);
			(pollTimer as unknown as { kaomojiPoll?: boolean }).kaomojiPoll = true;
			pollTimer.unref?.();
		};
		pollTimer = setTimeout(tick, SYNC_POLL_MS);
		(pollTimer as unknown as { kaomojiPoll?: boolean }).kaomojiPoll = true;
		pollTimer.unref?.();
	}


	/**
	 * Resolve the lesson model: explicit config first, then auto-detect among
	 * models whose provider has configured auth (logged in / API key present),
	 * falling back to the current session model.
	 */
	function resolveModel(ctx: ExtensionContext): { provider: string; model: string; fromSession: boolean } | undefined {
		const withAuth = (m: { provider: string; id: string }) =>
			ctx.modelRegistry.hasConfiguredAuth(m as never);

		if (config.provider && config.model) {
			const found = ctx.modelRegistry.find(config.provider, config.model);
			if (found && withAuth(found)) {
				resolvedModelName = `${config.provider}/${config.model}`;
				return { provider: config.provider, model: config.model, fromSession: false };
			}
		}

		const available = ctx.modelRegistry.getAvailable().filter(withAuth);
		for (const candidateId of AUTO_DETECT_MODELS) {
			const match = available.find((m) => m.id === candidateId);
			if (match) {
				resolvedModelName = `${match.provider}/${match.id}`;
				return { provider: match.provider, model: match.id, fromSession: false };
			}
		}

		// Last resort: the model currently driving this session (it is by
		// definition authenticated and reachable).
		if (ctx.model) {
			resolvedModelName = `${ctx.model.provider}/${ctx.model.id}（当前会话）`;
			return { provider: ctx.model.provider, model: ctx.model.id, fromSession: true };
		}

		resolvedModelName = "";
		return undefined;
	}

	function updateWidget(ctx: ExtensionContext, _face: string, lines: string[], judgingFrame = false) {
		if (!judgingFrame) publishForecast();
		// While the answer-judging animation is running it owns the widget: drop
		// interleaved renders (sync-poll card paints, stray pet ticks) so the
		// widget cannot alternate between the card and the spinner (flicker).
		if (answerJudging && !judgingFrame) return;
		if (isCtxStale(ctx)) return;
		if (!ctx.hasUI) return;
		if (!config.showWidget) {
			if (!judgingFrame) lastWidgetLines = [];
			ctx.ui.setWidget("pi-english-anki", undefined);
			return;
		}
		const accent = (s: string): string => {
			try {
				return ctx.ui.theme.fg("thinkingXhigh", s);
			} catch {
				return s;
			}
		};
		const width = Math.max(20, (process.stdout.columns || 120) - 2);
		const out = lines.filter(Boolean).flatMap((line) => wrapTextWithAnsi(line, width));
		if (!judgingFrame) lastWidgetLines = out.length === 0 ? [] : lines;
		if (out.length === 0) {
			ctx.ui.setWidget("pi-english-anki", undefined);
			return;
		}
		ctx.ui.setWidget("pi-english-anki", out.map(accent), { placement: "belowEditor" });
	}

	/** Whether an already-stored review/new card can be claimed right now. */
	function hasReadyStoredCard(now: Date): boolean {
		if (!db) return false;
		const dueReview = db.prepare(`SELECT 1 FROM items WHERE due_at <= ? AND shown = 1 ${SCHEDULABLE} LIMIT 1`)
			.get(now.toISOString());
		if (dueReview) return true;
		// Replacement queued-new is always claimable (quota-free).
		const replacementNew = db.prepare(`SELECT 1 FROM items WHERE due_at <= ? AND shown = 0 AND introduction_kind = 'replacement' ${SCHEDULABLE} LIMIT 1`)
			.get(now.toISOString());
		if (replacementNew) return true;
		if (!hasNewCardCapacity(loadPlan(db, now), countTodayNew(db, now))) return false;
		return Boolean(db.prepare(`SELECT 1 FROM items WHERE due_at <= ? AND shown = 0 AND (introduction_kind IN ('planned', 'custom') OR introduction_kind IS NULL) ${SCHEDULABLE} LIMIT 1`).get(now.toISOString()));
	}

	/** Whether a queued /anki:add or weekly-challenge card is releasable right
	 * now: the daily quota still has room and no replacement obligation
	 * outranks the FIFO queue. Only meaningful when hasReadyStoredCard already
	 * ruled out every stored card. */
	function hasReleasableQueueCard(now: Date): boolean {
		if (!db) return false;
		if (customQueueCount(db) === 0) return false;
		if (pendingReplacementTypes(db).length > 0) return false;
		return hasNewCardCapacity(loadPlan(db, now), countTodayNew(db, now));
	}

	/**
	 * Screening sweep claim: a random not-yet-offered card that normal study
	 * has never shown — unshown word/phrase/cloze inventory plus the custom
	 * queue — quizzed right away with no pacing, quota, or due gate. Cards
	 * already in normal study never enter the sweep. A queue row is
	 * materialized and an unshown item marked shown only so the normal answer
	 * path works; both are reverted on a miss (see revertScreeningPresentation).
	 */
	function claimScreeningItem(now: Date): ItemRow | undefined {
		if (!db) return undefined;
		try {
			db.exec("BEGIN IMMEDIATE");
			const state = getRuntimeState(db);
			if (state.active_item_id != null) {
				db.exec("ROLLBACK");
				return undefined;
			}
			const pool = `status = 'learning' AND shown = 0 AND type IN ('word', 'phrase', 'cloze') AND id NOT IN (SELECT value FROM json_each(?)) ${SCHEDULABLE}`;
			const missed = readScreeningMissed();
			const sweptItems = JSON.stringify([...screeningSwept, ...missed.items]);
			const sweptQueue = JSON.stringify([...screeningSweptQueue, ...missed.queue]);
			// Likely-known cards first (screeningEase), so early rounds clear the most cards; ties stay random.
			const textOf = (payload: string) => {
				try { return String(JSON.parse(payload).text ?? ""); } catch { return ""; }
			};
			const candidates = [
				...(db.prepare(`SELECT id, text FROM items WHERE ${pool}`).all(sweptItems) as { id: number; text: string }[])
					.map((row) => ({ ease: screeningEase(row.text), itemId: row.id as number | undefined, raw: undefined as Record<string, unknown> | undefined })),
				...(db.prepare("SELECT * FROM custom_card_queue WHERE id NOT IN (SELECT value FROM json_each(?))").all(sweptQueue) as Record<string, unknown>[])
					.map((raw) => ({ ease: screeningEase(textOf(String(raw.payload))), itemId: undefined as number | undefined, raw })),
			].map((c) => ({ ...c, tie: Math.random() })).sort((a, b) => b.ease - a.ease || a.tie - b.tie);
			let card: ScreeningCard | undefined;
			for (const candidate of candidates) {
				if (candidate.itemId !== undefined) {
					card = { itemId: candidate.itemId, wasShown: false };
					break;
				}
				const raw = candidate.raw!;
				const queueRow: CustomQueueRow = {
					id: Number(raw.id), created_at: String(raw.created_at), prompt: String(raw.prompt),
					fingerprint: String(raw.fingerprint), payload: String(raw.payload),
				};
				screeningSweptQueue.add(queueRow.id);
				const item = (() => {
					try { return parseGeneratedItem(JSON.parse(queueRow.payload)); } catch { return undefined; }
				})();
				// Duplicate or malformed rows stay queued untouched for the normal release path.
				if (!item || item.type === "sentence" || db.prepare("SELECT 1 FROM items WHERE content_fingerprint = ?").get(queueRow.fingerprint)) continue;
				const id = insertItem(db, item.type, item.text, item.phonetic || null, item.meaning, item.example || null, item.example_cn || null, now, {
					levels: item.levels,
					levels_cn: item.levels_cn,
					chunks: item.chunks,
					keyWords: item.keyWords,
					animation: item.animation,
					introductionKind: "custom",
				});
				removeCustomQueueRows(db, [queueRow.id]);
				card = { itemId: id, wasShown: false, queueRow };
				break;
			}
			if (!card) {
				db.exec("ROLLBACK");
				return undefined;
			}
			if (!card.wasShown) markShown(db, card.itemId);
			writeScreeningCard(card);
			setRuntimeState(db, {
				active_item_id: card.itemId,
				active_kind: "review",
				active_direction: "forward",
				active_version: state.active_version + 1,
				...EMPTY_SENTENCE_CYCLE,
				next_check_at: now.toISOString(),
			});
			db.exec("COMMIT");
			screeningSwept.add(card.itemId);
			return db.prepare("SELECT * FROM items WHERE id = ?").get(card.itemId) as unknown as ItemRow | undefined;
		} catch (err) {
			try { db.exec("ROLLBACK"); } catch { /* no transaction */ }
			console.error(`[pi-english-anki] Screening claim failed: ${err}`);
			return undefined;
		}
	}

	/** How to undo the sweep card on screen. Stored in the DB so any session
	 * (or this one after a restart) can put it back once screening is off. */
	function readScreeningCard(): ScreeningCard | undefined {
		const raw = db ? getStat(db, SCREENING_CARD_STAT) : null;
		try { return raw ? JSON.parse(raw) as ScreeningCard : undefined; } catch { return undefined; }
	}
	function writeScreeningCard(card?: ScreeningCard) {
		if (db) setStat(db, SCREENING_CARD_STAT, card ? JSON.stringify(card) : "");
	}

	function readScreeningMissed(): { items: number[]; queue: number[] } {
		const raw = db ? getStat(db, SCREENING_MISSED_STAT) : null;
		try {
			const parsed = raw ? JSON.parse(raw) as { items?: unknown; queue?: unknown } : {};
			const ids = (v: unknown) => Array.isArray(v) ? v.filter((n): n is number => Number.isSafeInteger(n)) : [];
			return { items: ids(parsed.items), queue: ids(parsed.queue) };
		} catch { return { items: [], queue: [] }; }
	}
	/** Inside a transaction, before the presentation is reverted: remember a miss permanently. */
	function recordScreeningMiss(itemId: number) {
		if (!db) return;
		const card = readScreeningCard();
		const missed = readScreeningMissed();
		if (card?.itemId === itemId && card.queueRow) missed.queue.push(card.queueRow.id);
		else missed.items.push(itemId);
		setStat(db, SCREENING_MISSED_STAT, JSON.stringify(missed));
	}

	/** Inside a transaction: undo what claimScreeningItem did to `itemId` (queue row back in place, shown flag restored). */
	function revertScreeningPresentation(itemId: number) {
		const card = readScreeningCard();
		if (!db || card?.itemId !== itemId) return;
		const { wasShown, queueRow } = card;
		writeScreeningCard();
		if (queueRow) {
			for (const table of ["exercises", "direction_state", "mastery_state"]) {
				db.prepare(`DELETE FROM ${table} WHERE item_id = ?`).run(itemId);
			}
			db.prepare("DELETE FROM items WHERE id = ?").run(itemId);
			db.prepare("INSERT INTO custom_card_queue (id, created_at, prompt, fingerprint, payload) VALUES (?, ?, ?, ?, ?)")
				.run(queueRow.id, queueRow.created_at, queueRow.prompt, queueRow.fingerprint, queueRow.payload);
		} else if (!wasShown) {
			db.prepare("UPDATE items SET shown = 0 WHERE id = ?").run(itemId);
		}
	}

	/** Outside screening, put back a sweep card still on screen (or forget a
	 * record whose card was already rated elsewhere). Returns true when the
	 * active card was released. */
	function releaseStaleScreeningCard(): boolean {
		if (!db || db.isTransaction || screeningActive(true)) return false;
		const card = readScreeningCard();
		if (!card) return false;
		let released = false;
		try {
			db.exec("BEGIN IMMEDIATE");
			const cur = getRuntimeState(db);
			if (cur.active_item_id === card.itemId) {
				revertScreeningPresentation(card.itemId);
				setRuntimeState(db, {
					active_item_id: null,
					active_kind: null,
					active_direction: "forward",
					active_version: cur.active_version + 1,
					...EMPTY_SENTENCE_CYCLE,
					next_check_at: new Date().toISOString(),
				});
				released = true;
			} else {
				writeScreeningCard();
			}
			db.exec("COMMIT");
		} catch (err) {
			try { db.exec("ROLLBACK"); } catch { /* no transaction */ }
			console.error(`[pi-english-anki] Screening release failed: ${err}`);
		}
		if (released) clearPendingLocals();
		return released;
	}

	/** Entering screening: put a normal study card on screen back untouched (it
	 * stays due) so the sweep starts at once instead of after that card. */
	function releaseStudyCardForScreening(): boolean {
		if (!db || db.isTransaction) return false;
		let released = false;
		try {
			db.exec("BEGIN IMMEDIATE");
			const cur = getRuntimeState(db);
			if (cur.active_item_id != null && readScreeningCard()?.itemId !== cur.active_item_id) {
				setRuntimeState(db, {
					active_item_id: null,
					active_kind: null,
					active_direction: "forward",
					active_version: cur.active_version + 1,
					...EMPTY_SENTENCE_CYCLE,
					next_check_at: new Date().toISOString(),
				});
				released = true;
			}
			db.exec("COMMIT");
		} catch (err) {
			try { db.exec("ROLLBACK"); } catch { /* no transaction */ }
			console.error(`[pi-english-anki] Study card release failed: ${err}`);
		}
		if (released) clearPendingLocals();
		return released;
	}

	/** Atomically select, mark, and activate the next due card. */
	function claimDueItem(now: Date, reviewsOnly = false): ItemRow | undefined {
		if (!db) return undefined;
		if (screeningActive(true)) return claimScreeningItem(now);
		try {
			db.exec("BEGIN IMMEDIATE");
			const state = getRuntimeState(db);
			if (state.active_item_id != null || !pacingReady(state, now)) {
				db.exec("ROLLBACK");
				return undefined;
			}
			const undo = beginUndoContinuation(db);
			// Review cards take priority over queued-new cards. Within due reviews
			// the order is shuffled: FSRS preserves the clock time of each review,
			// so a deterministic order would echo the same batch sequence day after
			// day (A→B→C reviewed tonight resurfaces A→B→C in that order forever).
			let due = db.prepare(`SELECT * FROM items WHERE due_at <= ? AND shown = 1 ${SCHEDULABLE} ORDER BY RANDOM() LIMIT 1`)
				.get(now.toISOString()) as ItemRow | undefined;
			let isReview = true;
			if (!due && reviewsOnly) {
				db.exec("ROLLBACK");
				return undefined;
			}
			if (!due) {
				// New cards surface in due-time order: a replacement generated now sorts
				// after older planned inventory, and an older replacement sorts ahead of
				// a newer batch. Quota applies to planned/custom only; replacements
				// stay quota-free, so a full quota simply hides planned candidates.
				const capacity = hasNewCardCapacity(loadPlan(db, now), countTodayNew(db, now));
				const kinds = capacity
					? "(introduction_kind = 'replacement' OR introduction_kind IN ('planned', 'custom') OR introduction_kind IS NULL)"
					: "introduction_kind = 'replacement'";
				due = db.prepare(`SELECT * FROM items WHERE due_at <= ? AND shown = 0 AND ${kinds} ${SCHEDULABLE} ORDER BY due_at ASC, id ASC LIMIT 1`)
					.get(now.toISOString()) as ItemRow | undefined;
				// When planned/custom inventory leads, its word/phrase cards go easiest
				// level first (studyOrder: CEFR, then frequency) instead of insertion order.
				if (due && due.introduction_kind !== "replacement" && (due.type === "word" || due.type === "phrase")) {
					const pool = db.prepare(`SELECT id, text FROM items WHERE due_at <= ? AND shown = 0 AND type IN ('word', 'phrase') AND (introduction_kind IN ('planned', 'custom') OR introduction_kind IS NULL) ${SCHEDULABLE}`)
						.all(now.toISOString()) as { id: number; text: string }[];
					let best = { id: due.id, order: studyOrder(due.text) };
					for (const row of pool) {
						const order = studyOrder(row.text);
						if (order < best.order || (order === best.order && row.id < best.id)) best = { id: row.id, order };
					}
					due = db.prepare("SELECT * FROM items WHERE id = ?").get(best.id) as unknown as ItemRow;
				}
				isReview = false;
			}
			if (!due) {
				db.exec("ROLLBACK");
				return undefined;
			}
			if (!isReview) {
				markShown(db, due.id);
				db.prepare("UPDATE items SET introduced_at = ?, introduction_kind = COALESCE(introduction_kind, 'planned') WHERE id = ?")
					.run(now.toISOString(), due.id);
				bumpStat(db, "total_learned", 1);
				touchStreak(db, now);
			}
			const direction: RecallDirection = (due.type === "word" || due.type === "phrase") && isReview ? dueDirection(db, due.id, now) : "forward";
			setRuntimeState(db, {
				active_item_id: due.id,
				// Cloze cards quiz from the very first showing: the blank + lemma hint
				// is self-contained, so a teach face would only leak the answer and the
				// first attempt is genuine mastery evidence.
				active_kind: isReview || due.type === "cloze" ? "review" : "teach",
				active_direction: direction,
				active_version: state.active_version + 1,
				...EMPTY_SENTENCE_CYCLE,
				next_check_at: now.toISOString(),
			});
			finishUndoContinuation(db, undo);
			db.exec("COMMIT");
			return db.prepare("SELECT * FROM items WHERE id = ?").get(due.id) as unknown as ItemRow | undefined;
		} catch (err) {
			try { db.exec("ROLLBACK"); } catch { /* no transaction */ }
			console.error(`[pi-english-anki] Due-card claim failed: ${err}`);
			return undefined;
		}
	}

	/** Render an item only when it is still the authoritative global card. */
	function showItem(ctx: ExtensionContext, item: ItemRow): boolean {
		if (!db) return false;
		let state = getRuntimeState(db);
		if (state.active_item_id !== item.id || !state.active_kind) return false;
		if (item.type === "sentence") state = withUndoContinuation(db, () => ensureSentenceCycle(db!, item, state));
		const isReview = effectiveIsReview(item, state);
		pendingItemId = item.id;
		pendingFlipped = false;
		pendingIsReview = isReview;
		pendingDirection = state.active_direction;
		pendingAssistance = state.active_assistance_level;
		recordRendered(state);
		const face = isReview ? FACES.review : FACES.teach;
		const lines = renderCard(item, isReview, face, false, pendingDirection, activeForwardCue(item, pendingDirection));
		lines.push(statsLine(db));
		updateWidget(ctx, face, lines);
		if (config.verbose) {
			ctx.ui.notify(item.reviews === 0 ? "新卡已放出，请先作答" : "复习卡已放出，请先作答", "info");
		}
		return true;
	}

	/** Populate the local projection when another session activated a card before this session observed it. */
	function hydratePending(ctx: ExtensionContext) {
		if (pendingItemId == null && db && getRuntimeState(db).active_item_id != null) {
			renderGlobalCard(ctx);
		}
	}

	/** Show the same pre-answer context in CLI/RPC and the desktop; a parenthetical definition is not proof of uniqueness. */
	function activeForwardCue(item: ItemRow, direction: RecallDirection): ForwardCue | undefined {
		if (!db || direction !== "forward" || (item.type !== "word" && item.type !== "phrase")) return undefined;
		return forwardCue(item);
	}

	/** Toggle the pending card between its question and answer sides. */
	function flipPending(ctx: ExtensionContext): boolean {
		hydratePending(ctx);
		if (pendingItemId == null || !db) return false;
		invalidateStudyUndo(db);
		let state = getRuntimeState(db);
		if (state.active_item_id !== pendingItemId || state.active_version !== localVersion) {
			renderGlobalCard(ctx);
			return true;
		}
		const item = db.prepare("SELECT * FROM items WHERE id = ?").get(pendingItemId) as ItemRow | undefined;
		if (!item) return true;
		if (item.type === "sentence") state = ensureSentenceCycle(db, item, state);
		pendingFlipped = !pendingFlipped;
		if (pendingFlipped) {
			pendingAssistance = "revealed";
			if (item.type === "sentence") {
				db.prepare("UPDATE runtime_state SET active_cycle_outcome = 'again', active_assistance_level = 'revealed', active_version = active_version + 1 WHERE id = 1 AND active_item_id = ? AND active_version = ?")
					.run(item.id, state.active_version);
				state = getRuntimeState(db);
				recordRendered(state);
			} else {
				// Word/phrase: persist the reveal so it survives reload/reattach (P0-2).
				db.prepare("UPDATE runtime_state SET active_assistance_level = 'revealed', active_version = active_version + 1 WHERE id = 1 AND active_item_id = ?")
					.run(item.id);
				recordRendered(getRuntimeState(db));
			}
		}
		const face = pendingIsReview ? FACES.review : FACES.teach;
		const lines = renderCard(item, pendingIsReview, face, pendingFlipped, pendingDirection, activeForwardCue(item, pendingDirection));
		lines.push(statsLine(db));
		updateWidget(ctx, face, lines);
		return true;
	}

	/** Record a sentence miss without scheduling FSRS; the same level remains active for corrective output. */
	function recordSentenceMiss(
		ctx: ExtensionContext,
		item: ItemRow,
		attempt: PendingAttempt,
		exercise: SentenceExerciseView,
	): boolean {
		if (!db || attempt.sessionGeneration !== sessionGeneration || !attempt.reviewCycleId) return true;
		let retryCount = 0;
		try {
			db.exec("BEGIN IMMEDIATE");
			const cur = getRuntimeState(db);
			const current = db.prepare("SELECT progress FROM items WHERE id = ?").get(item.id) as { progress: number } | undefined;
			if (
				cur.active_item_id === item.id &&
				cur.active_version === attempt.version &&
				cur.active_review_cycle_id === attempt.reviewCycleId &&
				cur.active_exercise_id === attempt.exerciseId &&
				current?.progress === exercise.level
			) {
				insertEvaluatedAttempt(db, attempt, null, new Date());
				retryCount = cur.active_retry_count + 1;
				setRuntimeState(db, {
					active_cycle_outcome: "again",
					active_retry_count: retryCount,
					active_assistance_level: retryCount >= 2 ? "revealed" : "hint",
					active_version: cur.active_version + 1,
				});
			}
			db.exec("COMMIT");
		} catch (err) {
			try { db.exec("ROLLBACK"); } catch { /* no transaction */ }
			console.error(`[pi-english-anki] Sentence-attempt CAS failed: ${err}`);
		}
		renderGlobalCard(ctx);
		return true;
	}

	/** Written sentence output with semantic evaluation and corrective retry. */
	async function answerSentencePending(ctx: ExtensionContext, item: ItemRow, rawText: string, initialState: RuntimeState): Promise<boolean> {
		if (!db) return false;
		const state = ensureSentenceCycle(db, item, initialState);
		const exercise = sentenceExercise(item);
		if (!exercise || !state.active_review_cycle_id || state.active_exercise_id == null) return false;
		const text = rawText.trim();
		if (!text) {
			const face = state.active_kind === "review" ? FACES.review : FACES.teach;
			const lines = renderCard(item, state.active_kind === "review", face, false);
			lines.push(statsLine(db));
			updateWidget(ctx, face, lines);
			return true;
		}
		const attemptBase = {
			itemId: item.id,
			version: state.active_version,
			direction: "forward" as const,
			sessionGeneration,
			answerText: text,
			assistanceLevel: state.active_assistance_level,
			startedAt: new Date().toISOString(),
			reviewCycleId: state.active_review_cycle_id,
			exerciseId: state.active_exercise_id,
			kind: exercise.kind,
			questionText: sentenceQuestionText(exercise),
		};
		startAnswerThinking(ctx, attemptBase.sessionGeneration);
		let result: SentenceEvaluation;
		try {
			result = await evaluateSentenceAttempt(llm, ctx, exercise, text, resolveModel(ctx));
		} finally {
			stopAnswerThinking();
		}
		if (attemptBase.sessionGeneration !== sessionGeneration) {
			renderGlobalCard(ctx);
			return true;
		}
		if (!result.available) {
			renderGlobalCard(ctx);
			ctx.ui.notify("暂时无法可靠判断这个句子；没有记录成绩，请稍后重试或使用 /anki:again", "warning");
			return true;
		}
		const attempt: PendingAttempt = {
			...attemptBase,
			verdict: result.verdict,
			feedback: result.feedback,
			errorTags: result.errorTags,
			correctedAnswer: result.correctedAnswer,
		};
		if (result.verdict !== "correct") return recordSentenceMiss(ctx, item, attempt, exercise);
		const levels = parseJsonCol<string[]>(item.levels) ?? [];
		const finalLevel = exercise.level >= levels.length - 1;
		const cleanRecall = state.active_cycle_outcome === "clean" && state.active_retry_count === 0 && state.active_assistance_level === "none";
		const rating = finalLevel && !cleanRecall ? Rating.Again : Rating.Good;
		const note = finalLevel
			? cleanRecall ? "✓ 独立写对了！" : "✓ 已改对；首次回忆有辅助或错误，本轮按 Again 调度。"
			: `✓ L${exercise.level + 1} 写对了，进入 L${exercise.level + 2}。`;
		ratePending(ctx, rating, note, attempt);
		return true;
	}

	/** Active-recall answer for all cards. Exact matches stay local; semantic variants use the SDK evaluator. */
	async function answerPending(ctx: ExtensionContext, rawText: string): Promise<boolean> {
		hydratePending(ctx);
		if (pendingItemId == null || !db) return false;
		if (rawText.trim()) invalidateStudyUndo(db);
		const state = getRuntimeState(db);
		if (
			state.active_item_id !== pendingItemId ||
			state.active_version !== localVersion ||
			state.active_direction !== pendingDirection
		) {
			renderGlobalCard(ctx);
			return true;
		}
		const item = db.prepare("SELECT * FROM items WHERE id = ?").get(pendingItemId) as ItemRow | undefined;
		if (!item) return true;
		if (item.type === "sentence") return answerSentencePending(ctx, item, rawText, state);
		const text = rawText.trim();
		if (!text) {
			const cue = activeForwardCue(item, pendingDirection);
			const promptText = item.type === "cloze"
				? `✍️ 请补全：${item.text}`
				: pendingDirection === "reverse"
					? `✍️ ${recallQuestionText(item, "reverse")}`
					: `✍️ ${recallQuestionText(item, "forward", cue)}`;
			updateWidget(ctx, FACES.review, [
				`${FACES.review} ${promptText}`,
				"用 /anki:answer <你的答案>，或 /anki:hint 看提示，或 /anki:flip 看答案",
				statsLine(db),
			]);
			return true;
		}

		// Capture every identity field before an LLM await. Later local/global card
		// changes must not redirect this answer to a different item.
		const attemptBase = {
			itemId: item.id,
			version: state.active_version,
			direction: state.active_direction,
			sessionGeneration,
			answerText: text,
			assistanceLevel: pendingAssistance,
			startedAt: new Date().toISOString(),
			questionText: recallQuestionText(item, state.active_direction, activeForwardCue(item, state.active_direction)),
		};
		const norm = (s: string) => item.type === "cloze"
			? s.toLowerCase().replace(/[’]/g, "'").replace(/[^a-z0-9']+/g, " ").trim().replace(/\s+/g, " ")
			: s.trim().toLowerCase().replace(/\s+/g, " ");
		const target = item.type === "cloze"
			? item.meaning
			: attemptBase.direction === "reverse" ? item.meaning : item.text;
		const exact = norm(text) === norm(target);
		let verdict: PendingAttempt["verdict"] = exact ? "correct" : "incorrect";
		let feedback = "";
		// Screening passes on an exact match only, so a mismatch is a miss
		// without grading: no LLM call, the sweep settles at once.
		if (!exact && !screeningActive()) {
			const tries = state.active_retry_count > 0 ? readSynonymTries(db, item.id, attemptBase.direction) : undefined;
			// Repeating a synonym already tried costs nothing and needs no grading.
			if (tries?.answers.includes(norm(text))) {
				ctx.ui.notify(`同义词，再试一次：${text} 已经试过了，换一个词${tries.hint ? `。提示：${tries.hint}` : ""}`, "info");
				return true;
			}
			startAnswerThinking(ctx, attemptBase.sessionGeneration);
			let result: AnswerEvaluation;
			try {
				result = await evaluateAttempt(llm, ctx, item, text, resolveModel(ctx), attemptBase.direction, attemptBase.questionText, tries?.answers);
			} finally {
				stopAnswerThinking();
			}
			if (attemptBase.sessionGeneration !== sessionGeneration) {
				renderGlobalCard(ctx);
				return true;
			}
			if (!result.available) {
				renderGlobalCard(ctx);
				ctx.ui.notify("暂时无法可靠判断这个答案；没有记录成绩，请稍后重试或使用 /anki:again", "warning");
				return true;
			}
			verdict = result.verdict;
			feedback = result.feedback;
			// A synonym shows the meaning, not recall of the target: each new one
			// earns another try without a rating, until the target or a miss.
			if (result.synonym && !screeningActive()) {
				const answers = [...(tries?.answers ?? []), norm(text)];
				const hint = result.retryHint || tries?.hint || "";
				let retried = false;
				try {
					db.exec("BEGIN IMMEDIATE");
					const changes = db.prepare("UPDATE runtime_state SET active_retry_count = ?, active_version = active_version + 1 WHERE id = 1 AND active_item_id = ? AND active_version = ? AND active_direction = ?")
						.run(answers.length, item.id, attemptBase.version, attemptBase.direction).changes;
					retried = Number(changes) > 0;
					if (retried) {
						db.prepare("INSERT OR REPLACE INTO stats(key, value) VALUES(?, ?)")
							.run(SYNONYM_TRIES_STAT, JSON.stringify({ itemId: item.id, direction: attemptBase.direction, answers, hint }));
					}
					db.exec("COMMIT");
				} catch (err) {
					try { db.exec("ROLLBACK"); } catch { /* no transaction */ }
					console.error(`[pi-english-anki] Synonym retry failed: ${err}`);
					ctx.ui.notify("暂时无法记录这次重试；没有记录成绩，请再答一次", "warning");
					return true;
				}
				if (!retried) {
					renderGlobalCard(ctx);
					return true;
				}
				recordRendered(getRuntimeState(db));
				// Writes no attempt, so it must notify or the app waits out its answer timeout.
				ctx.ui.notify(`同义词，再试一次：${text} 也说得通，但本题要的是另一个词${hint ? `。提示：${hint}` : ""}`, "info");
				return true;
			}
		}
		const attempt: PendingAttempt = { ...attemptBase, verdict, feedback, correctedAnswer: target, exact };
		// Auto-rate: correct -> Good, miss (partial/incorrect) -> Again.
		const autoRating = verdict === "correct" ? Rating.Good : Rating.Again;
		const recallNote = verdict === "correct"
			? "✓ 答对了！"
			: verdict === "partial"
				? `△ 差一点：${feedback || "有小问题"}（正确：${target}）`
				: `✗ 答案是：${target}`;
		ratePending(ctx, autoRating, recallNote, attempt);
		return true;
	}

	/** Persist a recall exercise template for a word/phrase item (idempotent, groundwork for M3 multi-exercise). */
	function ensureRecallExercise(item: ItemRow) {
		if (!db) return;
		const answer = item.type === "cloze" ? item.meaning : item.text;
		const hint = answer[0] + "_".repeat(Math.max(0, answer.length - 1));
		db.prepare(
			"INSERT OR IGNORE INTO exercises (item_id, kind, schema_version, stage, content_fingerprint, prompt_json, answer_json, hints_json, rubric_json, quality_json, created_at) VALUES (?, 'recall', 1, 'recall', ?, ?, ?, ?, '{}', '{}', ?)",
		).run(
			item.id,
			"recall:" + item.id,
			JSON.stringify(item.type === "cloze" ? { cloze: item.text } : { meaning: item.meaning }),
			JSON.stringify({ acceptedForms: [answer] }),
			JSON.stringify([hint]),
			new Date().toISOString(),
		);
	}

	/** Show a direction-aware hint and persist sentence assistance globally. */
	function hintPending(ctx: ExtensionContext): boolean {
		hydratePending(ctx);
		if (pendingItemId == null || !db) return false;
		let state = getRuntimeState(db);
		if (state.active_item_id !== pendingItemId || state.active_version !== localVersion) {
			renderGlobalCard(ctx);
			return true;
		}
		const item = db.prepare("SELECT * FROM items WHERE id = ?").get(pendingItemId) as ItemRow | undefined;
		if (!item) return false;
		if (item.type === "sentence") {
			state = ensureSentenceCycle(db, item, state);
			const exercise = sentenceExercise(item);
			if (!exercise) return false;
			db.prepare("UPDATE runtime_state SET active_cycle_outcome = 'again', active_assistance_level = CASE WHEN active_assistance_level = 'revealed' THEN 'revealed' ELSE 'hint' END, active_version = active_version + 1 WHERE id = 1 AND active_item_id = ? AND active_version = ?")
				.run(item.id, state.active_version);
			state = getRuntimeState(db);
			pendingAssistance = state.active_assistance_level;
			recordRendered(state);
			ctx.ui.notify(`提示：${exercise.hint}`, "info");
			return true;
		}
		const hint = item.type === "cloze"
			? item.meaning.split(/\s+/).map((word) => word[0] + "_".repeat(Math.max(0, word.replace(/[^A-Za-z]/g, "").length - 1))).join(" ")
			: pendingDirection === "reverse"
			? item.meaning.split(/([，,；;、/\s]+)/).map((part) => {
				if (!part || /^[，,；;、/\s]+$/.test(part)) return part;
				const chars = Array.from(part);
				return chars[0] + "_".repeat(Math.max(0, chars.length - 1));
			}).join("")
			: item.text.split(/\s+/).map((word) => word[0] + "_".repeat(Math.max(0, word.length - 1))).join(" ");
		if (pendingAssistance === "none") pendingAssistance = "hint";
		// Persist assistance so the scheduling policy survives reload/reattach (P0-2).
		db.prepare("UPDATE runtime_state SET active_assistance_level = CASE WHEN active_assistance_level = 'none' THEN 'hint' ELSE active_assistance_level END, active_version = active_version + 1 WHERE id = 1 AND active_item_id = ?")
			.run(item.id);
		recordRendered(getRuntimeState(db));
		ctx.ui.notify(`提示：${hint}`, "info");
		return true;
	}

	// -- Pet tick ---------------------------------------------------------

	/** Show the sentence card at a given level (0-based). */
	function showSentenceLevel(ctx: ExtensionContext, item: ItemRow, level: number) {
		const shown = { ...item, progress: level } as ItemRow;
		let state = getRuntimeState(db!);
		state = ensureSentenceCycle(db!, shown, state);
		pendingFlipped = false;
		pendingIsReview = state.active_kind === "review";
		pendingDirection = "forward";
		pendingAssistance = state.active_assistance_level;
		recordRendered(state);
		const face = pendingIsReview ? FACES.review : FACES.teach;
		const lines = renderCard(shown, pendingIsReview, face, false);
		lines.push(statsLine(db!));
		updateWidget(ctx, face, lines);
	}

	/** Rate the pending review card; returns true once an action was taken (or a stale action was safely refreshed). */
	function ratePending(ctx: ExtensionContext, rating: Rating, recallNote = "", attempt?: PendingAttempt): boolean {
		// An answer that resumed after reload/session switch belongs to the old runtime.
		if (attempt && attempt.sessionGeneration !== sessionGeneration) return true;
		hydratePending(ctx);
		if (!db) return false;
		const expectedItemId = attempt?.itemId ?? pendingItemId;
		if (expectedItemId == null) return false;
		const expectedVersion = attempt?.version ?? localVersion;
		const expectedDirection = attempt?.direction ?? pendingDirection;
		let assistanceLevel = attempt?.assistanceLevel ?? pendingAssistance;

		const item = db.prepare("SELECT * FROM items WHERE id = ?").get(expectedItemId) as ItemRow | undefined;
		if (!item || item.shown === 0) {
			clearPendingLocals();
			return true;
		}

		const now = new Date();
		const levels = parseJsonCol<string[]>(item.levels);
		let stateAtStart = getRuntimeState(db);
		if (item.type === "sentence") {
			stateAtStart = ensureSentenceCycle(db, item, stateAtStart);
			assistanceLevel = attempt?.assistanceLevel ?? stateAtStart.active_assistance_level;
		}
		// Bind the rating to the exact item/version/direction observed before any LLM await.
		if (
			stateAtStart.active_item_id !== item.id ||
			stateAtStart.active_version !== expectedVersion ||
			stateAtStart.active_direction !== expectedDirection
		) {
			clearPendingLocals();
			renderGlobalCard(ctx);
			return true;
		}

		// Only the card the sweep itself claimed is graded as screening; a study
		// card left on screen (e.g. by a session with a stale mode cache) keeps normal scheduling.
		if (screeningActive() && item.type !== "sentence" && readScreeningCard()?.itemId === item.id) {
			return rateScreening(ctx, item, rating, assistanceLevel, expectedVersion, expectedDirection, recallNote, attempt);
		}

		// A sentence Good must come from an evaluated written answer; manual Again remains an escape hatch.
		if (item.type === "sentence" && (rating === Rating.Good || rating === Rating.Easy) && !attempt) {
			ctx.ui.notify("句子卡请先用 /anki:answer <英文> 完成输出；也可以用 /anki:again 结束本轮", "info");
			return true;
		}

		// A correct written answer advances progressive levels. Manual Again rates the whole card immediately.
		if (item.type === "sentence" && levels && levels.length > 1) {
			const nextProgress = rating === Rating.Good && item.progress < levels.length - 1
				? item.progress + 1
				: null;
			if (nextProgress != null) {
				let applied = false;
				try {
					db.exec("BEGIN IMMEDIATE");
					const cur = getRuntimeState(db);
					const current = db.prepare("SELECT progress FROM items WHERE id = ?").get(item.id) as { progress: number } | undefined;
					if (
						cur.active_item_id === item.id &&
						cur.active_version === expectedVersion &&
						cur.active_direction === expectedDirection &&
						current?.progress === item.progress &&
						(!attempt || (
							cur.active_review_cycle_id === attempt.reviewCycleId &&
							cur.active_exercise_id === attempt.exerciseId
						))
					) {
						if (attempt) insertEvaluatedAttempt(db, attempt, null, now);
						db.prepare("UPDATE items SET progress = ?, due_at = ? WHERE id = ?").run(nextProgress, now.toISOString(), item.id);
						const nextItem = { ...item, progress: nextProgress } as ItemRow;
						const nextExercise = sentenceExercise(nextItem);
						const nextExerciseId = nextExercise ? ensureSentenceExercise(db, nextItem, nextExercise) : null;
						setRuntimeState(db, {
							active_kind: cur.active_kind,
							active_direction: "forward",
							active_version: cur.active_version + 1,
							active_exercise_id: nextExerciseId,
							active_retry_count: 0,
							active_assistance_level: "none",
							next_check_at: now.toISOString(),
						});
						applied = true;
					}
					db.exec("COMMIT");
				} catch (err) {
					try { db.exec("ROLLBACK"); } catch { /* no transaction */ }
					console.error(`[pi-english-anki] Sentence CAS failed: ${err}`);
				}
				if (!applied) {
					clearPendingLocals();
					renderGlobalCard(ctx);
					return true;
				}
				const state = getRuntimeState(db);
				recordRendered(state);
				const refreshed = db.prepare("SELECT * FROM items WHERE id = ?").get(item.id) as unknown as ItemRow;
				showSentenceLevel(ctx, refreshed, nextProgress);
				pendingItemId = item.id;
				return true;
			}
			// Full-level Good and any Again hand over to FSRS.
		}

		// Full rating: one-shot, atomic, applies at most once globally.
		// Word/phrase: assistance-aware effective rating + per-direction schedule (P0-1/P0-2).
		// Cloze: assistance-aware rating but a single-direction FSRS state like sentences.
		const isRecall = item.type !== "sentence";
		const usesDirection = item.type === "word" || item.type === "phrase";
		const effective = isRecall
			? effectiveRecallRating({ rating, assistance: assistanceLevel, manual: !attempt })
			: rating;
		const stateForSchedule = usesDirection
			? (directionFsrsState(db, item.id, expectedDirection) ?? item.fsrs_state)
			: item.fsrs_state;
		const next = scheduleNext(stateForSchedule, now, effective);
		if ("corrupt" in next) {
			if (db) quarantineCorruptFsrs(db, item.id, stateForSchedule ?? "", next.error, now);
			clearPendingLocals();
			if (!isCtxStale(ctx)) {
				ctx.ui.notify(`该卡片 FSRS 数据损坏，已隔离，不会重复出现。原始数据已保留。`, "warning");
				renderGlobalCard(ctx);
			}
			scheduleTimer(0);
			return true;
		}
		let applied = false;
		let hasImmediateNext = false;
		try {
			db.exec("BEGIN IMMEDIATE");
			const cur = getRuntimeState(db);
			if (
				cur.active_item_id === item.id &&
				cur.active_version === expectedVersion &&
				cur.active_direction === expectedDirection &&
				(!attempt || item.type !== "sentence" || (
					cur.active_review_cycle_id === attempt.reviewCycleId &&
					cur.active_exercise_id === attempt.exerciseId
				))
			) {
				const undo = !attempt ? beginStudyUndo(db, item.id, rating === Rating.Again ? "again" : rating === Rating.Easy ? "easy" : "good") : undefined;
				if (item.type === "sentence" && rating === Rating.Again) {
					db.prepare("UPDATE items SET progress = 0 WHERE id = ?").run(item.id);
				}
				if (attempt) {
					if (item.type !== "sentence") ensureRecallExercise(item);
					insertEvaluatedAttempt(db, attempt, effective === Rating.Good ? "good" : effective === Rating.Hard ? "hard" : "again", now);
				} else if (item.type === "sentence" && cur.active_review_cycle_id) {
					const linked = db.prepare(
						"UPDATE attempts SET explicit_rating = 'again', rated_at = ? WHERE id = (SELECT id FROM attempts WHERE review_cycle_id = ? AND explicit_rating IS NULL ORDER BY completed_at DESC, id DESC LIMIT 1)",
					).run(now.toISOString(), cur.active_review_cycle_id);
					if (Number(linked.changes) === 0) {
						const selfReportExercise = sentenceExercise(item);
						db.prepare(
							"INSERT INTO attempts (id, item_id, exercise_id, review_cycle_id, claim_key, question_version, evaluation_version, kind, direction, assistance_level, status, explicit_rating, started_at, completed_at, rated_at, question_text) VALUES (?, ?, ?, ?, ?, ?, ?, 'sentence_self_report', 'forward', ?, 'self_report', 'again', ?, ?, ?, ?)",
						).run(
							randomUUID(), item.id, cur.active_exercise_id, cur.active_review_cycle_id,
							"sentence_self_report:" + cur.active_review_cycle_id + ":" + expectedVersion,
							expectedVersion, expectedVersion, cur.active_assistance_level,
							now.toISOString(), now.toISOString(), now.toISOString(),
							selfReportExercise ? sentenceQuestionText(selfReportExercise) : null,
						);
					}
				} else if (item.type !== "sentence") {
					// Manual word/phrase self-report: recorded separately (kind=recall_self_report)
					// with the conservatively applied rating; never objective evidence.
					db.prepare(
						"INSERT INTO attempts (id, item_id, exercise_id, review_cycle_id, claim_key, question_version, evaluation_version, kind, direction, assistance_level, status, explicit_rating, started_at, completed_at, rated_at, question_text) VALUES (?, ?, NULL, ?, ?, ?, ?, 'recall_self_report', ?, ?, 'self_report', ?, ?, ?, ?, ?)",
					).run(
						randomUUID(), item.id, randomUUID(), `recall_self_report:${item.id}:${expectedVersion}`,
						expectedVersion, expectedVersion, expectedDirection, assistanceLevel,
						effective === Rating.Again ? "again" : effective === Rating.Hard ? "hard" : effective === Rating.Easy ? "easy" : "good",
						now.toISOString(), now.toISOString(), now.toISOString(),
						recallQuestionText(item, expectedDirection, activeForwardCue(item, expectedDirection)),
					);
				}
				const objectiveCorrect = attempt != null && attempt.verdict === "correct";
				if (isRecall) {
					if (usesDirection) {
						const recognitionCovered = expectedDirection === "forward" &&
							objectiveCorrect && assistanceLevel === "none" && effective === Rating.Good;
						advanceReviewDirectional(
							db,
							item.id,
							expectedDirection,
							next.state,
							next.due,
							item.reviews + 1,
							now,
							recognitionCovered
								? { siblingDueFloor: recognitionDueFloorAfterProduction(now, next.due) }
								: undefined,
						);
					} else {
						advanceReview(db, item.id, next.state, next.due, item.reviews + 1);
					}
				} else {
					advanceReview(db, item.id, next.state, next.due, item.reviews + 1);
				}
				// Mastery evidence follows the objective verdict, not the scheduled rating:
				// a hint-assisted correct stays assisted evidence even when scheduled Hard;
				// manual self-reports are not objective evidence at all.
				const m = db.prepare("SELECT stage, unassisted_good, assisted_good, consecutive_again FROM mastery_state WHERE item_id = ?").get(item.id) as { stage: string; unassisted_good: number; assisted_good: number; consecutive_again: number } | undefined;
				const prevStage = m?.stage ?? "exposure";
				const assisted = assistanceLevel !== "none";
				const newGood = effective === Rating.Again
					? 0
					: Number(m?.unassisted_good ?? 0) + (objectiveCorrect && !assisted ? 1 : 0);
				// Assisted evidence counts hint-level only; answering after a reveal is not recall.
				const newAssistedGood = Number(m?.assisted_good ?? 0) + (objectiveCorrect && assistanceLevel === "hint" ? 1 : 0);
				const newAgain = effective === Rating.Again
					? Number(m?.consecutive_again ?? 0) + 1
					: effective === Rating.Good || effective === Rating.Easy ? 0 : Number(m?.consecutive_again ?? 0);
				const stage = effective === Rating.Again
					? computeMasteryStage(prevStage, newGood, true)
					: objectiveCorrect && !assisted
						? computeMasteryStage(prevStage, newGood, false)
						: prevStage;
				const exerciseKind = attempt?.kind ?? (item.type === "sentence" ? "sentence_self_report" : "recall");
				if (m) {
					db.prepare("UPDATE mastery_state SET stage = ?, unassisted_good = ?, assisted_good = ?, consecutive_again = ?, last_exercise_kind = ?, updated_at = ? WHERE item_id = ?")
						.run(stage, newGood, newAssistedGood, newAgain, exerciseKind, now.toISOString(), item.id);
				} else {
					db.prepare("INSERT INTO mastery_state (item_id, stage, unassisted_good, assisted_good, consecutive_again, last_exercise_kind, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
						.run(item.id, stage, newGood, newAssistedGood, newAgain, exerciseKind, now.toISOString());
				}
				bumpStat(db, "total_reviews", 1);
				touchStreak(db, now);
				// A queued weekly-challenge / /anki:add card counts as the immediate next
				// card too: otherwise active study starves the FIFO queue behind the pacing interval.
				hasImmediateNext = hasReadyStoredCard(now) || hasReleasableQueueCard(now);
				// A review due seconds from now must not wait a full pacing interval:
				// cap the fallback check at the earliest upcoming review due time,
				// excluding this card's own deliberate automatic-interval re-test.
				const pacedCheck = new Date(now.getTime() + intervalMs()).toISOString();
				const upcomingDue = earliestUpcomingReviewDue(db, now, item.id);
				const nextCheck = hasImmediateNext
					? now.toISOString()
					: upcomingDue !== null && upcomingDue < pacedCheck ? upcomingDue : pacedCheck;
				setRuntimeState(db, {
					active_item_id: null,
					active_kind: null,
					active_direction: "forward",
					active_version: cur.active_version + 1,
					...EMPTY_SENTENCE_CYCLE,
					next_check_at: nextCheck,
					coordinator: cur.coordinator,
					coordinator_until: cur.coordinator_until,
					last_activity: cur.last_activity,
				});
				if (undo) finishStudyUndo(db, undo);
				applied = true;
			}
			db.exec("COMMIT");
		} catch (err) {
			try {
				db.exec("ROLLBACK");
			} catch {
				/* already rolled back */
			}
			console.error(`[pi-english-anki] Rate CAS failed: ${err}`);
		} finally {
			clearPendingLocals();
		}

		if (!applied) {
			// Another session rated first; just refresh.
			renderGlobalCard(ctx);
			return true;
		}
		recordRendered(getRuntimeState(db));
		// Clean manual self-reports and reveals no longer downgrade (owner
		// decision), so the only downgrade path is hint assistance.
		const downgradeNote = effective === rating
			? ""
			: assistanceLevel === "hint" ? "（用了提示，按困难安排）"
			: "";
		if (effective === Rating.Easy) {
			updateWidget(ctx, FACES.review, [
				`${FACES.review} 太简单！下次 ${next.due.slice(0, 10)} 再见这个${TYPE_LABELS[item.type] ?? "学习项"}`,
				statsLine(db),
			]);
		} else if (effective === Rating.Good) {
			updateWidget(ctx, FACES.review, [
				...(recallNote ? [recallNote] : []),
				`${FACES.review} 记牢了！下次 ${next.due.slice(0, 10)} 再见这个${TYPE_LABELS[item.type] ?? "学习项"}`,
				statsLine(db),
			]);
		} else if (effective === Rating.Hard) {
			updateWidget(ctx, FACES.review, [
				...(recallNote ? [recallNote] : []),
				`${FACES.review} 记了个大概${downgradeNote}，下次 ${next.due.slice(0, 10)} 再见这个${TYPE_LABELS[item.type] ?? "学习项"}`,
				statsLine(db),
			]);
		} else {
			const lines = [...(recallNote ? [recallNote] : []), `${FACES.error} 没关系${downgradeNote}，待会儿再考你一次 ${item.text}`];
			const mastery = db.prepare("SELECT consecutive_again FROM mastery_state WHERE item_id = ?").get(item.id) as { consecutive_again: number } | undefined;
			if (Number(mastery?.consecutive_again ?? 0) >= 2) {
				lines.push(`💪 反复忘了，仔细看：${item.example || item.text}${item.example_cn ? `（${item.example_cn}）` : ""}`);
			}
			lines.push(statsLine(db));
			updateWidget(ctx, FACES.error, lines);
		}
		// User-driven study advances stored inventory independently of automatic
		// generation timers and replacement work. claimDueItem keeps due/quota rules.
		const queued = hasImmediateNext ? claimDueItem(new Date()) : undefined;
		if (queued) {
			stopTimer();
			showItem(ctx, queued);
		} else if (hasImmediateNext && activeItem(db)) {
			// Another runtime won the next-card claim after our rating committed.
			renderGlobalCard(ctx);
		} else if (hasImmediateNext) {
			// No stored card claimable: the custom queue (weekly challenge or
			// /anki:add cards) is the immediate next card. Release it now instead
			// of starving it behind the pacing interval; a lost race falls back to
			// an immediate tick so the normal petTick ordering still applies.
			stopTimer();
			if (!releaseCustomQueue(ctx, new Date())) scheduleTimer(0);
		} else {
			scheduleTimer(intervalMs());
		}
		return true;
	}

	/**
	 * Screening sweep rating: only a written answer that exactly matches the
	 * card's target (code-level exact match, not the LLM semantic verdict)
	 * marks the card known — a paraphrase means the learner knows the concept,
	 * not the target word itself. A manual Good (no answer) or any mismatch
	 * changes nothing: no attempt, no FSRS step, the card keeps its old
	 * schedule. Either way the next sweep card shows immediately.
	 */
	function rateScreening(
		ctx: ExtensionContext,
		item: ItemRow,
		rating: Rating,
		assistanceLevel: AssistanceLevel,
		expectedVersion: number,
		expectedDirection: RecallDirection,
		recallNote: string,
		attempt?: PendingAttempt,
	): boolean {
		if (!db) return false;
		screeningSwept.add(item.id);
		const now = new Date();
		const effective = effectiveRecallRating({ rating, assistance: assistanceLevel, manual: !attempt });
		const minDue = new Date(now.getTime() + 365 * 24 * 3600 * 1000).toISOString();
		let known: { direction: RecallDirection; state: string; due: string }[] | undefined;
		if (effective !== Rating.Again && assistanceLevel === "none" && attempt?.exact === true) {
			const directions = item.type === "cloze" ? ["forward"] as const : ["forward", "reverse"] as const;
			known = [];
			for (const direction of directions) {
				const raw = item.type === "cloze" ? item.fsrs_state : directionFsrsState(db, item.id, direction) ?? (item.fsrs_state || null);
				const st = scheduleNext(raw, now, Rating.Easy);
				if ("corrupt" in st) { known = undefined; break; }
				known.push({ direction, state: st.state, due: st.due < minDue ? minDue : st.due });
			}
		}
		let applied = false;
		try {
			db.exec("BEGIN IMMEDIATE");
			const cur = getRuntimeState(db);
			if (cur.active_item_id === item.id && cur.active_version === expectedVersion && cur.active_direction === expectedDirection) {
				if (known) {
					if (attempt) {
						ensureRecallExercise(item);
						insertEvaluatedAttempt(db, attempt, "good", now);
					}
					if (item.type === "cloze") {
						db.prepare("UPDATE items SET status = 'mastered', fsrs_state = ?, due_at = ?, reviews = ? WHERE id = ?")
							.run(known[0].state, known[0].due, item.reviews + 1, item.id);
					} else {
						for (const d of known) advanceReviewDirectional(db, item.id, d.direction, d.state, d.due, item.reviews + 1, now);
						db.prepare("UPDATE items SET status = 'mastered' WHERE id = ?").run(item.id);
					}
					bumpStat(db, "total_screened", 1);
					bumpStat(db, "total_learned", 1);
					bumpStat(db, "total_skipped", 1);
					if (readScreeningCard()?.itemId === item.id) writeScreeningCard();
				} else {
					recordScreeningMiss(item.id);
					revertScreeningPresentation(item.id);
				}
				setRuntimeState(db, {
					active_item_id: null,
					active_kind: null,
					active_direction: "forward",
					active_version: cur.active_version + 1,
					...EMPTY_SENTENCE_CYCLE,
					next_check_at: now.toISOString(),
				});
				applied = true;
			}
			db.exec("COMMIT");
		} catch (err) {
			try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
			console.error(`[pi-english-anki] Screening rate failed: ${err}`);
		} finally {
			clearPendingLocals();
		}
		if (!applied) {
			renderGlobalCard(ctx);
			return true;
		}
		recordRendered(getRuntimeState(db));
		const lines = known
			? [...(recallNote ? [recallNote] : []), `${FACES.party} 已会：${item.text}，一年后再见`]
			: [...(recallNote ? [recallNote] : []), `${FACES.review} 没关系，${item.text} 以后不再进筛查，留给正常学习`];
		lines.push(statsLine(db));
		updateWidget(ctx, known ? FACES.party : FACES.review, lines);
		// The app settles an answer on a new attempt or a notify; a miss writes no
		// attempt, so it must notify or the app waits out its answer timeout.
		if (known) ctx.ui.notify(`筛查通过：${item.text} 已会，一年后再见`, "info");
		else ctx.ui.notify(`筛查未通过：${item.text}${recallNote ? `（${recallNote}）` : ""}，答案须与卡面完全一致，以后不再进筛查，留给正常学习`, "info");
		stopTimer();
		const nextCard = claimDueItem(new Date());
		if (nextCard) {
			if (!showItem(ctx, nextCard)) renderGlobalCard(ctx);
		} else if (activeItem(db)) {
			renderGlobalCard(ctx);
		} else {
			ctx.ui.notify("本轮筛查已扫完所有未学过的卡", "info");
			scheduleTimer();
		}
		return true;
	}

	/** Atomically mark the pending card as well-known and enqueue its replacement. */
	function skipPending(ctx: ExtensionContext): { item: ItemRow; actionId: string } | undefined {
		hydratePending(ctx);
		if (pendingItemId == null || !db) return undefined;
		const item = db.prepare("SELECT * FROM items WHERE id = ?").get(pendingItemId) as ItemRow | undefined;
		if (!item) return undefined;
		const now = new Date();
		const minDue = new Date(now.getTime() + 365 * 24 * 3600 * 1000).toISOString();
		// Skip claims the whole word is known: push out BOTH directions (P0-1).
		// Cloze has a single direction, so it skips like a sentence card.
		const usesDirection = item.type === "word" || item.type === "phrase";
		const perDirection: { direction: "forward" | "reverse"; state: string; due: string }[] = [];
		let singleNext: { state: string; due: string } | undefined;
		if (usesDirection) {
			for (const dir of ["forward", "reverse"] as const) {
				const raw = directionFsrsState(db, item.id, dir) ?? (item.fsrs_state || null);
				const st = scheduleNext(raw, now, Rating.Easy);
				if ("corrupt" in st) {
					quarantineCorruptFsrs(db, item.id, raw ?? "", st.error, now);
					clearPendingLocals();
					ctx.ui.notify(`该卡片 FSRS 数据损坏，已隔离。`, "warning");
					renderGlobalCard(ctx);
					return undefined;
				}
				perDirection.push({ direction: dir, state: st.state, due: st.due < minDue ? minDue : st.due });
			}
		} else {
			const next = scheduleNext(item.fsrs_state, now, Rating.Easy);
			if ("corrupt" in next) {
				quarantineCorruptFsrs(db, item.id, item.fsrs_state, next.error, now);
				clearPendingLocals();
				ctx.ui.notify(`该卡片 FSRS 数据损坏，已隔离。`, "warning");
				renderGlobalCard(ctx);
				return undefined;
			}
			singleNext = { state: next.state, due: next.due < minDue ? minDue : next.due };
		}
		let applied = false;
		let actionId = "";
		try {
			db.exec("BEGIN IMMEDIATE");
			const cur = getRuntimeState(db);
			if (cur.active_item_id !== item.id || cur.active_version !== localVersion) {
				db.exec("ROLLBACK");
				renderGlobalCard(ctx);
				clearPendingLocals();
				return undefined;
			}
			const undo = beginStudyUndo(db, item.id, "skip");
			actionId = undo.record.actionId;
			if (usesDirection) {
				for (const d of perDirection) advanceReviewDirectional(db, item.id, d.direction, d.state, d.due, item.reviews + 1, now);
				db.prepare("UPDATE items SET status = 'mastered' WHERE id = ?").run(item.id);
			} else {
				db.prepare("UPDATE items SET status = 'mastered', fsrs_state = ?, due_at = ? WHERE id = ?").run(
					singleNext!.state,
					singleNext!.due,
					item.id,
				);
			}
			bumpStat(db, "total_skipped", 1);
			// Terminal-teach mode: a mastered skip generates no replacement card;
			// new cards come only from explicit /anki:insert.
			if (config.autoTeach) enqueueReplacement(db, item.type);
			// Give this instance a short grace to generate the replacement without
			// another session surfacing a card in between.
			setRuntimeState(db, {
				active_item_id: null,
				active_kind: null,
				active_direction: "forward",
				active_version: cur.active_version + 1,
				...EMPTY_SENTENCE_CYCLE,
				// Reviews always win: the grace never outruns an imminent due card.
				next_check_at: new Date(now.getTime() + Math.min(REPLACEMENT_GRACE_MS, earliestDueDelay())).toISOString(),
				coordinator: myId,
				coordinator_until: new Date(now.getTime() + leaseMs()).toISOString(),
				last_activity: now.toISOString(),
			});
			finishStudyUndo(db, undo);
			applied = true;
			db.exec("COMMIT");
		} catch (err) {
			try {
				db.exec("ROLLBACK");
			} catch {
				/* already rolled back */
			}
			throw err;
		}

		clearPendingLocals();
		if (applied) {
			recordRendered(getRuntimeState(db));
			updateWidget(ctx, FACES.party, [
				`${FACES.party} 好，${item.text} 记作很熟的内容，正在补充同类型卡片…`,
				statsLine(db),
			]);
			return { item, actionId };
		}
		return undefined;
	}

	async function generateReplacementAndInsert(
		ctx: ExtensionContext,
		requestedType: GeneratedItem["type"],
		skippedItem?: ItemRow,
	): Promise<boolean> {
		if (!db) return false;
		const updateReplacementWidget: typeof updateWidget = (...args) => {
			if (db && activeItem(db)) renderGlobalCard(ctx);
			else updateWidget(...args);
		};
		// Legacy sentence skips are fulfilled with cloze cards now.
		const type: GeneratedItem["type"] = requestedType === "sentence" ? "cloze" : requestedType;
		if (type !== requestedType) logGenStatus("replacement_mapped: sentence→cloze");
		let skipped = skippedItem ?? latestMasteredItem(db, requestedType);
		if (skipped && skipped.type === "sentence" && type === "cloze") skipped = { ...skipped, type: "cloze" };
		if (!skipped) {
			updateReplacementWidget(ctx, FACES.error, ["待补卡片缺少来源记录，请保留队列并稍后重试。", statsLine(db)]);
			logGenStatus("replacement_no_source");
			return false;
		}
		// Conversation-less sessions (e.g. the standalone app's RPC session) must
		// still drain the replacement FIFO: the generator prompt already has an
		// IELTS-entry fallback branch for exactly this case. Only bail when neither
		// a conversation nor a skipped item anchor exists to steer generation.
		const branchSnapshot = buildConversation(ctx.sessionManager.getBranch());
		const conversation = branchSnapshot
			|| (skipped ? `（本会话暂无英语内容：请从雅思入门/基础段高频核心词中选 ${skipped.type} 卡，向 A1-A2 超级初学者倾斜）` : "");
		// Guards below must compare against the branch snapshot, not the effective
		// conversation (which may be the conversation-less fallback line): a real
		// branch change invalidates in-flight generation, an unchanged empty branch
		// must not.
		const conversationUnchanged = () => buildConversation(ctx.sessionManager.getBranch()) === branchSnapshot;
		if (!conversation.trim()) {
			updateReplacementWidget(ctx, FACES.idle, ["等会话形成明确话题后，再补充同类型卡片…", statsLine(db)]);
			logGenStatus("replacement_empty_conversation");
			return false;
		}
		const rejectionKey = `${type}\n${conversation}`;
		if (rejectionKey === lastRejectedReplacementKey && Date.now() < replacementRetryAt) {
			updateReplacementWidget(ctx, FACES.idle, ["还在等待足够信息，以补充同类型卡片…", statsLine(db)]);
			logGenStatus("replacement_cached_rejection");
			return false;
		}
		const generationToken = claimGeneration();
		if (!generationToken) { logGenStatus("replacement_no_gen_token"); return false; }
		bindUndoReplacement(db, skipped.id, generationToken);

		// One profile+budget snapshot per generation, after the generation claim and
		// before any LLM await; the same snapshot feeds the generator, fallback,
		// and critic so adaptive decisions stay consistent within this attempt.
		const adaptive: AdaptiveContext = (() => {
			const profile = computeLearnerProfile(db, new Date());
			return { profile, budget: deriveBudget(profile) };
		})();
		const replacementRecentLog = formatAttemptLogBlock(recentAttemptLog(db));

		const generation = sessionGeneration;
		pendingLLMCall = true;
		pendingLLMCallAt = Date.now();
		updateReplacementWidget(ctx, FACES.teach, ["正在补充同类型卡片，喵…"]);
		try {
			let effectiveResolved = resolveModel(ctx);
			if (!effectiveResolved) throw new Error("NO_MODEL");
			let decision: ReplacementDecision;
			try {
				decision = await generateReplacement(llm, ctx, effectiveResolved, conversation, replacementKnownList(db), config, skipped, adaptive, replacementRecentLog);
			} catch (err) {
				if (!effectiveResolved.fromSession && ctx.model &&
					(ctx.model.provider !== effectiveResolved.provider || ctx.model.id !== effectiveResolved.model)) {
					if (sessionGeneration !== generation || !db) return false;
					effectiveResolved = { provider: ctx.model.provider, model: ctx.model.id, fromSession: true };
					decision = await generateReplacement(
						llm,
						ctx,
						effectiveResolved,
						conversation,
						replacementKnownList(db),
						config,
						skipped,
						adaptive,
						replacementRecentLog,
					);
				} else {
					throw err;
				}
			}
			if (sessionGeneration !== generation || !db) return false;
			if (!conversationUnchanged()) return false;
			if (!ownsGeneration(getRuntimeState(db), generationToken)) return false;
			if (!decision.ready) {
				lastRejectedReplacementKey = rejectionKey;
				replacementRetryAt = Date.now() + REPLACEMENT_RETRY_MS;
				updateReplacementWidget(ctx, FACES.idle, ["还在等待足够信息，以补充同类型卡片…", statsLine(db)]);
				logGenStatus(`replacement_not_ready: ${decision.reason || ""}`);
				if (config.verbose && decision.reason) ctx.ui.notify(`暂不补卡：${decision.reason}`, "info");
				return false;
			}

			let item = decision.item;
			// Independent critic on replacement content (same fail-closed semantics as lessons).
			// composition=null: a replacement is a single card by design — judging it by the
			// 10+1 full-batch composition rule would reject every replacement as
			// "批次严重不完整" and stall the FIFO forever. Per-item checks still apply.
			let replacementVerdict = await critiqueLesson(llm, ctx, effectiveResolved, { topic: "replacement", items: [item] }, db ? knownList(db) : [], config, adaptive, null);
			if (sessionGeneration !== generation || !db) return false;
			if (!conversationUnchanged()) return false;
			if (!ownsGeneration(getRuntimeState(db), generationToken)) return false;
			// Basic-vocabulary fallback on a genuine rejection: one last easiest-word
			// replacement (already-known words are skippable). An unavailable critic
			// stays fail-closed.
			if (!replacementVerdict.pass && replacementVerdict.available) {
				try {
					const basic = await generateReplacement(llm, ctx, effectiveResolved, conversation, replacementKnownList(db), config, skipped, adaptive, replacementRecentLog, true);
					if (sessionGeneration !== generation || !db) return false;
					if (!conversationUnchanged()) return false;
					if (!ownsGeneration(getRuntimeState(db), generationToken)) return false;
					if (basic.ready) {
						const basicVerdict = await critiqueLesson(llm, ctx, effectiveResolved, { topic: "replacement", items: [basic.item] }, db ? knownList(db) : [], config, adaptive, null);
						if (sessionGeneration !== generation || !db) return false;
						if (!conversationUnchanged()) return false;
						if (!ownsGeneration(getRuntimeState(db), generationToken)) return false;
						if (basicVerdict.pass) {
							item = basic.item;
							replacementVerdict = basicVerdict;
							logGenStatus("replacement_basic_fallback");
						}
					}
				} catch (err) {
					logGenStatus(`replacement_basic_fallback_error: ${(err as Error)?.message || err}`);
				}
			}
			if (!replacementVerdict.pass) {
				if (replacementVerdict.available) lastRejectedReplacementKey = rejectionKey;
				replacementRetryAt = Date.now() + REPLACEMENT_RETRY_MS;
				updateReplacementWidget(ctx, FACES.idle, [
					replacementVerdict.available ? "补充卡内容质量未达标，保留队列稍后再试…" : "补充卡审查暂时不可用，保留队列稍后重试…",
					statsLine(db),
				]);
				logGenStatus(`${replacementVerdict.available ? "replacement_critic_rejected" : "replacement_critic_unavailable"}: ${replacementVerdict.summary || ""}`);
				if (config.verbose) ctx.ui.notify(`补充卡被审查拒绝：${replacementVerdict.summary}`, "info");
				return false;
			}

			const now = new Date();
			let inserted: ItemRow | undefined;
			let duplicate = false;
			db.exec("BEGIN IMMEDIATE");
			try {
				const state = getRuntimeState(db);
				const dueReview = db.prepare(`SELECT 1 FROM items WHERE due_at <= ? AND shown = 1 ${SCHEDULABLE} LIMIT 1`).get(now.toISOString());
				if (!ownsGeneration(state, generationToken, now) || pendingReplacementTypes(db)[0] !== requestedType) {
					db.exec("ROLLBACK");
					logGenStatus("replacement_insert_deferred");
					return false;
				}
				const dupFp = contentFingerprint(item.type, item.text, item.meaning);
				const dup = db.prepare("SELECT 1 FROM items WHERE content_fingerprint = ?").get(dupFp);
				if (dup) {
					duplicate = true;
					db.exec("ROLLBACK");
				} else {
					const id = insertItem(db, item.type, item.text, item.phonetic || null, item.meaning, item.example || null, item.example_cn || null, now, {
						levels: item.levels,
						levels_cn: item.levels_cn,
						chunks: item.chunks,
						keyWords: item.keyWords,
						introductionKind: "replacement",
					});
					const activate = state.active_item_id == null && !dueReview;
					if (activate) {
						bumpStat(db, "total_learned", 1);
						touchStreak(db, now);
						markShown(db, id);
						db.prepare("UPDATE items SET introduced_at = ? WHERE id = ?").run(now.toISOString(), id);
						setRuntimeState(db, {
							active_item_id: id,
							active_kind: "teach",
							active_direction: "forward",
							active_version: state.active_version + 1,
							...EMPTY_SENTENCE_CYCLE,
							next_check_at: now.toISOString(),
							generation_token: null,
							generation_until: null,
					});
					}
					if (!consumeReplacement(db, requestedType)) throw new Error("REPLACEMENT_QUEUE_MISMATCH");
					inserted = db.prepare("SELECT * FROM items WHERE id = ?").get(id) as ItemRow | undefined;
					if (!inserted) throw new Error("REPLACEMENT_INSERT_FAILED");
					db.exec("COMMIT");
				}
			} catch (err) {
				try { db.exec("ROLLBACK"); } catch { /* no transaction */ }
				throw err;
			}
			if (duplicate) {
				lastRejectedReplacementKey = rejectionKey;
				replacementRetryAt = Date.now() + REPLACEMENT_RETRY_MS;
				updateReplacementWidget(ctx, FACES.idle, ["模型给出了重复内容，等话题变化后再补卡…", statsLine(db)]);
				logGenStatus("replacement_duplicate");
				return false;
			}
			lastRejectedReplacementKey = "";
			if (!inserted) return false;
			logGenStatus(`replacement_ok: ${type} ${item.text}`);
			replacementRetryAt = 0;
			// A worker may have deferred while this direct skip call was in flight.
			// Cancel that busy retry so remaining inventory resumes immediately.
			stopReplacementTimer();
			if (getRuntimeState(db).active_item_id === inserted.id) showItem(ctx, inserted);
			else if (getRuntimeState(db).active_item_id != null) renderGlobalCard(ctx);
			else {
				// Successful refill clears a prior failed-teach pacing delay on an empty screen.
				resetPacing(db);
				const due = claimDueItem(new Date(), true);
				if (due) showItem(ctx, due);
			}
			if (config.verbose) ctx.ui.notify(`已补充一张${TYPE_LABELS[type]}卡`, "info");
			return true;
		} catch (err) {
			if (sessionGeneration !== generation) return false;
			const msg = (err as Error)?.message || String(err);
			lastError = String((err as Error & { code?: string }).code || msg).slice(0, 80);
			if (db && !isCtxStale(ctx)) updateReplacementWidget(ctx, FACES.error, [`补卡失败：${lastError}`, statsLine(db)]);
			replacementRetryAt = Date.now() + REPLACEMENT_RETRY_MS;
			logGenStatus(`replacement_error: ${lastError}`);
			return false;
		} finally {
			if (db) releaseGeneration(generationToken);
			if (sessionGeneration === generation) {
				pendingLLMCall = false;
				pendingLLMCallAt = 0;
				drainTeachQueue();
				scheduleReplacementWork();
			}
		}
	}

	/**
	 * Release queued /anki:add cards into items, FIFO, consuming today's
	 * remaining new-card quota (0 = unlimited). The first released card is
	 * activated immediately; the rest wait in items as first-display cards.
	 * Pure DB work: no generation token, no LLM call.
	 */
	function releaseCustomQueue(ctx: ExtensionContext, now: Date): boolean {
		if (!db) return false;
		if (customQueueCount(db) === 0) return false;
		let released: ItemRow | undefined;
		try {
			db.exec("BEGIN IMMEDIATE");
			const state = getRuntimeState(db);
			if (
				state.active_item_id != null ||
				!pacingReady(state, now) ||
				pendingReplacementTypes(db).length > 0
			) {
				db.exec("ROLLBACK");
				return false;
			}
			const plan = loadPlan(db, now);
			const introduced = countTodayNew(db, now);
			if (!hasNewCardCapacity(plan, introduced)) {
				db.exec("ROLLBACK");
				return false;
			}
			const remaining = remainingNewCardSlots(plan, introduced, customQueueCount(db));
			// Word/phrase rows go easiest level first (studyOrder); cloze/sentence rows keep the
			// front in FIFO order; unparsable rows sort last.
			const orderOf = (row: CustomQueueRow) => {
				try {
					const payload = JSON.parse(row.payload);
					return payload.type === "word" || payload.type === "phrase" ? studyOrder(String(payload.text ?? "")) : -1;
				} catch { return Infinity; }
			};
			const rows = listCustomQueue(db)
				.map((row) => ({ row, order: orderOf(row) }))
				.sort((a, b) => a.order - b.order || a.row.id - b.row.id)
				.slice(0, remaining)
				.map(({ row }) => row);
			if (rows.length === 0) {
				db.exec("ROLLBACK");
				return false;
			}
			const removed: number[] = [];
			let firstId: number | undefined;
			let firstType: string | undefined;
			for (const row of rows) {
				removed.push(row.id);
				// A queued card may collide with a card the normal lesson flow added
				// after enqueue: drop the row instead of violating the unique fingerprint.
				if (db.prepare("SELECT 1 FROM items WHERE content_fingerprint = ?").get(row.fingerprint)) continue;
				// Re-validate the staged payload: a corrupt or malformed row is dropped
				// on the same path as a collision (the row is still removed below).
				const item = (() => {
					try { return parseGeneratedItem(JSON.parse(row.payload)); } catch { return undefined; }
				})();
				if (!item) continue;
				const id = insertItem(db, item.type, item.text, item.phonetic || null, item.meaning, item.example || null, item.example_cn || null, now, {
					levels: item.levels,
					levels_cn: item.levels_cn,
					chunks: item.chunks,
					keyWords: item.keyWords,
					animation: item.animation,
					introductionKind: "custom",
				});
				if (firstId == null) {
					firstId = id;
					firstType = item.type;
				}
			}
			removeCustomQueueRows(db, removed);
			if (firstId == null) {
				// Everything queued already exists in the deck: nothing released.
				db.exec("COMMIT");
				return false;
			}
			markShown(db, firstId);
			db.prepare("UPDATE items SET introduced_at = ? WHERE id = ?").run(now.toISOString(), firstId);
			bumpStat(db, "total_learned", 1);
			touchStreak(db, now);
			setRuntimeState(db, {
				active_item_id: firstId,
				// Cloze cards quiz from the very first showing (see claimDueItem).
				active_kind: firstType === "cloze" ? "review" : "teach",
				active_direction: "forward",
				active_version: state.active_version + 1,
				...EMPTY_SENTENCE_CYCLE,
				next_check_at: now.toISOString(),
			});
			released = db.prepare("SELECT * FROM items WHERE id = ?").get(firstId) as unknown as ItemRow | undefined;
			db.exec("COMMIT");
		} catch (err) {
			try { db.exec("ROLLBACK"); } catch { /* no transaction */ }
			console.error(`[pi-english-anki] Custom queue release failed: ${err}`);
			return false;
		}
		if (released) {
			if (!showItem(ctx, released)) renderGlobalCard(ctx);
		}
		return true;
	}

	async function petTick(ctx: ExtensionContext) {
		const generation = sessionGeneration;
		if (isCtxStale(ctx)) return;
		if (!db) return;
		releaseStaleScreeningCard();
		const now = new Date();
		const state0 = getRuntimeState(db);
		// A global card is active: render it and never swap it for another.
		if (state0.active_item_id != null) {
			renderGlobalCard(ctx);
			return;
		}

		// Respect the global pacing window so one session's rating cannot let
		// another session surface a different card ahead of the interval.
		if (!screeningActive() && !pacingReady(state0, now)) {
			updateWidget(ctx, FACES.idle, [statsLine(db)]);
			return;
		}

		// Stored cards first: claiming is pure DB work and never waits on the LLM.
		// Reviews win, then planned inventory, then queued replacements at the back.
		const due = claimDueItem(new Date());
		if (due) {
			if (!showItem(ctx, due)) renderGlobalCard(ctx);
			return;
		}
		if (getRuntimeState(db).active_item_id != null) {
			renderGlobalCard(ctx);
			return;
		}
		// A finished sweep round waits for the learner to exit screening.
		if (screeningActive()) {
			updateWidget(ctx, FACES.idle, [statsLine(db)]);
			return;
		}

		// A skipped card's replacement generates in the background and joins the
		// back of the new-card queue; the FIFO obligation blocks fresh lessons.
		const replacementType = pendingReplacementTypes(db)[0];
		if (replacementType) {
			const inserted = await generateReplacementAndInsert(ctx, replacementType);
			if (inserted) return;
			if (sessionGeneration !== generation || !db) return;
			const state = getRuntimeState(db);
			const generationBusy = Boolean(
				state.generation_token && state.generation_until &&
				Date.now() < new Date(state.generation_until).getTime()
			);
			if (generationBusy) {
				updateWidget(ctx, FACES.idle, [statsLine(db)]);
				return;
			}
			// Generation is waiting for better context; keep the FIFO obligation but
			// the pacing reset may unblock a stored card that was pacing-gated.
			resetPacing(db);
			const afterGeneration = claimDueItem(new Date());
			if (afterGeneration) {
				if (!showItem(ctx, afterGeneration)) renderGlobalCard(ctx);
			}
			return;
		}

		// 2. Queued /anki:add cards claim the day's remaining new-card quota FIFO,
		// ahead of fresh lesson generation (pure DB work, no LLM).
		if (releaseCustomQueue(ctx, now)) return;

		// 3. Otherwise teach new items (LLM), using today's automatic or fixed quota.
		const plan = loadPlan(db, now);
		const introduced = countTodayNew(db, now);
		if (config.autoTeach && hasNewCardCapacity(plan, introduced)) {
			if (pendingLLMCall && !resetHungLlmCall()) return;
			// Queued manual topics take priority over a fresh automatic lesson.
			if (teachQueue.length > 0) {
				drainTeachQueue();
				return;
			}
			let batch = nextAdaptiveLessonBatch(db, now, plan);
			if (!plan.adaptive) {
				const slots = remainingNewCardSlots(
					plan,
					introduced,
					LESSON_WORD_ITEMS + LESSON_CLOZE_ITEMS,
				);
				batch = {
					wordItems: Math.min(LESSON_WORD_ITEMS, slots),
					clozeItems: slots >= LESSON_WORD_ITEMS + LESSON_CLOZE_ITEMS ? LESSON_CLOZE_ITEMS : 0,
				};
			}
			if (batch && batch.wordItems > 0) await generateAndInsert(ctx, now, batch);
			return;
		}

			// 4. Nothing to do: the pet dozes off
		if (db) {
			updateWidget(ctx, FACES.idle, [statsLine(db)]);
			// Idle trickle: resolve one unchecked card image per tick so new cards
			// pick up concept pictures without any per-insert wiring.
			await backfillCardImages(db, { limit: 1 });
		}
	}

	function logGenStatus(status: string) {
		if (!db) return;
		setStat(db, "last_gen_status", status.slice(0, 200));
		// Progress markers are not decisions; the ring log records outcomes only.
		if (!status.startsWith("model:")) appendGenLog(db, status);
	}
	function deferPacing() {
		// Generation backoff must not gate claims past an imminent review due.
		if (db) setRuntimeState(db, { next_check_at: new Date(Date.now() + Math.min(Math.max(1, config.intervalMinutes) * 60_000, earliestDueDelay())).toISOString() });
	}

	/** Milliseconds until the earliest strictly-future review due time, or
	 * Infinity. Reviews are never quota-blocked, so every pacing write and free
	 * timer delay is capped by it: unblocking later than a due card hides it
	 * behind a full interval. */
	function earliestDueDelay(): number {
		if (!db) return Number.POSITIVE_INFINITY;
		const due = earliestUpcomingReviewDue(db, new Date());
		return due ? Math.max(0, Date.parse(due) - Date.now()) : Number.POSITIVE_INFINITY;
	}

	async function generateAndInsert(ctx: ExtensionContext, _now: Date, batch?: LessonBatch, background = false, strategy: AutoRefillStrategy = "reserve") {
		const conversationSnapshot = buildConversation(ctx.sessionManager.getBranch());
		// RPC sessions (the IELTS app) have no chat to mine for topics; fall back
		// to the IELTS basic line so the adaptive daily plan still fills on ticks.
		const emptyFallback = !conversationSnapshot.trim() && ctx.mode === "rpc"
			? "雅思基础词汇（A1-A2，超级初学者）"
			: "";
		const request = background ? undefined : manualTeachRequest;
		const conversation = request?.topic || conversationSnapshot || emptyFallback;
		const isManual = request != null;
		if (isManual) batch = { wordItems: 5, clozeItems: 0 };
		const usedFallback = !isManual && emptyFallback !== "";
		if (!background) manualTeachRequest = undefined;
		const conversationUnchanged = () => isManual || buildConversation(ctx.sessionManager.getBranch()) === conversationSnapshot;
		if (!conversation.trim()) {
			if (db && (!background || !activeItem(db))) updateWidget(ctx, FACES.idle, [statsLine(db)]);
			logGenStatus("empty_conversation");
			if (!isManual && !background) deferPacing();
			return;
		}
		if (!isManual && !usedFallback && conversation === lastRejectedConversation) {
			if (db && (!background || !activeItem(db))) updateWidget(ctx, FACES.idle, ["还在观察话题，等信息更完整些…", statsLine(db)]);
			logGenStatus("cached_rejection");
			if (!isManual && !background) deferPacing();
			return;
		}
		const generationToken = claimGeneration(new Date(), isManual);
		if (!generationToken) {
			// Another process holds the lease: keep the manual request queued
			// instead of dropping it; the next tick or lease release retries it.
			if (isManual) {
				teachQueue.unshift(request!);
				teachProgress(request, "queued");
				if (!request?.requestId && !isCtxStale(ctx)) ctx.ui.notify(`已排队：另一轮生成仍在进行，结束后自动开始「${conversation}」`, "info");
			}
			logGenStatus("no_gen_token");
			return;
		}


		const generation = sessionGeneration;
		let saved = false;
		let failureCode = "TEACH_CANCELLED";
		if (request) manualWork = { request, token: generationToken, startedAt: Date.now() };
		pendingLLMCall = true;
		pendingLLMCallAt = Date.now();
		try {
			teachProgress(request, "generating");
			if (db && !activeItem(db)) updateWidget(ctx, FACES.teach, ["备课中，喵…"]);
			// One profile+budget snapshot per generation, after the generation claim and
			// before any LLM await; the same snapshot feeds the initial generator,
			// fallback, revisions, and critic so adaptive decisions stay consistent.
			const adaptive: AdaptiveContext | null = db ? (() => {
				const profile = computeLearnerProfile(db, new Date());
				return { profile, budget: smoothBudget(db, deriveBudget(profile)) };
			})() : null;
			const recentLog = db ? formatAttemptLogBlock(recentAttemptLog(db)) : undefined;
			let effectiveResolved = resolveModel(ctx);
			if (!effectiveResolved) throw new Error("NO_MODEL");
			logGenStatus(`model:${resolvedModelName}`);
			let decision: LessonDecision;
			try {
				decision = await generateLesson(llm, ctx, effectiveResolved, conversation, db ? replacementKnownList(db) : [], config, undefined, adaptive ?? undefined, recentLog, batch, false, isManual);
			} catch (err) {
				if (sessionGeneration !== generation) return;
				if (!effectiveResolved.fromSession && ctx.model &&
					(ctx.model.provider !== effectiveResolved.provider || ctx.model.id !== effectiveResolved.model)) {
					effectiveResolved = {
						provider: ctx.model.provider,
						model: ctx.model.id,
						fromSession: true,
					};
					decision = await generateLesson(llm, ctx, effectiveResolved, conversation, db ? replacementKnownList(db) : [], config, undefined, adaptive ?? undefined, recentLog, batch, false, isManual);
					if (sessionGeneration !== generation) return;
					resolvedModelName = `${effectiveResolved.provider}/${effectiveResolved.model}（当前会话·降级）`;
				} else {
					throw err;
				}
			}
			if (sessionGeneration !== generation || !db || !conversationUnchanged()) return;
			if (!ownsGeneration(getRuntimeState(db), generationToken)) return;
			if (!decision.ready) {
				lastRejectedConversation = conversation;
				if (!background || !activeItem(db)) updateWidget(ctx, FACES.idle, ["还在观察话题，等信息更完整些…", statsLine(db)]);
				logGenStatus(`not_ready: ${decision.reason || ""}`);
				if (!isManual && !background) deferPacing();
				if (!request?.requestId && config.verbose && decision.reason) ctx.ui.notify(`暂不备课：${decision.reason}`, "info");
				return;
			}

			let lesson = decision;
			// Quality gate: an independent critic must approve the generated content.
			teachProgress(request, "checking");
			let verdict = await critiqueLesson(llm, ctx, effectiveResolved, lesson, db ? replacementKnownList(db) : [], config, adaptive ?? undefined, batch);
			if (sessionGeneration !== generation) return;
			if (!db || !ownsGeneration(getRuntimeState(db), generationToken)) return;
			// Partial acceptance: lock in the items that individually passed every gate
			// and regenerate only the shortfall with the rejection feedback. Runs before
			// the revision loop so passing items can never be lost to a full-batch
			// regeneration; a mostly-good batch must not be discarded.
			let partialAccepted: GeneratedItem[] | null = null;
			if (!verdict.pass) {
				const failedTexts = new Set((verdict.itemVerdicts ?? []).filter(v => !v.pass).map(v => v.text));
				const passing = failedTexts.size ? lesson.items.filter(it => !failedTexts.has(it.text.trim())) : [];
				if (passing.length > 0) {
					logGenStatus(`partial_accept: ${passing.length}/${lesson.items.length} 项通过，重生成缺口`);
					partialAccepted = passing;
					const acceptedWords = passing.filter(it => it.type === "word" || it.type === "phrase").length;
					const acceptedCloze = passing.filter(it => it.type === "cloze").length;
					const target = batch ?? { wordItems: LESSON_WORD_ITEMS, clozeItems: LESSON_CLOZE_ITEMS };
					const shortfallWords = Math.max(0, target.wordItems - acceptedWords);
					const shortfallCloze = Math.max(0, target.clozeItems - acceptedCloze);
					if (shortfallWords > 0) {
						try {
							teachProgress(request, "revising");
							const revised = await generateLesson(llm, ctx, effectiveResolved, conversation, db ? replacementKnownList(db) : [], config, verdict.issues, adaptive ?? undefined, recentLog, { wordItems: shortfallWords, clozeItems: shortfallCloze }, false, isManual);
							if (sessionGeneration !== generation) return;
							if (!db || !ownsGeneration(getRuntimeState(db), generationToken)) return;
							if (revised.ready) {
								teachProgress(request, "checking");
								const revisedVerdict = await critiqueLesson(llm, ctx, effectiveResolved, revised, db ? replacementKnownList(db) : [], config, adaptive ?? undefined, null);
								if (sessionGeneration !== generation) return;
								if (!db || !ownsGeneration(getRuntimeState(db), generationToken)) return;
								if (revisedVerdict.pass) {
									partialAccepted = [...passing, ...revised.items];
								} else {
									const revisedFailed = new Set((revisedVerdict.itemVerdicts ?? []).filter(v => !v.pass).map(v => v.text));
									const revisedPassing = revisedFailed.size ? revised.items.filter(it => !revisedFailed.has(it.text.trim())) : [];
									if (revisedPassing.length > 0) partialAccepted = [...passing, ...revisedPassing];
								}
							}
						} catch (err) {
							logGenStatus(`partial_retry_error: ${(err as Error)?.message || err}`);
						}
					}
				}
			}
			// Revision loop: address critic feedback before giving up.
			for (let attempt = 0; attempt < MAX_LESSON_REVISIONS && partialAccepted == null && verdict.available && !verdict.pass; attempt++) {
				teachProgress(request, "revising");
				const revised = await generateLesson(llm, ctx, effectiveResolved, conversation, db ? replacementKnownList(db) : [], config, verdict.issues, adaptive ?? undefined, recentLog, batch, false, isManual);
				if (sessionGeneration !== generation) return;
				if (!db || !ownsGeneration(getRuntimeState(db), generationToken)) return;
				if (!revised.ready) break;
				lesson = revised;
				teachProgress(request, "checking");
				verdict = await critiqueLesson(llm, ctx, effectiveResolved, lesson, db ? replacementKnownList(db) : [], config, adaptive ?? undefined, batch);
				if (sessionGeneration !== generation) return;
				if (!db || !ownsGeneration(getRuntimeState(db), generationToken)) return;
			}
			// Basic-vocabulary fallback: after the critic keeps rejecting, try one
			// last batch of the easiest everyday words — already-known words are
			// fine, the user can just skip them. Only on a genuine rejection; an
			// unavailable critic stays fail-closed.
			if (partialAccepted == null && !verdict.pass && verdict.available) {
				try {
					teachProgress(request, "revising");
					const basic = await generateLesson(llm, ctx, effectiveResolved, conversation, db ? replacementKnownList(db) : [], config, undefined, adaptive ?? undefined, recentLog, batch, true, isManual);
					if (sessionGeneration !== generation) return;
					if (!db || !ownsGeneration(getRuntimeState(db), generationToken)) return;
					if (basic.ready) {
						teachProgress(request, "checking");
						const basicVerdict = await critiqueLesson(llm, ctx, effectiveResolved, basic, db ? replacementKnownList(db) : [], config, adaptive ?? undefined, batch);
						if (sessionGeneration !== generation) return;
						if (!db || !ownsGeneration(getRuntimeState(db), generationToken)) return;
						if (basicVerdict.pass) {
							lesson = basic;
							verdict = basicVerdict;
							logGenStatus("basic_fallback");
						}
					}
				} catch (err) {
					logGenStatus(`basic_fallback_error: ${(err as Error)?.message || err}`);
				}
			}
			if (partialAccepted == null && !verdict.pass) {
				failureCode = verdict.available ? "TEACH_QUALITY_REJECTED" : "TEACH_CHECK_UNAVAILABLE";
				if (verdict.available) lastRejectedConversation = conversation;
				if (!background || !activeItem(db)) updateWidget(ctx, FACES.idle, [
					verdict.available ? "内容质量未达标，稍后再试…" : "内容审查暂时不可用，稍后重试…",
					statsLine(db),
				]);
				logGenStatus(`${verdict.available ? "critic_rejected" : "critic_unavailable"}: ${verdict.summary || ""}`);
				if (!isManual && !background) deferPacing();
				if (!request?.requestId && config.verbose) ctx.ui.notify(`备课被审查拒绝：${verdict.summary}`, "info");
				return;
			}
			if (partialAccepted != null) {
				lesson = { ...lesson, items: partialAccepted };
			}
			if (!conversationUnchanged()) return;
			// The known list is advisory; when the generator still returns an
			// existing card, retry with the collisions called out, then drop any
			// remainder so the batch is delivered instead of failing wholesale.
			const duplicateItems = (items: GeneratedItem[]): GeneratedItem[] => {
				if (!db) return [];
				const seen = new Set<string>();
				const dupes: GeneratedItem[] = [];
				for (const it of items) {
					const fp = contentFingerprint(it.type, it.text, it.meaning);
					if (db.prepare("SELECT 1 FROM items WHERE content_fingerprint = ?").get(fp) || seen.has(fp)) dupes.push(it);
						seen.add(fp);
				}
				return dupes;
			};
			for (let dupAttempt = 0; dupAttempt < MAX_DUPLICATE_RETRIES; dupAttempt++) {
				const dupes = duplicateItems(lesson.items);
				if (dupes.length === 0) break;
				teachProgress(request, "revising");
				logGenStatus(`duplicate_retry: ${dupes.map((d) => d.text).join("、")}`);
				const dupFeedback: CritiqueIssue[] = dupes.map((d) => ({
					severity: "blocker",
					category: "dup",
					description: `「${d.text}」与已有学习内容重复，请更换成其它不重复的单词/词组`,
				}));
				const revised = await generateLesson(llm, ctx, effectiveResolved, conversation, db ? replacementKnownList(db) : [], config, dupFeedback, adaptive ?? undefined, recentLog, batch, false, isManual);
				if (sessionGeneration !== generation) return;
				if (!db || !ownsGeneration(getRuntimeState(db), generationToken)) return;
				if (!revised.ready) break;
				teachProgress(request, "checking");
				const revisedVerdict = await critiqueLesson(llm, ctx, effectiveResolved, revised, db ? replacementKnownList(db) : [], config, adaptive ?? undefined, batch);
				if (sessionGeneration !== generation) return;
				if (!db || !ownsGeneration(getRuntimeState(db), generationToken)) return;
				if (!revisedVerdict.pass) break;
				lesson = revised;
			}
			const remainingDupes = duplicateItems(lesson.items);
			if (remainingDupes.length > 0) {
				const dupeKeys = new Set(remainingDupes.map((d) => `${d.type} ${d.text}`));
				logGenStatus(`duplicate_dropped: ${[...dupeKeys].join("、")}`);
				lesson = { ...lesson, items: lesson.items.filter((it) => !dupeKeys.has(`${it.type} ${it.text}`)) };
				if (lesson.items.length === 0) {
					failureCode = "TEACH_DUPLICATE_BATCH";
					if (!background || !activeItem(db)) updateWidget(ctx, FACES.idle, ["生成内容与已有卡重复，稍后再试…", statsLine(db)]);
					logGenStatus(`duplicate_batch: ${[...dupeKeys].join("、").slice(0, 120)}`);
					if (!isManual && !background) deferPacing();
					return;
				}
			}
			const insertedAt = new Date();
			let insertedFirst: ItemRow | undefined;
			const insertedIds: number[] = [];
			teachProgress(request, "saving");
			db.exec("BEGIN IMMEDIATE");
			try {
				const state = getRuntimeState(db);
				if (!ownsGeneration(state, generationToken, insertedAt)) throw new Error("GENERATION_LEASE_LOST");
				if (request && !ownsTeachRequest(request)) throw new Error("REQUEST_INTERRUPTED");
				if (!isManual && !background && (state.active_item_id != null ||
					!hasNewCardCapacity(loadPlan(db, insertedAt), countTodayNew(db, insertedAt)) ||
					pendingReplacementTypes(db).length > 0 || getDueItem(db, insertedAt))) {
					db.exec("ROLLBACK");
					logGenStatus("insert_deferred");
					return;
				}
				if (background) {
					// Re-check quota/inventory after the model await. Another session may
					// have introduced or manually added cards while this batch was prepared.
					const fresh = autoRefillPlan(db, config, insertedAt, strategy);
					lesson = { ...lesson, items: lesson.items.slice(0, fresh.slots) };
					if (lesson.items.length === 0) { db.exec("ROLLBACK"); return; }
				}
				// Reject the whole batch if any item duplicates an existing canonical item.
				for (const it of lesson.items) {
					const fp = contentFingerprint(it.type, it.text, it.meaning);
					if (db.prepare("SELECT 1 FROM items WHERE content_fingerprint = ?").get(fp)) {
						db.exec("ROLLBACK");
						logGenStatus(`duplicate_batch: ${it.type} ${it.text}`);
						failureCode = "TEACH_DUPLICATE_BATCH";
						return;
					}
				}
				let firstId: number | undefined;
				for (const it of lesson.items) {
					const id = insertItem(db, it.type, it.text, it.phonetic || null, it.meaning, it.example || null, it.example_cn || null, insertedAt, {
						levels: it.levels,
						levels_cn: it.levels_cn,
						chunks: it.chunks,
						keyWords: it.keyWords,
					});
					firstId ??= id;
					insertedIds.push(id);
				}
				if (firstId == null) throw new Error("LESSON_INSERT_FAILED");
				if (!isManual && !background) {
					bumpStat(db, "total_learned", 1);
					touchStreak(db, insertedAt);
					markShown(db, firstId);
					db.prepare("UPDATE items SET introduced_at = ? WHERE id = ?").run(insertedAt.toISOString(), firstId);
					setRuntimeState(db, {
						active_item_id: firstId,
						active_kind: "teach",
						active_direction: "forward",
						active_version: state.active_version + 1,
						...EMPTY_SENTENCE_CYCLE,
						next_check_at: insertedAt.toISOString(),
						generation_token: null,
						generation_until: null,
					});
					insertedFirst = db.prepare("SELECT * FROM items WHERE id = ?").get(firstId) as ItemRow | undefined;
				} else if (request?.requestId) {
					// The receipt and cards become visible in the same successful commit.
					writeTeachReceipt(db, { requestId: request.requestId, phase: "succeeded", itemsAdded: insertedIds.length,
						itemIds: insertedIds, topic: request.topic, updatedAt: insertedAt.toISOString(), ownerId: myId });
				}
				db.exec("COMMIT");
				saved = true;
				if (request?.requestId) pendingTeachRequests.delete(request.requestId);
			} catch (err) {
				try { db.exec("ROLLBACK"); } catch { /* no transaction */ }
				throw err;
			}
			lastRejectedConversation = "";
			logGenStatus(`ok: ${lesson.topic || ""}`);
			if (background) {
				logGenStatus(`auto_refill_ok: ${insertedIds.length}`);
				// Stocking inventory never claims the active slot or changes pacing.
				return insertedIds.length;
			}
			if (isManual) {
				if (!request?.requestId) ctx.ui.notify(`已生成 ${insertedIds.length} 张新卡：「${request!.topic}」`, "info");
				const next = !activeItem(db) ? claimDueItem(insertedAt) : undefined;
				if (next && !request?.requestId) showItem(ctx, next); else renderGlobalCard(ctx);
				return;
			}
			if (!insertedFirst) return;
			showItem(ctx, insertedFirst);
			if (lesson.topic && db) {
				if (!background || !activeItem(db)) updateWidget(ctx, FACES.review, [
					`${FACES.teach} 今日主题：${lesson.topic}`,
					...renderCard(
						insertedFirst,
						true,
						FACES.review,
						false,
						"forward",
						activeForwardCue(insertedFirst, "forward"),
					),
					statsLine(db),
				]);
			}
			if (config.verbose) {
				ctx.ui.notify(`备好课啦：${lesson.topic || "主题"}，共 ${lesson.items.length} 个学习项`, "info");
			}
		} catch (err) {
			if (sessionGeneration !== generation) return;
			const msg = (err as Error)?.message || String(err);
			const candidateCode = String((err as Error & { code?: string }).code || msg);
			failureCode = /^[A-Z][A-Z0-9_]{0,79}$/.test(candidateCode) ? candidateCode : "TEACH_GENERATION_FAILED";
			lastError = candidateCode.slice(0, 80);
			if (db && (!background || !activeItem(db))) updateWidget(ctx, FACES.error, [`备课失败：${lastError}`, statsLine(db)]);
			logGenStatus(`error: ${lastError}`);
			if (!isManual && !background) deferPacing();
		} finally {
			if (sessionGeneration === generation && request && !saved) {
				if (db && !ownsGeneration(getRuntimeState(db), generationToken)) failureCode = "GENERATION_LEASE_LOST";
				teachProgress(request, "failed", failureCode);
			}
			if (manualWork?.token === generationToken) manualWork = undefined;
			if (db) releaseGeneration(generationToken);
			if (sessionGeneration === generation) {
				pendingLLMCall = false;
				pendingLLMCallAt = 0;
				drainTeachQueue();
			}
		}
	}



	function adaptiveSnapshot(): AdaptiveContext {
		const profile = computeLearnerProfile(db!, new Date());
		return { profile, budget: smoothBudget(db!, deriveBudget(profile)) };
	}



	async function runSkipAction(ctx: ExtensionContext): Promise<void> {
		if (!db) {
			ctx.ui.notify("当前没有可跳过的卡片", "info");
			return;
		}
		let skipped: ItemRow | undefined;
		let undoActionId: string | undefined;
		try {
			const result = skipPending(ctx);
			skipped = result?.item;
			undoActionId = result?.actionId;
		} catch (err) {
			ctx.ui.notify(`标记失败：${(err as Error).message}`, "error");
			return;
		}
		if (!skipped || !db) {
			ctx.ui.notify("当前没有可跳过的卡片", "info");
			return;
		}
		// The replacement is generated by the background loop and joins the back
		// of the new-card queue: serve the next stored card immediately instead.
		scheduleReplacementWork();
		if (!continueStudyUndoAction(db, undoActionId!, () => resetPacing(db!))) return;
		const queued = claimDueItem(new Date());
		if (queued) {
			if (!showItem(ctx, queued)) renderGlobalCard(ctx);
			return;
		}
		// The synchronous claim misses cards that become due seconds later, and the
		// fallback work timer waits a full pacing interval: re-check at the grace
		// boundary so stored cards surface in seconds while generation runs.
		scheduleTimer(REPLACEMENT_GRACE_MS);
	}

	// -- Commands ---------------------------------------------------------

	/** Authenticated, selectable models (ordered by auto-detect priority). */
	function selectableModels(ctx: ExtensionContext) {
		const available = ctx.modelRegistry.getAvailable();
		const withAuth = available.filter((m) => ctx.modelRegistry.hasConfiguredAuth(m));
		return withAuth.sort((a, b) => {
			const ia = AUTO_DETECT_MODELS.indexOf(a.id);
			const ib = AUTO_DETECT_MODELS.indexOf(b.id);
			return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
		});
	}

	/** Merge a patch into the global config file, keeping other keys. */
	function persistConfig(patch: Record<string, unknown>) {
		const globalPath = join(getAgentDir(), "kaomoji-english-tutor.json");
		try {
			const existing = existsSync(globalPath) ? JSON.parse(readFileSync(globalPath, "utf-8")) : {};
			writeFileSync(globalPath, JSON.stringify({ ...existing, ...patch }, null, 2) + "\n");
		} catch (err) {
			console.error(`[pi-english-anki] Failed to persist config: ${err}`);
		}
	}

	function applyLessonModel(ctx: ExtensionContext, spec: string) {
		const [provider, model] = spec.split("/", 2);
		if (!provider || !model) {
			ctx.ui.notify(`无效的模型格式：${spec}（应为 provider/model）`, "error");
			return false;
		}
		const found = ctx.modelRegistry.find(provider, model);
		if (!found || !ctx.modelRegistry.hasConfiguredAuth(found)) {
			ctx.ui.notify(`模型不可用或未配置密钥：${spec}`, "error");
			return false;
		}
		config.provider = provider;
		config.model = model;
		resolvedModelName = `${provider}/${model}`;
		persistConfig({ provider, model });
		ctx.ui.notify(`备课模型已设为 ${spec}（已保存，立即生效）`, "info");
		return true;
	}

	pi.registerCommand("anki:model", {
		description: "Show/set the lesson model: pick from authenticated models or pass provider/model",
		handler: async (args, ctx) => {
			const target = String(args ?? "").trim();
			const models = selectableModels(ctx);

			// Show current model first
			if (!resolvedModelName) resolveModel(ctx);
			ctx.ui.notify(`当前备课模型：${resolvedModelName || "（未确定）"}`, "info");

			if (!models.length) {
				ctx.ui.notify("没有已认证的可用模型", "error");
				return;
			}

			// Bare invocation: interactive picker
			if (!target) {
				const options = models.map((m, i) => `${i + 1}. ${m.provider}/${m.id}`);
				const chosen = await ctx.ui.select("选择备课模型", options);
				if (!chosen) {
					ctx.ui.notify("已取消", "info");
					return;
				}
				const idx = parseInt(chosen.split(".")[0], 10) - 1;
				const picked = models[idx];
				if (picked) applyLessonModel(ctx, `${picked.provider}/${picked.id}`);
				return;
			}

			// Number: index into the listed models
			if (/^\d+$/.test(target)) {
				const idx = parseInt(target, 10) - 1;
				if (idx < 0 || idx >= models.length) {
					ctx.ui.notify(`编号无效（1-${models.length}）`, "error");
					return;
				}
				const picked = models[idx];
				applyLessonModel(ctx, `${picked.provider}/${picked.id}`);
				return;
			}

			// provider/model form
			if (target.includes("/")) {
				applyLessonModel(ctx, target);
				return;
			}

			ctx.ui.notify(`用法：/anki:model（交互选择）或 /anki:model <provider/model|编号>`, "info");
		},
	});

	pi.registerCommand("anki:interval", {
		description: "Show/set the automatic lesson interval in minutes, or off",
		handler: async (args, ctx) => {
			const target = String(args ?? "").trim().toLowerCase();
			if (!target) {
				ctx.ui.notify(
					config.intervalMinutes > 0 ? `当前自动检查间隔：${config.intervalMinutes} 分钟` : "自动检查已关闭",
					"info",
				);
				ctx.ui.notify("用法：/anki:interval <分钟|off>", "info");
				return;
			}
			if (target === "off") {
				config.intervalMinutes = 0;
				persistConfig({ intervalMinutes: 0 });
				stopTimer();
				publishForecast();
				ctx.ui.notify("自动检查已关闭", "info");
				return;
			}
			const minutes = Number(target);
			if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 1440) {
				ctx.ui.notify("请输入大于 0 且不超过 1440 的分钟数，或 off", "error");
				return;
			}
			config.intervalMinutes = minutes;
			persistConfig({ intervalMinutes: minutes });
			scheduleTimer();
			ctx.ui.notify(`自动检查间隔已设为 ${minutes} 分钟（立即生效）`, "info");
		},
	});

	pi.registerCommand("anki:thinking", {
		description: "Show/set the lesson thinking level (off|minimal|low|medium|high|xhigh|max)",
		handler: async (args, ctx) => {
			const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
			const target = String(args ?? "").trim().toLowerCase();
			if (!target) {
				ctx.ui.notify(`当前备课思考等级：${config.thinkingLevel ?? "（provider 默认）"}`, "info");
				ctx.ui.notify(`用法：/anki:thinking <${LEVELS.join("|")}>`, "info");
				return;
			}
			if (!(LEVELS as readonly string[]).includes(target)) {
				ctx.ui.notify(`无效等级：${target}（可选 ${LEVELS.join(" | ")}）`, "error");
				return;
			}
			config.thinkingLevel = target as ThinkingLevel;
			persistConfig({ thinkingLevel: target });
			ctx.ui.notify(`备课思考等级已设为 ${target}（已保存，立即生效）`, "info");
		},
	});

	pi.registerCommand("anki:flip", {
		description: "Toggle the shown card between question and answer sides",
		handler: async (_args, ctx) => {
			if (!flipPending(ctx)) {
				ctx.ui.notify("当前没有可翻面的卡片", "info");
			}
		},
	});

	pi.registerCommand("anki:good", {
		description: "Rate a word/phrase as remembered; sentences require /anki:answer",
		handler: async (_args, ctx) => {
			if (!ratePending(ctx, Rating.Good)) {
				ctx.ui.notify("当前没有待评分的复习卡", "info");
			}
		},
	});

	pi.registerCommand("anki:easy", {
		description: "Rate a word/phrase as too easy (FSRS Easy, longer interval); sentences require /anki:answer",
		handler: async (_args, ctx) => {
			if (!ratePending(ctx, Rating.Easy)) {
				ctx.ui.notify("当前没有待评分的复习卡", "info");
			}
		},
	});

	pi.registerCommand("anki:again", {
		description: "Rate the pending review card as forgotten (FSRS Again)",
		handler: async (_args, ctx) => {
			if (!ratePending(ctx, Rating.Again)) {
				ctx.ui.notify("当前没有待评分的复习卡", "info");
			}
		},
	});

	pi.registerCommand("anki:skip", {
		description: "Mark the shown card as known and generate a same-type replacement",
		handler: async (_args, ctx) => {
			await runSkipAction(ctx);
		},
	});

	pi.registerCommand("anki:undo", {
		description: "Undo the latest untouched manual rating or skip",
		handler: async (args, ctx) => {
			if (!db) return;
			const parts = String(args ?? "").trim().split(/\s+/);
			const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
			const correlated = parts.length === 3 && parts[1] === "--request-id" && uuid.test(parts[2]);
			if (!uuid.test(parts[0]) || !(parts.length === 1 || correlated)) {
				ctx.ui.notify("撤销请求无效，请使用 /anki:undo <actionId> --request-id <UUID>", "warning");
				return;
			}
			const actionId = parts[0], requestId = correlated ? parts[2] : randomUUID();
			try {
				const result = undoStudyAction(db, actionId, requestId);
				if (result.applied) {
					stopTimer(); stopReplacementTimer();
					clearPendingLocals(); localVersion = -1;
					renderGlobalCard(ctx); scheduleReplacementWork(); publishForecast();
				}
				if (!correlated) ctx.ui.notify(result.status === "succeeded" ? "已撤销，回到刚才的卡片。" : "这次操作已不能撤销，当前学习进度未改变。", "info");
			} catch {
				const itemId = readStudyUndo(db)?.itemId ?? null;
				// A display refresh failing after COMMIT cannot rewrite a successful receipt.
				if (!db.prepare("SELECT 1 FROM stats WHERE key=?").get(`study_undo_result:${requestId}`)) {
					setStat(db, `study_undo_result:${requestId}`, JSON.stringify({ requestId, actionId, itemId, status: "rejected", errorCode: "UNDO_FAILED", updatedAt: new Date().toISOString() }));
				}
				if (!correlated) ctx.ui.notify("暂时无法撤销，当前学习进度未改变。", "warning");
			}
		},
	});

	pi.registerCommand("anki:answer", {
		description: "Submit bidirectional recall or progressive written sentence output",
		handler: async (args, ctx) => {
			const text = String(args ?? "").trim();
			const ok = await answerPending(ctx, text);
			if (!ok && !text) {
				ctx.ui.notify("用法：/anki:answer <你的答案>（无参数显示题目）", "info");
			}
		},
	});

	pi.registerCommand("anki:chat", {
		description: "Anki 专用问答、修卡与加卡",
		handler: async (args, ctx) => {
			let request;
			try { request = parseChatRequest(String(args ?? "")); }
			catch (error) {
				const reply = `问答请求无效：${(error as Error).message}`;
				let rawRequest: { requestId?: unknown; itemId?: unknown } | null = null;
				try { rawRequest = JSON.parse(String(args ?? "")); } catch { /* no correlated request id */ }
				if (rawRequest && typeof rawRequest.requestId === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(rawRequest.requestId)) {
					ctx.ui.notify("ANKI_CHAT_RESULT:" + JSON.stringify({ requestId: rawRequest.requestId, success: false, reply, action: "none", itemId: Number.isSafeInteger(rawRequest.itemId) && Number(rawRequest.itemId) > 0 ? rawRequest.itemId : null }), "info");
				} else ctx.ui.notify(reply, "error");
				return;
			}
			const generation = sessionGeneration;
			const database = db;
			const valid = () => generation === sessionGeneration && database === db && !isCtxStale(ctx);
			dispatchChat(request, async () => {
				if (!database || !valid()) return { requestId: request.requestId, success: false, reply: "数据库或会话不可用", action: "none", itemId: request.itemId };
				if (pendingChat) return { requestId: request.requestId, success: false, reply: "上一条问答仍在处理中，请稍候", action: "none", itemId: request.itemId };
				pendingChat = true;
				try {
					const resolved = resolveModel(ctx);
					if (!resolved) return { requestId: request.requestId, success: false, reply: "未配置可用模型", action: "none", itemId: request.itemId };
					return await runChat(request, {
						db: database, valid,
						complete: (prompt) => llm.complete(ctx, resolved, { systemPrompt: CHAT_SYSTEM_PROMPT, prompt, thinkingLevel: config.thinkingLevel }),
						critique: async (item) => {
							const review = chatEditReview(database, request.itemId!, item);
							return (await critiqueLesson(llm, ctx, resolved, review.lesson, review.known, config, undefined, null)).pass;
						},
						refresh: () => { if (valid()) { localVersion = -1; renderGlobalCard(ctx); } },
						add: async (_prompt) => ({ success: false, reply: "已切换终端出卡模式：助手不再直接加卡。请让终端 pi 出卡并用 /anki:insert 入队。" }),
					});
				} finally { if (generation === sessionGeneration) { pendingChat = false; scheduleTimer(); } }
			}, result => { if (valid()) ctx.ui.notify("ANKI_CHAT_RESULT:" + JSON.stringify(result), "info"); });
		},
	});

	pi.registerCommand("anki:hint", {
		description: "Show a recall hint or the current sentence level's initial-letter hint",
		handler: async (_args, ctx) => {
			if (db) invalidateStudyUndo(db);
			if (!hintPending(ctx)) ctx.ui.notify("当前没有可提示的词卡", "info");
		},
	});

	pi.registerCommand("anki:screening", {
		description: "切换筛查扫荡模式：连续随机出还没学过的卡（排队卡和未出过的新卡，不含正常学习中的卡），答对=已会（一年后再见），答错不改动任何安排",
		handler: async (args, ctx) => {
			// Explicit on/off beats toggling: concurrent sessions make toggle
			// direction unreliable. The config FILE stays the source of truth.
			// (concurrent sessions hold stale in-memory copies).
			const path = join(getAgentDir(), "kaomoji-english-tutor.json");
			let fileValue = config.screeningMode;
			try {
				if (existsSync(path)) {
					const parsed = JSON.parse(readFileSync(path, "utf-8"));
					if (typeof parsed.screeningMode === "boolean") fileValue = parsed.screeningMode;
				}
			} catch { /* fall back to memory */ }
			const arg = String(args ?? "").trim().toLowerCase();
			const next = arg === "on" ? true : arg === "off" ? false : !fileValue;
			config.screeningMode = next;
			try {
				const current = existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) : {};
				current.screeningMode = next;
				writeFileSync(path, JSON.stringify(current, null, "\t") + "\n", "utf-8");
			} catch (err) {
				ctx.ui.notify(`已在本会话${next ? "开启" : "关闭"}筛查模式，但写入配置失败：${(err as Error).message}`, "warning");
				return;
			}
			screeningCache = { value: next, at: Date.now() };
			ctx.ui.notify(`筛查扫荡模式：${next ? "已开启——自由刷还没学过的卡（排队卡和未出过的新卡），答出卡面原词即已会（一年后再见），答错不变" : "已关闭，恢复正常学习"}`, "info");
			screeningSwept.clear();
			screeningSweptQueue.clear();
			if (!db) return;
			// A sweep card on screen was never rated: put it back untouched.
			if (!next) releaseStaleScreeningCard();
			else releaseStudyCardForScreening();
			if (activeItem(db)) {
				renderGlobalCard(ctx);
				return;
			}
			const card = claimDueItem(new Date());
			if (card) {
				stopTimer();
				if (!showItem(ctx, card)) renderGlobalCard(ctx);
			} else {
				renderGlobalCard(ctx);
				scheduleTimer();
			}
		},
	});

	pi.registerCommand("anki:teach", {
		description: "Generate a reviewed batch now, independently of study pacing and daily quota",
		handler: async (args, ctx) => {
			let request: TeachRequest;
			try { request = parseTeachRequest(String(args ?? "")); }
			catch { ctx.ui.notify("用法：/anki:teach [--request-id UUID] <话题>", "error"); return; }
			if (!db) { ctx.ui.notify("数据库不可用", "error"); return; }
			if (!config.autoTeach) {
				// Terminal-teach mode: resolve any tracked request as an explicit
				// failure so the app's teach panel does not wait for a receipt.
				if (request.requestId) {
					db.exec("BEGIN IMMEDIATE");
					try {
						writeTeachReceipt(db, {
							requestId: request.requestId,
							topic: request.topic,
							phase: "failed",
							itemsAdded: 0,
							errorCode: "AUTO_TEACH_DISABLED",
								updatedAt: new Date().toISOString(),
							});
						db.exec("COMMIT");
						} catch (err) {
							try { db.exec("ROLLBACK"); } catch { /* no transaction */ }
							throw err;
						}
				}
				ctx.ui.notify("已切换终端出卡模式：备课由终端 pi 对话完成，用 /anki:insert 直接入队", "warning");
				return;
			}
			if (request.requestId) {
				db.exec("BEGIN IMMEDIATE");
				try {
					if (readTeachReceipt(db, request.requestId)) { db.exec("ROLLBACK"); return; }
					teachProgress(request, "queued");
					db.exec("COMMIT");
				} catch (err) {
					try { db.exec("ROLLBACK"); } catch { /* no transaction */ }
					throw err;
				}
				pendingTeachRequests.set(request.requestId, request);
			}
			teachQueue.push(request);
			if (!request.requestId && (pendingLLMCall || teachQueue.length > 1)) ctx.ui.notify(`已排队：当前生成结束后自动开始「${request.topic}」`, "info");
			drainTeachQueue();
		},
	});



	pi.registerCommand("anki:insert", {
		description: "终端出卡入口：直接入队 JSON 卡片数组（绕过本体 LLM 生成，仍走去重与每日额度）",
		handler: async (args, ctx) => {
			if (!db) { ctx.ui.notify("数据库不可用", "error"); return; }
			const raw = String(args ?? "").trim();
			if (!raw) {
				ctx.ui.notify("用法：/anki:insert '[{\"type\":\"word\",\"text\":\"kettle\",\"meaning\":\"…\"}]'", "info");
				return;
			}
			let parsed: unknown;
			try { parsed = JSON.parse(raw); } catch (err) { ctx.ui.notify(`JSON 解析失败：${err}`, "error"); return; }
			const list = Array.isArray(parsed) ? parsed : [parsed];
			if (list.length === 0) { ctx.ui.notify("空数组", "error"); return; }
			if (list.length > MAX_CUSTOM_PER_ADD) { ctx.ui.notify(`一次最多 ${MAX_CUSTOM_PER_ADD} 张`, "error"); return; }
			const kept: GeneratedItem[] = [];
			const dropped: string[] = [];
			const batchFingerprints = new Set<string>();
			for (const entry of list) {
				const item = (() => { try { return parseGeneratedItem(entry); } catch { return undefined; } })();
				if (!item) { dropped.push("(格式无效)"); continue; }
				const fingerprint = contentFingerprint(item.type, item.text, item.meaning);
				if (batchFingerprints.has(fingerprint)) { dropped.push(`${item.text}(批内重复)`); continue; }
				const dupe = db.prepare("SELECT 1 FROM items WHERE content_fingerprint = ?").get(fingerprint)
					?? db.prepare("SELECT 1 FROM custom_card_queue WHERE fingerprint = ?").get(fingerprint);
				if (dupe) { dropped.push(item.text); continue; }
				batchFingerprints.add(fingerprint);
				kept.push(item);
			}
			if (kept.length === 0) {
				ctx.ui.notify(`没有可入队的卡（重复/无效 ${dropped.length} 张）${dropped.length ? `：${dropped.join("、").slice(0, 200)}` : ""}`, "warning");
				return;
			}
			db.exec("BEGIN IMMEDIATE");
			try {
				for (const item of kept) enqueueCustomCard(db, "terminal", item);
				db.exec("COMMIT");
			} catch (err) {
				try { db.exec("ROLLBACK"); } catch { /* no transaction */ }
				ctx.ui.notify(`入队失败：${err}`, "error");
				return;
			}
			const total = customQueueCount(db);
			ctx.ui.notify(`终端出卡：入队 ${kept.length} 张（丢弃重复/无效 ${dropped.length} 张），队列共 ${total} 张`, "info");
			if (dropped.length) ctx.ui.notify(`丢弃：${dropped.join("、").slice(0, 200)}`, "info");
			// Try to surface the first queued card right away; pacing, an active
			// card, or quota otherwise defer it to the next tick.
			releaseCustomQueue(ctx, new Date());
		},
	});

	pi.registerCommand("anki:queue", {
		description: "查看排队的定制卡（只读）",
		handler: async (_args, ctx) => {
			if (!db) return;
			const rows = listCustomQueue(db);
			if (rows.length === 0) {
				ctx.ui.notify("没有排队的定制卡", "info");
				return;
			}
			const lines = rows.slice(0, 15).map((row) => {
				let item: GeneratedItem | undefined;
				try { item = JSON.parse(row.payload) as GeneratedItem; } catch { /* corrupt row */ }
				return item
					? `${row.id}. ${TYPE_LABELS[item.type] ?? item.type} ${item.text} — ${item.meaning}`
					: `${row.id}. （无法解析的队列项）`;
			});
			if (rows.length > 15) lines.push(`…以及 ${rows.length - 15} 张更多`);
			ctx.ui.notify(`${lines.join("\n")}\n共 ${rows.length} 张，${queueEta(db, rows.length)}`, "info");
		},
	});

	pi.registerCommand("anki:stats", {
		description: "Show detailed learning statistics (mastery stages, reinforcement, answer accuracy)",
		handler: async (_args, ctx) => {
			if (!db) return;
			const stages = db.prepare("SELECT stage, COUNT(*) AS n FROM mastery_state GROUP BY stage ORDER BY stage").all() as { stage: string; n: number }[];
			const reinforce = Number((db.prepare("SELECT COUNT(*) AS n FROM mastery_state WHERE consecutive_again >= 2").get() as { n: number }).n);
			const attempts = Number((db.prepare("SELECT COUNT(*) AS n FROM attempts").get() as { n: number }).n);
			const correct = Number((db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE verdict = 'correct'").get() as { n: number }).n);
			const rate = attempts > 0 ? Math.round((correct / attempts) * 100) : 0;
			const stageLine = stages.length ? stages.map((s) => `${s.stage}:${s.n}`).join(" · ") : "暂无";
			ctx.ui.notify(`掌握阶段：${stageLine}；需强化：${reinforce}；答题 ${attempts} 次，正确率 ${rate}%`, "info");
			const now = new Date();
			const profile = computeLearnerProfile(db, now);
			ctx.ui.notify(formatProfileStatsLine(profile, deriveBudget(profile)), "info");
			ctx.ui.notify(formatDailyLoadPlan(loadPlan(db, now)), "info");
			const genEvents = getGenLog(db).slice(-3);
			if (genEvents.length) {
				const fmt = (t: string) => {
					const d = new Date(t);
					const pad = (n: number) => String(n).padStart(2, "0");
					return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
				};
				ctx.ui.notify(`最近备课决策：${genEvents.map((e) => `${fmt(e.t)} ${e.s}`).join("；")}`, "info");
			}
		},
	});

	pi.registerCommand("anki:vocab", {
		description: "Estimate vocabulary size stratified by CEFR/frequency band (word lists under dictionaries/)",
		handler: async (_args, ctx) => {
			if (!db) return;
			let vocabBand: string | undefined;
			try {
				vocabBand = JSON.parse(getStat(db, "adaptive_budget_smooth") ?? "{}")?.vocabBand;
			} catch { /* frontier falls back to B1 */ }
			for (const line of formatVocabReport(vocabularyReport(db, vocabBand))) ctx.ui.notify(line, "info");
		},
	});

	pi.registerCommand("anki:images", {
		description: "为缺图的词/词组卡补配概念图（有道图解词典，仅存在线链接，不落图片文件）",
		handler: async (args, ctx) => {
			if (!db) return;
			const limit = Math.min(200, Math.max(1, Number(args.trim()) || 50));
			ctx.ui.notify(`正在查询配图（最多 ${limit} 张）…`, "info");
			const summary = await backfillCardImages(db, { limit, delayMs: 150 });
			ctx.ui.notify(`配图完成：检查 ${summary.checked} 张，新增图片 ${summary.resolved} 张，无图 ${summary.noImage} 张`, "info");
		},
	});

	pi.registerCommand("anki:pull", {
		description: "从云端拉取更新的学习数据（本地旧库备份为 .bak）",
		handler: async (_args, ctx) => {
			if (!isSyncEnabled()) { ctx.ui.notify("未配置同步仓库：~/.pi/agent/kaomoji-english-tutor-sync", "warning"); return; }
			if (answerJudging || pendingLLMCall) { ctx.ui.notify("正在判题/备课，稍后再拉取", "warning"); return; }
			const generation = sessionGeneration;
			stopAnswerThinking();
			stopTimer();
			stopPolling();
			stopReplacementTimer();
			releaseCoordinator();
			if (db) {
				// Unregister myself so the live-client guard does not refuse the swap.
				try { db.prepare("DELETE FROM runtime_clients WHERE client_id = ?").run(myId); } catch { /* best effort */ }
			}
			clearPendingLocals();
			localVersion = -1;
			closeDb();
			const r = await pullIfNewer(dbFilePath(), { force: true });
			if (generation !== sessionGeneration) return; // a newer session_start owns the DB now
			try {
				db = openDb();
			} catch (err) {
				console.error(`[pi-english-anki] Failed to reopen DB after pull: ${err}`);
				db = null;
			}
			if (db && (r.status === "pulled" || r.status === "error")) {
				appendGenLog(db, r.status === "pulled"
					? `sync_pulled: ${r.remoteTs}`
					: `sync_pull_error: ${r.message ?? ""}`);
			}
			attachDb(ctx);
			scheduleTimer();
			if (r.status === "pulled") ctx.ui.notify("已从云端拉取最新学习数据 ✓（旧本地库已备份 .bak）", "info");
			else if (r.status === "current") ctx.ui.notify("本地已是最新，无需拉取", "info");
			else if (r.status === "no_remote") ctx.ui.notify("远端还没有可拉取的快照", "warning");
			else if (r.status !== "disabled") ctx.ui.notify(`拉取失败：${r.message ?? r.status}`, "error");
		},
	});

	pi.registerCommand("anki:sync", {
		description: "立即将学习数据推送到云端同步仓库",
		handler: async (_args, ctx) => {
			if (!db) { ctx.ui.notify("数据库不可用", "error"); return; }
			if (!isSyncEnabled()) { ctx.ui.notify("未配置同步仓库：~/.pi/agent/kaomoji-english-tutor-sync", "warning"); return; }
			const r = await pushSnapshot(db, { ignoreThrottle: true });
			if (r.status === "pushed") ctx.ui.notify("学习数据已推送到云端 ✓", "info");
			else if (r.status === "unchanged") ctx.ui.notify("没有需要推送的新进度", "info");
			else if (r.status === "remote_newer") ctx.ui.notify("云端有更新的进度，执行 /anki:pull 拉取（本地旧库会备份 .bak）", "warning");
			else ctx.ui.notify(`同步失败：${r.message ?? r.status}`, "error");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		interruptManualRequests();
		sessionGeneration++;
		pendingChat = false;
		stopReplacementTimer();
		stopAnswerThinking();
		stopTimer();
		lastDataVersion = null;
		localVersion = -1;
		releaseCoordinator();
		closeDb();
		config = loadConfig(ctx.cwd);
		resetState();
		latestCtx = ctx;
		// Establish my coordinator identity for the shared generation lease.
		try {
			sessionId = ctx.sessionManager?.getSessionId?.() ?? "";
		} catch {
			sessionId = "";
		}
		myId = myCoordinatorId(sessionId, instanceToken);
		clearPendingLocals();
		// Cloud sync never blocks startup: no network here. A background peek
		// runs after attach and nudges toward /anki:pull when the cloud is newer.
		try {
			db = openDb();
		} catch (err) {
			console.error(`[pi-english-anki] Failed to open DB: ${err}`);
			db = null;
		}
		attachDb(ctx);
		scheduleTimer();
		const generation = sessionGeneration;
		void peekRemoteNewer().then((r) => {
			if (generation !== sessionGeneration || !latestCtx || isCtxStale(latestCtx)) return;
			if (r.remoteNewer) latestCtx.ui.notify("云端有更新的学习进度，执行 /anki:pull 拉取（本地旧库会备份 .bak）", "warning");
		}, () => { /* peek must never surface errors */ });
	});

	pi.on("session_shutdown", async () => {
		interruptManualRequests();
		sessionGeneration++;
		pendingChat = false;
		stopReplacementTimer();
		stopAnswerThinking();
		await llm.dispose();
		stopTimer();
		stopPolling();
		releaseCoordinator();
		latestCtx = undefined;
		clearPendingLocals();
		pendingLLMCall = false;
		pendingLLMCallAt = 0;
		sessionId = "";
		myId = "";
		lastCoordinatorRenewal = 0;
		lastDataVersion = null;
		localVersion = -1;
		// Cloud sync: best-effort final push so a machine switch picks up this progress.
		if (db) {
			try {
				await pushSnapshot(db, { ignoreThrottle: true });
			} catch { /* shutdown must not fail on sync */ }
		}
		closeDb();
	});

	// Real user activity makes this the most-recent coordinator; injected input does not.
	pi.on("input", (event, _ctx) => {
		if (event.source !== "extension") ensureCoordinator(new Date(), true);
		return { action: "continue" };
	});
}
