import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { fauxAssistantMessage, registerFauxProvider, streamSimple as streamModel } from "@earendil-works/pi-ai/compat";

const agentDir = mkdtempSync(join(tmpdir(), "kaomoji-tutor-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const capturedLlmContexts: string[] = [];
const sdkRuntimeFactory = async (ctx: any) => ({
	getModel: (provider: string, modelId: string) => ctx.modelRegistry.find(provider, modelId),
	hasConfiguredAuth: () => true,
	setRuntimeApiKey: async () => {},
	streamSimple: async (model: any, context: any, options: any) => {
		capturedLlmContexts.push(JSON.stringify(context));
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) throw new Error("NO_API_KEY");
		return streamModel(model, context, { ...options, apiKey: auth.apiKey, headers: auth.headers });
	},
}) as any;
const { default: extension, contentFingerprint } = await import("../index.ts");
const { undoStudyAction } = await import("../study-undo.ts");
let sessionSeq = 0;

interface FakeTimer {
	callback: () => void;
	delay: number;
	active: boolean;
	unref(): void;
}

function installFakeTimers() {
	const realSetTimeout = globalThis.setTimeout;
	const realClearTimeout = globalThis.clearTimeout;
	const realRandom = Math.random;
	Math.random = () => 0; // deterministic: review direction always "forward" unless a test overrides
	let timers: FakeTimer[] = [];
	(globalThis as any).setTimeout = (callback: () => void, delay = 0) => {
		const timer: FakeTimer = { callback, delay, active: true, unref() {} };
		timers.push(timer);
		return timer;
	};
	(globalThis as any).clearTimeout = (timer: FakeTimer) => { timer.active = false; };

	const kaomojiReplacement = (timer: FakeTimer) => (timer as unknown as { kaomojiReplacement?: boolean }).kaomojiReplacement;
	const kaomojiAutoRefill = (timer: FakeTimer) => (timer as unknown as { kaomojiAutoRefill?: boolean }).kaomojiAutoRefill;
	const kaomojiPoll = (timer: FakeTimer) => (timer as unknown as { kaomojiPoll?: boolean }).kaomojiPoll;
	return {
		/** Active timers that are NOT the kaomoji cross-session sync poll. */
		active: () => timers.filter((timer) => timer.active && !kaomojiPoll(timer) && !kaomojiReplacement(timer) && !kaomojiAutoRefill(timer)),
		refills: () => timers.filter((timer) => timer.active && kaomojiAutoRefill(timer)),
		replacements: () => timers.filter((timer) => timer.active && kaomojiReplacement(timer)),
		/** Active cross-session sync poll timers. */
		poll: () => timers.filter((timer) => timer.active && kaomojiPoll(timer)),
		reset: () => { timers = []; },
		async fire(timer?: FakeTimer) {
			// By default fire the first active work timer (skipping the sync poll).
			const target = timer ?? timers.find((entry) => entry.active && !kaomojiPoll(entry) && !kaomojiReplacement(entry) && !kaomojiAutoRefill(entry));
			assert.ok(target, "expected an active timer");
			target.active = false;
			target.callback();
			await new Promise<void>((resolve) => realSetTimeout(resolve, 0));
		},
		async firePoll() {
			// Fire every currently-active sync poll (one per attached session).
			const targets = timers.filter((entry) => entry.active && kaomojiPoll(entry));
			assert.ok(targets.length > 0, "expected an active poll timer");
			for (const target of targets) {
				target.active = false;
				target.callback();
			}
			await new Promise<void>((resolve) => realSetTimeout(resolve, 0));
		},
		flush: () => new Promise<void>((resolve) => realSetTimeout(resolve, 0)),
		restore() {
			(globalThis as any).setTimeout = realSetTimeout;
			(globalThis as any).clearTimeout = realClearTimeout;
			Math.random = realRandom;
		},
	};
}

async function createHarness(options: { model?: any; modelRegistry?: any; sessionId?: string } = {}) {
	rmSync(agentDir, { recursive: true, force: true });
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(`${agentDir}/kaomoji-english-tutor.json`, JSON.stringify({ intervalMinutes: 10, dailyNewLimit: 0, adaptiveNewCards: false }));
	return makeSession(options);
}

/** Configure a clean shared agentDir (used once before attaching multi-session variants). */
function writeConfig(config: Record<string, unknown>) {
	rmSync(agentDir, { recursive: true, force: true });
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(`${agentDir}/kaomoji-english-tutor.json`, JSON.stringify({ adaptiveNewCards: false, ...config }));
}

/** Attach one extension instance to the shared agentDir (a single Pi session/process). */
async function makeSession(options: { model?: any; modelRegistry?: any; sessionId?: string; mode?: string; branch?: any[] } = {}) {
	const logicalSessionId = options.sessionId ?? `session-${++sessionSeq}`;
	const handlers: Record<string, any> = {};
	const commands: Record<string, any> = {};
	const shortcuts: Record<string, any> = {};
	let widget: string[] = [];
	const notifications: string[] = [];
	const pi: any = {
		getSessionName: () => "",
		setSessionName: () => {},
		registerCommand: (name: string, options: any) => { commands[name] = options; },
		registerShortcut: (key: string, options: any) => { shortcuts[key] = options; },
		on: (name: string, handler: any) => { handlers[name] = handler; },
	};
	const ctx: any = {
		cwd: "/tmp",
		hasUI: true,
		mode: options.mode ?? "tui",
		isIdle: () => true,
		model: options.model,
		ui: {
			setWidget: (_key: string, lines: string[] | undefined) => { widget = lines ?? []; },
			notify: (message: unknown) => { notifications.push(String(message)); },
			theme: { fg: (_token: string, text: string) => text },
		},
		sessionManager: {
			getSessionId: () => logicalSessionId,
			getBranch: () => options.branch ?? [{ type: "message", message: { role: "user", content: [{ type: "text", text: "timer cleanup" }] } }],
		},
		modelRegistry: options.modelRegistry ?? { getAvailable: () => [], find: () => undefined, hasConfiguredAuth: () => false },
	};
	await (extension as any)(pi, { runtimeFactory: sdkRuntimeFactory });
	await handlers.session_start({ reason: "startup" }, ctx);
	return { handlers, commands, shortcuts, ctx, widget: () => widget, notifications: () => notifications };
}

function openTestDb() {
	return new DatabaseSync(`${agentDir}/kaomoji-english-tutor.db`);
}

function insertSentence(db: DatabaseSync) {
	const levels = [
		"The extension clears resources.",
		"The extension clears resources during shutdown.",
		"Because the extension owns runtime resources, it clears them during shutdown to prevent duplicate callbacks.",
	];
	db.prepare(
		"INSERT INTO items(type,text,meaning,learned_at,due_at,levels,levels_cn,chunks,key_words) VALUES('sentence',?,?,?,?,?,?,?,?)",
	).run(
		levels[2],
		"完整翻译",
		new Date().toISOString(),
		new Date(0).toISOString(),
		JSON.stringify(levels),
		JSON.stringify(["一级", "二级", "三级"]),
		JSON.stringify(["Because the extension", "owns resources", "during shutdown"]),
		JSON.stringify([{ text: "runtime", meaning: "运行时" }, { text: "callback", meaning: "回调" }]),
	);
}

test("time-only lifecycle pauses for pending cards and restarts after rating", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		const harness = await createHarness();
		assert.equal(harness.handlers.agent_end, undefined);
		assert.equal(fake.active().length, 1);
		assert.equal(fake.active()[0].delay, 600_000);
		assert.equal(fake.poll().length, 1);
		const db = openTestDb();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at) VALUES('word','timer','定时器',?,?)")
			.run(new Date().toISOString(), new Date(0).toISOString());
		db.close();
		await fake.fire();
		assert.match(harness.widget().join(" "), /定时器/);
		assert.doesNotMatch(harness.widget().join(" "), /timer/, "new-card front hides the target word");
		assert.match(harness.widget().join(" "), /连续学习 1 天.*今日剩余卡片（复习 1）/);
		assert.match(harness.widget().join(" "), /\/anki:flip/);
		assert.equal(harness.shortcuts["ctrl+alt+k"], undefined);
		assert.equal(fake.active().length, 0);
		const check = openTestDb();
		const shown = check.prepare("SELECT shown,reviews,fsrs_state FROM items WHERE id=1").get() as any;
		check.close();
		assert.deepEqual({ ...shown }, { shown: 1, reviews: 0, fsrs_state: "" });
		await harness.commands["anki:good"].handler("", harness.ctx);
		assert.equal(fake.active().length, 1);
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
		assert.equal(fake.active().length, 0);
		assert.equal(fake.poll().length, 0);
	} finally {
		fake.restore();
	}
});

test("first-showing word and phrase cards accept active-recall answers", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 0 });
		const harness = await createHarness();
		const db = openTestDb();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at) VALUES('word','condition','（判断）条件',?,?)")
			.run(new Date().toISOString(), new Date(0).toISOString());
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at) VALUES('phrase','take effect','生效',?,?)")
			.run(new Date().toISOString(), new Date(0).toISOString());
		db.close();

		await fake.fire();
		const wordFace = harness.widget().join(" ");
		assert.match(wordFace, /复习时间到.*默写单词.*条件/);
		assert.doesNotMatch(wordFace, /condition/, "first-showing question must not leak the target word");
		let check = openTestDb();
		const claimedWord = check.prepare("SELECT active_item_id,active_kind FROM runtime_state WHERE id=1").get() as any;
		check.close();
		assert.deepEqual({ ...claimedWord }, { active_item_id: 1, active_kind: "teach" }, "teach remains first-showing provenance");

		await harness.commands["anki:answer"].handler("condition", harness.ctx);
		check = openTestDb();
		assert.equal(check.prepare("SELECT verdict FROM attempts WHERE item_id=1").get()?.verdict, "correct");
		check.close();
		const phraseFace = harness.widget().join(" ");
		assert.match(phraseFace, /复习时间到.*默写词组.*生效/);
		assert.doesNotMatch(phraseFace, /take effect/, "first-showing question must not leak the target phrase");

		await harness.commands["anki:flip"].handler("", harness.ctx);
		assert.match(harness.widget().join(" "), /take effect.*生效/);
		await harness.commands["anki:answer"].handler("take effect", harness.ctx);
		assert.match(harness.widget().join(" "), /答对了.*翻了答案，按忘记安排/);

		check = openTestDb();
		const items = check.prepare("SELECT id,reviews FROM items ORDER BY id").all().map((row: any) => ({ ...row }));
		const attempts = check.prepare(
			"SELECT item_id,answer_text,assistance_level,status,verdict,explicit_rating FROM attempts ORDER BY item_id",
		).all().map((row: any) => ({ ...row }));
		const state = check.prepare("SELECT active_item_id,active_kind FROM runtime_state WHERE id=1").get() as any;
		check.close();
		assert.deepEqual(items, [{ id: 1, reviews: 1 }, { id: 2, reviews: 1 }]);
		assert.deepEqual(attempts, [
			{ item_id: 1, answer_text: "condition", assistance_level: "none", status: "evaluated", verdict: "correct", explicit_rating: "good" },
			{ item_id: 2, answer_text: "take effect", assistance_level: "revealed", status: "evaluated", verdict: "correct", explicit_rating: "again" },
		]);
		assert.deepEqual({ ...state }, { active_item_id: null, active_kind: null });
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("progressive sentence requires written output and touches FSRS only after L3", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		const harness = await createHarness();
		const db = openTestDb(); insertSentence(db); db.close();
		await fake.fire();
		assert.match(harness.widget().join(" "), /句子输出（L1\/3）/);
		await harness.commands["anki:good"].handler("", harness.ctx);
		let check = openTestDb();
		let row = check.prepare("SELECT progress,reviews FROM items WHERE id=1").get() as any;
		check.close();
		assert.deepEqual({ ...row }, { progress: 0, reviews: 0 }, "manual Good cannot bypass sentence output");

		await harness.commands["anki:answer"].handler("extension", harness.ctx);
		await harness.commands["anki:answer"].handler("The extension clears resources during shutdown.", harness.ctx);
		check = openTestDb();
		row = check.prepare("SELECT progress,reviews,fsrs_state FROM items WHERE id=1").get() as any;
		check.close();
		assert.deepEqual({ ...row }, { progress: 2, reviews: 0, fsrs_state: "" });

		await harness.commands["anki:answer"].handler("Because the extension owns runtime resources, it clears them during shutdown to prevent duplicate callbacks.", harness.ctx);
		assert.match(harness.widget().join(" "), /独立写对了/);
		check = openTestDb();
		row = check.prepare("SELECT progress,reviews,fsrs_state FROM items WHERE id=1").get() as any;
		const attempts = Number((check.prepare("SELECT COUNT(*) AS n FROM attempts WHERE item_id=1").get() as any).n);
		check.close();
		assert.equal(row.progress, 2);
		assert.equal(row.reviews, 1);
		assert.equal(JSON.parse(row.fsrs_state).reps, 1);
		assert.equal(attempts, 3);
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("manual Again ends sentence output once and resets it to L1", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		const harness = await createHarness();
		const db = openTestDb(); insertSentence(db); db.close();
		await fake.fire();
		await harness.commands["anki:answer"].handler("extension", harness.ctx);
		await harness.commands["anki:answer"].handler("The extension clears resources during shutdown.", harness.ctx);
		assert.match(harness.widget().join(" "), /L3\/3/);

		await harness.commands["anki:again"].handler("", harness.ctx);

		const check = openTestDb();
		const row = check.prepare("SELECT progress,reviews,fsrs_state FROM items WHERE id=1").get() as any;
		const runtime = check.prepare("SELECT active_item_id,active_review_cycle_id FROM runtime_state WHERE id=1").get() as any;
		check.close();
		assert.equal(row.progress, 0);
		assert.equal(row.reviews, 1);
		assert.equal(JSON.parse(row.fsrs_state).reps, 1);
		assert.equal(runtime.active_item_id, null);
		assert.equal(runtime.active_review_cycle_id, null);
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("sentence correction retries stay on the level and final FSRS uses the first recall", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-sentence-eval-faux" });
	try {
		registration.setResponses([
			fauxAssistantMessage(JSON.stringify({
				verdict: "partial",
				feedback: "主谓一致需要 clears",
				errorTags: ["grammar"],
				correctedAnswer: "The extension clears resources during shutdown.",
			})),
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 0 });
		const harness = await makeSession({ model, modelRegistry: registry, sessionId: "sentence-retry" });
		const db = openTestDb(); insertSentence(db); db.close();
		await fake.fire();
		await harness.commands["anki:answer"].handler("extension", harness.ctx);
		await harness.commands["anki:answer"].handler("The extension clear resources during shutdown.", harness.ctx);
		assert.match(harness.widget().join(" "), /差一点.*主谓一致/);
		const reattached = await makeSession({ model, modelRegistry: registry, sessionId: "sentence-retry-reattached" });
		assert.match(reattached.widget().join(" "), /差一点.*主谓一致/, "SQLite reattachment preserves corrective teaching");

		let check = openTestDb();
		let state = check.prepare("SELECT active_cycle_outcome,active_retry_count,active_assistance_level FROM runtime_state WHERE id=1").get() as any;
		let row = check.prepare("SELECT progress,reviews FROM items WHERE id=1").get() as any;
		check.close();
		assert.deepEqual({ ...row }, { progress: 1, reviews: 0 });
		assert.deepEqual({ ...state }, { active_cycle_outcome: "again", active_retry_count: 1, active_assistance_level: "hint" });

		await harness.commands["anki:answer"].handler("The extension clears resources during shutdown.", harness.ctx);
		await harness.commands["anki:answer"].handler("Because the extension owns runtime resources, it clears them during shutdown to prevent duplicate callbacks.", harness.ctx);
		assert.match(harness.widget().join(" "), /首次回忆有辅助或错误/);
		check = openTestDb();
		row = check.prepare("SELECT progress,reviews,fsrs_state FROM items WHERE id=1").get() as any;
		const attempts = check.prepare("SELECT verdict,explicit_rating,assistance_level,error_tags_json FROM attempts WHERE item_id=1 ORDER BY started_at,id").all() as any[];
		state = check.prepare("SELECT active_item_id,active_review_cycle_id FROM runtime_state WHERE id=1").get() as any;
		check.close();
		assert.equal(row.progress, 0);
		assert.equal(row.reviews, 1);
		assert.equal(JSON.parse(row.fsrs_state).reps, 1);
		assert.equal(attempts.length, 4);
		assert.equal(attempts.filter((attempt) => attempt.explicit_rating === "again").length, 1);
		assert.ok(attempts.some((attempt) => attempt.verdict === "partial" && /grammar/.test(attempt.error_tags_json)));
		assert.deepEqual({ ...state }, { active_item_id: null, active_review_cycle_id: null });
		await reattached.handlers.session_shutdown({ reason: "quit" }, reattached.ctx);
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		registration.unregister();
		fake.restore();
	}
});

test("answer shows a thinking animation while sentence evaluation is pending", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-answer-thinking" });
	let releaseResponse!: () => void;
	let responseStarted!: () => void;
	const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
	const started = new Promise<void>((resolve) => { responseStarted = resolve; });
	try {
		registration.setResponses([
			async () => {
				responseStarted();
				await responseGate;
				return fauxAssistantMessage(JSON.stringify({
					verdict: "correct",
					feedback: "",
					errorTags: [],
					correctedAnswer: "The extension clears resources during shutdown.",
				}));
			},
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 0 });
		const harness = await makeSession({ model, modelRegistry: registry, sessionId: "answer-thinking" });
		const db = openTestDb(); insertSentence(db); db.close();
		await fake.fire();
		await harness.commands["anki:answer"].handler("extension", harness.ctx);
		const inFlight = harness.commands["anki:answer"].handler("The extension cleans resources during shutdown.", harness.ctx);
		await started;
		assert.match(harness.widget().join(" "), /⠋ 正在判断你的答案/);
		releaseResponse();
		await inFlight;
		assert.doesNotMatch(harness.widget().join(" "), /正在判断你的答案/, "animation stops after evaluation");
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		releaseResponse?.();
		registration.unregister();
		fake.restore();
	}
});

test("answer judging keeps the card visible and ignores cross-session repaints", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-answer-flicker" });
	let releaseResponse!: () => void;
	let responseStarted!: () => void;
	const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
	const started = new Promise<void>((resolve) => { responseStarted = resolve; });
	try {
		registration.setResponses([
			async () => {
				responseStarted();
				await responseGate;
				return fauxAssistantMessage(JSON.stringify({ verdict: "partial", feedback: "拼写差一点" }));
			},
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 0 });
		const harness = await makeSession({ model, modelRegistry: registry, sessionId: "answer-flicker" });
		const db = openTestDb();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown) VALUES('word','condition','（判断）条件',?,?,1)")
			.run(new Date().toISOString(), new Date(0).toISOString());
		db.close();
		await fake.fire(); // claim + render the review question
		const cardLines = harness.widget();
		assert.match(cardLines.join(" "), /复习时间到/);
		const inFlight = harness.commands["anki:answer"].handler("conditon", harness.ctx);
		await started;
		const judging = harness.widget();
		assert.match(judging.join(" "), /正在判断你的答案/);
		assert.equal(judging.length, cardLines.length + 1, "spinner overlays the card instead of replacing it");
		for (const line of cardLines) assert.ok(judging.includes(line), `card line preserved during judging: ${line}`);
		// Another session commits to the shared DB; the sync poll must not repaint over the animation.
		const external = openTestDb();
		external.prepare("UPDATE items SET learned_at = learned_at WHERE id = 1").run();
		external.close();
		await fake.firePoll();
		const afterPoll = harness.widget();
		assert.equal(afterPoll.length, judging.length, "poll repaint cannot change widget height during judging");
		assert.match(afterPoll.join(" "), /正在判断你的答案/);
		releaseResponse();
		await inFlight;
		assert.doesNotMatch(harness.widget().join(" "), /正在判断你的答案/, "animation stops after evaluation");
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		releaseResponse?.();
		registration.unregister();
		fake.restore();
	}
});

function insertClozeCard(db: DatabaseSync, shown: 0 | 1 = 0) {
	db.prepare(
		"INSERT INTO items(type,text,phonetic,meaning,example,example_cn,chunks,learned_at,due_at,shown) VALUES('cloze',?,NULL,?,?,?,?,?,?,?)",
	).run(
		"The fix that ___ (commit) this morning won't take effect until you reload.",
		"was committed",
		"The fix that was committed this morning won't take effect until you reload.",
		"今早提交的修复要等你重载后才生效。（考点：that 从句修饰单数主语 document，需用 was committed）",
		JSON.stringify(["The fix", "that was committed this morning", "won't take effect", "until you reload"]),
		new Date().toISOString(),
		new Date(0).toISOString(),
		shown,
	);
}

function makeClozeDue() {
	const db = openTestDb();
	db.prepare("UPDATE items SET due_at = ? WHERE type = 'cloze'").run(new Date(0).toISOString());
	db.prepare("UPDATE runtime_state SET next_check_at = ? WHERE id = 1").run(new Date(0).toISOString());
	db.close();
}

test("cloze lifecycle: teach face, review answer, exact match, and LLM partial", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-cloze-life" });
	try {
		// One evaluator call for the near-miss answer at the end of the test.
		registration.setResponses([
			fauxAssistantMessage(JSON.stringify({ verdict: "partial", feedback: "少了 was：应为被动语态。" })),
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 0 });
		const harness = await makeSession({ model, modelRegistry: registry, sessionId: "cloze-life" });
		const db = openTestDb();
		insertClozeCard(db);
		db.close();
		await fake.fire();
		// First showing is already the quiz face: blank + lemma hint, no answer,
		// no Chinese gloss/grammar note (they would name the answer form).
		const first = harness.widget().join(" ");
		assert.match(first, /语法填空/);
		assert.match(first, /The fix that ___ \(commit\) this morning/);
		assert.doesNotMatch(first, /was committed/, "first showing must not leak the answer");
		assert.doesNotMatch(first, /句意|考点/, "first showing hides the gloss and grammar note");
		// First attempt is graded immediately (exact local match -> Good).
		await harness.commands["anki:answer"].handler("was committed", harness.ctx);
		assert.match(harness.widget().join(" "), /答对了/);
		let check = openTestDb();
		const afterFirst = check.prepare("SELECT reviews, due_at FROM items WHERE id = 1").get() as any;
		const directions = (check.prepare("SELECT COUNT(*) AS n FROM direction_state WHERE item_id = 1").get() as any).n;
		check.close();
		assert.equal(afterFirst.reviews, 1, "first attempt rates the card once");
		assert.ok(new Date(afterFirst.due_at).getTime() > Date.now(), "rated into the future");
		assert.equal(directions, 0, "cloze keeps a single-direction FSRS state");

		// Review question face: only the blanked sentence; the Chinese gloss and
		// grammar note (which can name the answer form) stay on the answer face.
		makeClozeDue();
		await fake.fire();
		const review = harness.widget().join(" ");
		assert.match(review, /___/);
		assert.doesNotMatch(review, /句意|考点/, "question face shows no Chinese gloss or grammar note");
		assert.doesNotMatch(review, /was committed/, "review face must not leak the answer");
		// Hint masks the answer with first letters and word lengths.
		await harness.commands["anki:hint"].handler("", harness.ctx);
		assert.ok(harness.notifications().some((message) => /提示：w__ c_{8}/.test(message)), "hint masks the answer");
		// Exact local match (case/punctuation tolerant) skips the LLM entirely.
		await harness.commands["anki:answer"].handler("Was  COMMITTED.", harness.ctx);
		assert.match(harness.widget().join(" "), /答对了/);
		check = openTestDb();
		const exact = check.prepare("SELECT verdict, kind, direction, question_text FROM attempts WHERE item_id = 1 ORDER BY completed_at DESC LIMIT 1").get() as any;
		check.close();
		assert.equal(exact.verdict, "correct");
		assert.equal(exact.kind, "recall");
		assert.equal(exact.direction, "forward");
		assert.equal(exact.question_text, "语法填空：The fix that ___ (commit) this morning won't take effect until you reload.");

		// A near-miss form goes to the strict LLM rubric → partial → Again with the correction.
		makeClozeDue();
		await fake.fire();
		await harness.commands["anki:answer"].handler("was commit", harness.ctx);
		const partial = harness.widget().join(" ");
		assert.match(partial, /差一点/);
		assert.match(partial, /正确：was committed/);
		check = openTestDb();
		const nearMiss = check.prepare("SELECT verdict FROM attempts WHERE item_id = 1 ORDER BY completed_at DESC LIMIT 1").get() as any;
		check.close();
		assert.equal(nearMiss.verdict, "partial");
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		registration.unregister();
		fake.restore();
	}
});

test("sentence spelling feedback highlights the changed letter order", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-spelling-diff" });
	try {
		registration.setResponses([
			fauxAssistantMessage(JSON.stringify({
				verdict: "partial",
				feedback: "拼写错误：claers 应为 clears。",
				errorTags: ["spelling"],
				correctedAnswer: "The extension clears resources during shutdown.",
			})),
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 0 });
		const harness = await makeSession({ model, modelRegistry: registry, sessionId: "spelling-diff" });
		const db = openTestDb(); insertSentence(db); db.close();
		await fake.fire();
		await harness.commands["anki:answer"].handler("extension", harness.ctx);
		await harness.commands["anki:answer"].handler("The extension claers resources during shutdown.", harness.ctx);
		assert.match(harness.widget().join(" "), /拼写对比：cl\[ae\]rs → cl\[ea\]rs/);
		const reattached = await makeSession({ model, modelRegistry: registry, sessionId: "spelling-diff-reattached" });
		assert.match(reattached.widget().join(" "), /拼写对比：cl\[ae\]rs → cl\[ea\]rs/, "highlight survives SQLite reattachment");
		await reattached.handlers.session_shutdown({ reason: "quit" }, reattached.ctx);
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		registration.unregister();
		fake.restore();
	}
});

test("a natural L3 variant accepted by the SDK evaluator completes as Good", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-sentence-variant-faux" });
	try {
		registration.setResponses([
			fauxAssistantMessage(JSON.stringify({
				verdict: "correct",
				feedback: "表达自然",
				errorTags: [],
				correctedAnswer: "Since it owns the runtime, the extension cleans up during shutdown so callbacks are not registered twice.",
			})),
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 0 });
		const harness = await makeSession({ model, modelRegistry: registry, sessionId: "sentence-variant" });
		const db = openTestDb();
		insertSentence(db);
		db.prepare("UPDATE items SET progress=2, shown=1 WHERE id=1").run();
		db.close();
		await fake.fire();
		await harness.commands["anki:answer"].handler("Since it owns the runtime, the extension cleans up during shutdown so callbacks aren't registered twice.", harness.ctx);
		const check = openTestDb();
		const item = check.prepare("SELECT progress,reviews FROM items WHERE id=1").get() as any;
		const attempt = check.prepare("SELECT verdict,explicit_rating,kind FROM attempts WHERE item_id=1").get() as any;
		check.close();
		assert.deepEqual({ ...item }, { progress: 2, reviews: 1 });
		assert.deepEqual({ ...attempt }, { verdict: "correct", explicit_rating: "good", kind: "sentence_production" });
		assert.equal(registration.state.callCount, 1);
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		registration.unregister();
		fake.restore();
	}
});

test("sentence hint survives reattachment and prevents a clean Good", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 0 });
		const a = await makeSession({ sessionId: "sentence-hint-a" });
		const db = openTestDb(); insertSentence(db); db.close();
		await fake.fire();
		await a.commands["anki:hint"].handler("", a.ctx);
		const before = openTestDb();
		const cycleId = String((before.prepare("SELECT active_review_cycle_id FROM runtime_state WHERE id=1").get() as any).active_review_cycle_id);
		before.close();
		await a.handlers.session_shutdown({ reason: "quit" }, a.ctx);

		const b = await makeSession({ sessionId: "sentence-hint-b" });
		await b.commands["anki:answer"].handler("extension", b.ctx);
		await b.commands["anki:answer"].handler("The extension clears resources during shutdown.", b.ctx);
		await b.commands["anki:answer"].handler("Because the extension owns runtime resources, it clears them during shutdown to prevent duplicate callbacks.", b.ctx);
		const check = openTestDb();
		const rated = check.prepare("SELECT explicit_rating FROM attempts WHERE review_cycle_id=? AND explicit_rating IS NOT NULL").get(cycleId) as any;
		const mastery = check.prepare("SELECT unassisted_good,consecutive_again FROM mastery_state WHERE item_id=1").get() as any;
		check.close();
		assert.equal(rated.explicit_rating, "again");
		assert.deepEqual({ ...mastery }, { unassisted_good: 0, consecutive_again: 1 });
		await b.handlers.session_shutdown({ reason: "quit" }, b.ctx);
	} finally {
		fake.restore();
	}
});

test("sentence evaluator unavailability keeps the card pending with zero attempt writes", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		const harness = await createHarness();
		const db = openTestDb(); insertSentence(db); db.close();
		await fake.fire();
		const before = openTestDb();
		const version = Number((before.prepare("SELECT active_version FROM runtime_state WHERE id=1").get() as any).active_version);
		before.close();
		await harness.commands["anki:answer"].handler("wrong", harness.ctx);
		const check = openTestDb();
		const state = check.prepare("SELECT active_item_id,active_version FROM runtime_state WHERE id=1").get() as any;
		const attempts = Number((check.prepare("SELECT COUNT(*) AS n FROM attempts").get() as any).n);
		const reviews = Number((check.prepare("SELECT reviews FROM items WHERE id=1").get() as any).reviews);
		check.close();
		assert.deepEqual({ ...state }, { active_item_id: 1, active_version: version });
		assert.equal(attempts, 0);
		assert.equal(reviews, 0);
		assert.ok(harness.notifications().some((message) => /没有记录成绩/.test(message)));
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("consecutive skips preserve FIFO replacement obligations", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		const harness = await createHarness();
		const db = openTestDb();
		const insert = db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at) VALUES(?,?,?,?,?)");
		insert.run("word", "timer", "定时器", new Date().toISOString(), new Date(0).toISOString());
		insert.run("phrase", "clear a timer", "清除定时器", new Date().toISOString(), new Date(0).toISOString());
		db.close();
		await fake.fire();
		await harness.commands["anki:skip"].handler("", harness.ctx);
		await fake.fire();
		assert.match(harness.widget().join(" "), /清除定时器/, "queued new card surfaces after deferred replacement generation");
		assert.doesNotMatch(harness.widget().join(" "), /clear a timer/, "queued new card hides the target phrase");
		await harness.commands["anki:skip"].handler("", harness.ctx);
		const check = openTestDb();
		const raw = (check.prepare("SELECT value FROM stats WHERE key='pending_replacements'").get() as any).value;
		const statuses = check.prepare("SELECT status FROM items ORDER BY id").all() as Array<{ status: string }>;
		check.close();
		assert.deepEqual(JSON.parse(raw), ["word", "phrase"]);
		assert.deepEqual(statuses.map((row) => row.status), ["mastered", "mastered"]);
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("a due review is activated before any replacement LLM call", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-replacement-priority" });
	let llmCalls = 0;
	try {
		registration.setResponses([async () => {
			llmCalls++;
			return fauxAssistantMessage(JSON.stringify({ ready: false, reason: "unused" }));
		}]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 3 });
		const harness = await makeSession({ model, modelRegistry: registry, sessionId: "replacement-priority" });
		const db = openTestDb();
		const now = new Date().toISOString();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown) VALUES('word','known','熟词',?,?,1)")
			.run(now, new Date(Date.now() + 86_400_000).toISOString());
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown) VALUES('word','due','到期',?,?,1)")
			.run(now, new Date(0).toISOString());
		db.prepare("UPDATE runtime_state SET active_item_id=1, active_kind='review', active_version=1, next_check_at=? WHERE id=1")
			.run(new Date(0).toISOString());
		db.close();
		await harness.commands["anki:skip"].handler("", harness.ctx);
		const check = openTestDb();
		const state = check.prepare("SELECT active_item_id FROM runtime_state WHERE id=1").get() as any;
		const queue = JSON.parse(String((check.prepare("SELECT value FROM stats WHERE key='pending_replacements'").get() as any).value));
		check.close();
		assert.equal(state.active_item_id, 2);
		assert.equal(llmCalls, 0, "due review must not wait for replacement generation");
		assert.deepEqual(queue, ["word"], "replacement obligation stays queued");
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		registration.unregister();
		fake.restore();
	}
});

test("skipping a legacy sentence card replaces it with a cloze card", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-skip-map" });
	try {
		registration.setResponses([
			fauxAssistantMessage(JSON.stringify({
				ready: true,
				item: {
					type: "cloze",
					text: "The hotfix that ___ (push) to production yesterday broke the build pipeline again.",
					meaning: "was pushed",
					example: "The hotfix that was pushed to production yesterday broke the build pipeline again.",
					example_cn: "昨天推到生产的那个热修又把构建流水线搞坏了。（考点：被动语态）",
					chunks: ["The hotfix", "that was pushed to production yesterday", "broke the build pipeline again"],
				},
			})),
			fauxAssistantMessage(JSON.stringify({ pass: true, issues: [], summary: "approved" })),
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 0 });
		const harness = await makeSession({ model, modelRegistry: registry, sessionId: "skip-map" });
		const db = openTestDb();
		insertSentence(db);
		db.close();
		await fake.fire();
		assert.match(harness.widget().join(" "), /句子输出（L1\/3）/, "legacy sentence card still surfaces normally");
		await harness.commands["anki:skip"].handler("", harness.ctx);
		await fake.flush();
		assert.match(harness.widget().join(" "), /语法填空/, "replacement cloze card is shown");
		const check = openTestDb();
		const items = check.prepare("SELECT type, text, status, introduction_kind FROM items ORDER BY id").all() as any[];
		const queue = JSON.parse(String((check.prepare("SELECT value FROM stats WHERE key='pending_replacements'" ).get() as any).value));
		const genLog = String((check.prepare("SELECT value FROM stats WHERE key='gen_log'").get() as any)?.value ?? "");
		check.close();
		assert.equal(items.length, 2, "skipped sentence plus one replacement");
		assert.equal(items[0].status, "mastered");
		assert.equal(items[1].type, "cloze", "legacy sentence replacement generates a cloze card");
		assert.match(items[1].text, /^The hotfix that ___ \(push\)/);
		assert.equal(items[1].introduction_kind, "replacement");
		assert.deepEqual(queue, [], "FIFO obligation consumed");
		assert.match(genLog, /replacement_mapped: sentence→cloze/, "mapping is recorded in the gen log");
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		registration.unregister();
		fake.restore();
	}
});

test("successful replacement is one-for-one, critic-approved, and quota-free", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-replacement-ready" });
	try {
		registration.setResponses([
			fauxAssistantMessage(JSON.stringify({
				ready: true,
				item: { type: "word", text: "deadline", phonetic: "/ˈdedlaɪn/", meaning: "截止时间（名词，义项线索）", example: "The deadline is tomorrow.", example_cn: "截止时间是明天。" },
			})),
			fauxAssistantMessage(JSON.stringify({ pass: true, issues: [], summary: "approved" })),
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 1 });
		const harness = await makeSession({ model, modelRegistry: registry, sessionId: "replacement-ready" });
		const db = openTestDb();
		insertDueWord(db, "timer", "定时器");
		db.close();
		await fake.fire();
		await harness.commands["anki:skip"].handler("", harness.ctx);
		const check = openTestDb();
		const items = check.prepare("SELECT text,shown,status,introduction_kind,introduced_at FROM items ORDER BY id").all() as any[];
		const queue = JSON.parse(String((check.prepare("SELECT value FROM stats WHERE key='pending_replacements'").get() as any).value));
		const plannedToday = Number((check.prepare("SELECT COUNT(*) AS n FROM items WHERE introduction_kind='planned' AND introduced_at IS NOT NULL").get() as any).n);
		const active = check.prepare("SELECT active_item_id FROM runtime_state WHERE id=1").get() as any;
		check.close();
		assert.equal(items.length, 2, "one skipped card creates exactly one replacement");
		assert.deepEqual(
			{ text: items[1].text, shown: items[1].shown, kind: items[1].introduction_kind, introduced: Boolean(items[1].introduced_at) },
			{ text: "deadline", shown: 1, kind: "replacement", introduced: true },
		);
		assert.equal(plannedToday, 1, "replacement does not consume planned quota");
		assert.deepEqual(queue, [], "FIFO obligation is consumed only after insertion");
		assert.equal(active.active_item_id, 2);
		assert.equal(registration.state.callCount, 2, "replacement generator and independent critic both ran");
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		registration.unregister();
		fake.restore();
	}
});

test("replacement critic rejection preserves the FIFO obligation and inserts nothing", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-replacement-reject" });
	try {
		registration.setResponses([
			fauxAssistantMessage(JSON.stringify({
				ready: true,
				item: { type: "word", text: "deadline", phonetic: "", meaning: "截止时间（名词，义项线索）", example: "The deadline is tomorrow.", example_cn: "截止时间是明天。" },
			})),
			fauxAssistantMessage(JSON.stringify({ pass: false, issues: [{ severity: "blocker", category: "natural", description: "reject" }], summary: "rejected" })),
			// Basic-vocabulary fallback round: also rejected, queue still preserved.
			fauxAssistantMessage(JSON.stringify({
				ready: true,
				item: { type: "word", text: "morning", phonetic: "", meaning: "早晨（名词，义项线索）", example: "Good morning.", example_cn: "早上好。" },
			})),
			fauxAssistantMessage(JSON.stringify({ pass: false, issues: [{ severity: "blocker", category: "natural", description: "reject" }], summary: "rejected" })),
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 3 });
		const harness = await makeSession({ model, modelRegistry: registry, sessionId: "replacement-reject" });
		const db = openTestDb(); insertDueWord(db, "timer", "定时器"); db.close();
		await fake.fire();
		await harness.commands["anki:skip"].handler("", harness.ctx);
		const check = openTestDb();
		const count = Number((check.prepare("SELECT COUNT(*) AS n FROM items").get() as any).n);
		const queue = JSON.parse(String((check.prepare("SELECT value FROM stats WHERE key='pending_replacements'").get() as any).value));
		const active = check.prepare("SELECT active_item_id FROM runtime_state WHERE id=1").get() as any;
		check.close();
		assert.equal(registration.state.callCount, 4);
		assert.equal(count, 1);
		assert.deepEqual(queue, ["word"]);
		assert.equal(active.active_item_id, null);
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		registration.unregister();
		fake.restore();
	}
});

test("conversation changes during replacement critique make the result stale", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-replacement-conversation-stale" });
	let releaseCritic!: () => void;
	let criticStarted!: () => void;
	const gate = new Promise<void>((resolve) => { releaseCritic = resolve; });
	const started = new Promise<void>((resolve) => { criticStarted = resolve; });
	try {
		registration.setResponses([
			fauxAssistantMessage(JSON.stringify({
				ready: true,
				item: { type: "word", text: "deadline", phonetic: "", meaning: "截止时间（名词，义项线索）", example: "The deadline is tomorrow.", example_cn: "截止时间是明天。" },
			})),
			async () => { criticStarted(); await gate; return fauxAssistantMessage(JSON.stringify({ pass: true, issues: [], summary: "ok" })); },
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 3 });
		const harness = await makeSession({ model, modelRegistry: registry, sessionId: "replacement-conversation-stale" });
		let conversation = "old topic";
		harness.ctx.sessionManager.getBranch = () => [{ type: "message", message: { role: "user", content: [{ type: "text", text: conversation }] } }];
		const db = openTestDb(); insertDueWord(db, "timer", "定时器"); db.close();
		await fake.fire();
		const inFlight = harness.commands["anki:skip"].handler("", harness.ctx);
		await started;
		conversation = "new topic";
		releaseCritic();
		await inFlight;
		const check = openTestDb();
		const count = Number((check.prepare("SELECT COUNT(*) AS n FROM items").get() as any).n);
		const queue = JSON.parse(String((check.prepare("SELECT value FROM stats WHERE key='pending_replacements'").get() as any).value));
		check.close();
		assert.equal(count, 1, "stale critic result inserts no replacement");
		assert.deepEqual(queue, ["word"], "stale result cannot consume the FIFO obligation");
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		releaseCritic?.();
		registration.unregister();
		fake.restore();
	}
});

test("successful refill clears stale future pacing and shows a newly due review before inventory", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-replacement-late-due" });
	let releaseCritic!: () => void;
	let criticStarted!: () => void;
	const gate = new Promise<void>((resolve) => { releaseCritic = resolve; });
	const started = new Promise<void>((resolve) => { criticStarted = resolve; });
	try {
		registration.setResponses([
			fauxAssistantMessage(JSON.stringify({
				ready: true,
				item: { type: "word", text: "deadline", phonetic: "", meaning: "截止时间（名词，义项线索）", example: "The deadline is tomorrow.", example_cn: "截止时间是明天。" },
			})),
			async () => { criticStarted(); await gate; return fauxAssistantMessage(JSON.stringify({ pass: true, issues: [], summary: "ok" })); },
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 3 });
		const harness = await makeSession({ model, modelRegistry: registry, sessionId: "replacement-late-due" });
		const db = openTestDb(); insertDueWord(db, "timer", "定时器"); db.close();
		await fake.fire();
		const inFlight = harness.commands["anki:skip"].handler("", harness.ctx);
		await started;
		const during = openTestDb();
		during.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown) VALUES('word','overdue','已到期',?,?,1)")
			.run(new Date().toISOString(), new Date(0).toISOString());
		during.prepare("UPDATE runtime_state SET next_check_at=? WHERE id=1")
			.run(new Date(Date.now() + 600_000).toISOString());
		during.close();
		releaseCritic();
		await inFlight;
		const check = openTestDb();
		const count = Number((check.prepare("SELECT COUNT(*) AS n FROM items").get() as any).n);
		const queue = JSON.parse(String((check.prepare("SELECT value FROM stats WHERE key='pending_replacements'").get() as any).value));
		const active = check.prepare("SELECT active_item_id FROM runtime_state WHERE id=1").get() as any;
		check.close();
		assert.equal(count, 3, "replacement is stored while due review keeps priority");
		assert.deepEqual(queue, []);
		assert.equal(active.active_item_id, 2, "old failed-teach pacing must not leave the screen empty");
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		releaseCritic?.();
		registration.unregister();
		fake.restore();
	}
});

test("skip mastering rolls back when replacement enqueue fails", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		const harness = await createHarness();
		const db = openTestDb();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at) VALUES('word','timer','定时器',?,?)")
			.run(new Date().toISOString(), new Date(0).toISOString());
		db.exec(`
			CREATE TRIGGER reject_replacement_queue
			BEFORE INSERT ON stats
			WHEN NEW.key = 'pending_replacements'
			BEGIN
				SELECT RAISE(ABORT, 'queue write failed');
			END;
		`);
		db.close();
		await fake.fire();
		await harness.commands["anki:skip"].handler("", harness.ctx);
		const check = openTestDb();
		const item = check.prepare("SELECT status,fsrs_state FROM items WHERE id=1").get() as any;
		const skippedStat = check.prepare("SELECT value FROM stats WHERE key='total_skipped'").get();
		check.close();
		assert.equal(item.status, "learning");
		assert.equal(item.fsrs_state, "");
		assert.equal(skippedStat, undefined);
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("stale replacement completion cannot mutate a new session", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		let resolveAuth!: (value: { ok: false; error: string }) => void;
		const auth = new Promise<{ ok: false; error: string }>((resolve) => { resolveAuth = resolve; });
		let authStarted = false;
		const model = { provider: "fake", id: "deepseek-v4-flash" };
		const modelRegistry = {
			getAvailable: () => [model],
			find: (provider: string, id: string) => provider === model.provider && id === model.id ? model : undefined,
			hasConfiguredAuth: () => true,
			getApiKeyAndHeaders: () => { authStarted = true; return auth; },
		};
		const harness = await createHarness({ model, modelRegistry });
		const db = openTestDb();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown,status) VALUES('word','old','旧词',?,?,1,'mastered')")
			.run(new Date().toISOString(), new Date(Date.now() + 86_400_000).toISOString());
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at) VALUES('phrase','new session card','新会话卡片',?,?)")
			.run(new Date().toISOString(), new Date(0).toISOString());
		db.prepare("INSERT INTO stats(key,value) VALUES('pending_replacements','[\"word\"]')").run();
		db.close();
		await fake.fire();
		assert.equal(authStarted, true);
		await harness.handlers.session_shutdown({ reason: "reload" }, harness.ctx);
		await harness.handlers.session_start({ reason: "reload" }, harness.ctx);
		assert.equal(fake.active().length, 1);
		resolveAuth({ ok: false, error: "cancelled old session" });
		await fake.flush();
		await fake.flush();
		const check = openTestDb();
		const due = check.prepare("SELECT shown FROM items WHERE id=2").get() as any;
		check.close();
		assert.equal(due.shown, 0);
		assert.equal(fake.active().length, 1);
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});


// -- Multi-session consistency ------------------------------------------

function insertDueWord(db: DatabaseSync, text: string, meaning: string) {
	db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at) VALUES('word',?,?,?,?)")
		.run(text, meaning, new Date().toISOString(), new Date(0).toISOString());
}

function lessonItems() {
	const words: { type: string; text: string; phonetic: string; meaning: string; example: string; example_cn: string }[] = [
		{ type: "word", text: "coordinate", phonetic: "/koʊˈɔːrdɪneɪt/", meaning: "协调（动词，义项线索）", example: "We coordinate shared work.", example_cn: "我们协调共享工作。" },
		{ type: "word", text: "commit", phonetic: "/kəˈmɪt/", meaning: "提交（动词，义项线索）", example: "They commit the change.", example_cn: "他们提交了改动。" },
		{ type: "word", text: "persist", phonetic: "/pərˈsɪst/", meaning: "持久化（动词，义项线索）", example: "We persist the data.", example_cn: "我们持久化数据。" },
		{ type: "word", text: "refresh", phonetic: "/rɪˈfreʃ/", meaning: "刷新（动词，义项线索）", example: "The view will refresh.", example_cn: "视图会刷新。" },
		{ type: "word", text: "merge", phonetic: "/mɜːrdʒ/", meaning: "合并（动词，义项线索）", example: "I merge both branches.", example_cn: "我合并两个分支。" },
		{ type: "word", text: "expire", phonetic: "/ɪkˈspaɪər/", meaning: "过期（动词，义项线索）", example: "The lease will expire.", example_cn: "租约会过期。" },
		{ type: "word", text: "claim", phonetic: "/kleɪm/", meaning: "认领（动词，义项线索）", example: "One client must claim the lock.", example_cn: "只能有一个客户端认领锁。" },
		{ type: "phrase", text: "single source of truth", phonetic: "", meaning: "唯一事实来源（名词短语，义项线索）", example: "SQLite is the single source of truth.", example_cn: "SQLite 是唯一事实来源。" },
		{ type: "phrase", text: "take effect", phonetic: "", meaning: "生效（动词短语，义项线索）", example: "The fix will take effect.", example_cn: "修复会生效。" },
		{ type: "phrase", text: "in flight", phonetic: "", meaning: "进行中（介词短语，义项线索）", example: "The request is in flight.", example_cn: "请求进行中。" },
	];
	const cloze = {
		type: "cloze", text: "The fix that ___ (commit) this morning won't take effect until you reload.", phonetic: "", meaning: "was committed",
		example: "The fix that was committed this morning won't take effect until you reload.", example_cn: "今早提交的修复要等你重载后才生效。（考点：一般过去时被动语态）",
		chunks: ["The fix", "that was committed this morning", "won't take effect", "until you reload"],
	};
	return [...words, cloze];
}

function lessonResponse(topic = "concurrency") {
	return JSON.stringify({
		ready: true,
		topic,
		items: lessonItems(),
	});
}

/** A lesson whose 20-word cloze sentence is out of the cold-start B1 budget [12,18] (too long). */
function longLessonResponse(topic = "out-of-budget") {
	const items = lessonItems().map((item) =>
		item.type === "cloze"
			? {
				...item,
				type: "cloze" as const,
				text: "Because the system ___ (store) every learner attempt with its direction the profile recomputes a fresh difficulty budget each time now.",
				meaning: "stores",
				example: "Because the system stores every learner attempt with its direction the profile recomputes a fresh difficulty budget each time now.",
				example_cn: "因为系统把每个学习者答题连同方向一起保存，画像每次都能重算出新的难度预算。",
				chunks: ["Because the system stores every learner attempt", "with its direction", "the profile recomputes a fresh difficulty budget", "each time now"],
			}
			: item,
	);
	return JSON.stringify({
		ready: true,
		topic,
		items,
	});
}

function fauxModelRegistry(registration: ReturnType<typeof registerFauxProvider>) {
	const model = registration.getModel();
	return {
		model,
		registry: {
			getAvailable: () => [model],
			find: (provider: string, id: string) => provider === model.provider && id === model.id ? model : undefined,
			hasConfiguredAuth: () => true,
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
		},
	};
}

test("two sessions share one global card and rate it at most once", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 0 });
		const a = await makeSession();
		const b = await makeSession();
		const db = openTestDb();
		insertDueWord(db, "timer", "定时器");
		db.close();

		// Session A surfaces the due card and claims the global slot.
		await fake.fire();
		assert.match(a.widget().join(" "), /定时器/);
		assert.doesNotMatch(a.widget().join(" "), /timer/);
		// Session B's timer renders the *same* global card, not a second one.
		await fake.fire();
		assert.match(b.widget().join(" "), /定时器/);
		assert.doesNotMatch(b.widget().join(" "), /timer/);

		const check = openTestDb();
		const active = check.prepare("SELECT active_item_id, active_kind FROM runtime_state WHERE id=1").get() as any;
		check.close();
		assert.equal(active.active_item_id, 1);
		assert.equal(active.active_kind, "teach");

		// Both sessions attempt to rate the same card; only one applies.
		await a.commands["anki:good"].handler("", a.ctx);
		await b.commands["anki:good"].handler("", b.ctx);

		const fin = openTestDb();
		const row = fin.prepare("SELECT reviews,fsrs_state FROM items WHERE id=1").get() as any;
		const cleared = fin.prepare("SELECT active_item_id FROM runtime_state WHERE id=1").get() as any;
		fin.close();
		assert.equal(row.reviews, 1);
		assert.equal(JSON.parse(row.fsrs_state).reps, 1);
		assert.equal(cleared.active_item_id, null);

		await a.handlers.session_shutdown({ reason: "quit" }, a.ctx);
		await b.handlers.session_shutdown({ reason: "quit" }, b.ctx);
	} finally {
		fake.restore();
	}
});

test("session B auto-refreshes when session A rates the shared card", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 0 });
		const a = await makeSession();
		const b = await makeSession();
		const db = openTestDb();
		insertDueWord(db, "timer", "定时器");
		db.close();

		await fake.fire(); // A claims + shows the card
		await fake.fire(); // B renders the same card
		assert.match(b.widget().join(" "), /定时器/);
		assert.doesNotMatch(b.widget().join(" "), /timer/);

		// Let B's poll observe the active card once so it can later detect changes.
		await fake.firePoll();

		// A rates Good, clearing the global slot. (Manual self-report schedules Hard per P0-2.)
		await a.commands["anki:good"].handler("", a.ctx);
		assert.match(a.widget().join(" "), /记了个大概/);

		// B's poll notices the data_version change and drops the pending card.
		await fake.firePoll();
		assert.doesNotMatch(b.widget().join(" "), /定时器/);
		// Anki-style rating schedules an immediate next-card work timer, so assert
		// the cross-session poll timers are intact instead of long work-timer delays.
		assert.equal(fake.poll().length, 2);

		await a.handlers.session_shutdown({ reason: "quit" }, a.ctx);
		await b.handlers.session_shutdown({ reason: "quit" }, b.ctx);
	} finally {
		fake.restore();
	}
});

test("session shutdown keeps the shared global card for other sessions", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 0 });
		const a = await makeSession();
		const b = await makeSession();
		const db = openTestDb();
		insertDueWord(db, "timer", "定时器");
		db.close();

		await fake.fire(); // A claims + shows the card
		await fake.fire(); // B renders the same card

		// A's session ends (like a crash or /reload); the global card must persist.
		await a.handlers.session_shutdown({ reason: "quit" }, a.ctx);
		await fake.firePoll(); // B's poll re-reads the (unchanged) global card
		assert.match(b.widget().join(" "), /定时器/);
		assert.doesNotMatch(b.widget().join(" "), /timer/);

		// B can still operate on it, applying the rating exactly once.
		await b.commands["anki:good"].handler("", b.ctx);
		const fin = openTestDb();
		const row = fin.prepare("SELECT reviews FROM items WHERE id=1").get() as any;
		fin.close();
		assert.equal(row.reviews, 1);

		await b.handlers.session_shutdown({ reason: "quit" }, b.ctx);
	} finally {
		fake.restore();
	}
});

test("stale cross-session sentence and Skip actions apply exactly once", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 0 });
		const a = await makeSession({ sessionId: "sentence-a" });
		const b = await makeSession({ sessionId: "sentence-b" });
		let db = openTestDb();
		insertSentence(db);
		db.close();
		await fake.fire();
		await fake.fire();
		await a.commands["anki:answer"].handler("extension", a.ctx);
		await b.commands["anki:answer"].handler("extension", b.ctx);
		db = openTestDb();
		const sentence = db.prepare("SELECT progress,reviews FROM items WHERE id=1").get() as any;
		db.close();
		assert.deepEqual({ ...sentence }, { progress: 1, reviews: 0 });
		await a.handlers.session_shutdown({ reason: "quit" }, a.ctx);
		await b.handlers.session_shutdown({ reason: "quit" }, b.ctx);

		writeConfig({ intervalMinutes: 10, dailyNewLimit: 0 });
		const c = await makeSession({ sessionId: "skip-a" });
		const d = await makeSession({ sessionId: "skip-b" });
		db = openTestDb();
		insertDueWord(db, "known", "已知");
		db.close();
		await fake.fire();
		await fake.fire();
		await c.commands["anki:skip"].handler("", c.ctx);
		await d.commands["anki:skip"].handler("", d.ctx);
		db = openTestDb();
		const queue = JSON.parse((db.prepare("SELECT value FROM stats WHERE key='pending_replacements'").get() as any).value);
		const skipped = Number((db.prepare("SELECT value FROM stats WHERE key='total_skipped'").get() as any).value);
		db.close();
		assert.deepEqual(queue, ["word"]);
		assert.equal(skipped, 1);
		await c.handlers.session_shutdown({ reason: "quit" }, c.ctx);
		await d.handlers.session_shutdown({ reason: "quit" }, d.ctx);
	} finally {
		fake.restore();
	}
});

test("coordinator follows recent input and recovers after shutdown or expiry", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 3 });
		const a = await makeSession({ sessionId: "leader-a" });
		const b = await makeSession({ sessionId: "leader-b" });
		let db = openTestDb();
		let coordinator = String((db.prepare("SELECT coordinator FROM runtime_state WHERE id=1").get() as any).coordinator);
		db.close();
		assert.match(coordinator, /^leader-b::/);

		a.handlers.input({ type: "input", text: "hello", source: "interactive" }, a.ctx);
		db = openTestDb();
		coordinator = String((db.prepare("SELECT coordinator FROM runtime_state WHERE id=1").get() as any).coordinator);
		db.close();
		assert.match(coordinator, /^leader-a::/);
		b.handlers.input({ type: "input", text: "injected", source: "extension" }, b.ctx);
		db = openTestDb();
		assert.equal(String((db.prepare("SELECT coordinator FROM runtime_state WHERE id=1").get() as any).coordinator), coordinator);
		db.close();

		await a.handlers.session_shutdown({ reason: "quit" }, a.ctx);
		db = openTestDb();
		assert.equal((db.prepare("SELECT coordinator FROM runtime_state WHERE id=1").get() as any).coordinator, null);
		db.prepare("UPDATE runtime_state SET coordinator='dead', coordinator_until=?, generation_token='stale' WHERE id=1")
			.run(new Date(0).toISOString());
		db.close();
		await fake.fire();
		db = openTestDb();
		coordinator = String((db.prepare("SELECT coordinator FROM runtime_state WHERE id=1").get() as any).coordinator);
		db.close();
		assert.match(coordinator, /^leader-b::/);
		await b.handlers.session_shutdown({ reason: "quit" }, b.ctx);
		assert.equal(fake.active().length, 0);
		assert.equal(fake.poll().length, 0);
	} finally {
		fake.restore();
	}
});

test("single coordinator commits one lesson batch", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-faux" });
	try {
		registration.setResponses([
			fauxAssistantMessage(lessonResponse()),
			fauxAssistantMessage(JSON.stringify({ pass: true, issues: [], summary: "ok" })),
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 0 });
		const a = await makeSession({ model, modelRegistry: registry, sessionId: "lesson-a" });
		const b = await makeSession({ model, modelRegistry: registry, sessionId: "lesson-b" });
		await fake.fire();
		await fake.fire();
		await fake.flush();
		await fake.flush();
		const db = openTestDb();
		const count = Number((db.prepare("SELECT COUNT(*) AS n FROM items").get() as any).n);
		const state = db.prepare("SELECT active_item_id,active_kind FROM runtime_state WHERE id=1").get() as any;
		db.close();
		assert.equal(registration.state.callCount, 2);
		assert.equal(count, 11, "full daily batch committed: 10 words/phrases + 1 cloze");
		assert.equal(state.active_item_id, 1);
		assert.equal(state.active_kind, "teach");
		await fake.firePoll();
		assert.match(a.widget().join(" "), /协调/);
		assert.doesNotMatch(a.widget().join(" "), /coordinate/);
		assert.match(b.widget().join(" "), /协调/);
		assert.doesNotMatch(b.widget().join(" "), /coordinate/);
		await a.handlers.session_shutdown({ reason: "quit" }, a.ctx);
		await b.handlers.session_shutdown({ reason: "quit" }, b.ctx);
	} finally {
		registration.unregister();
		fake.restore();
	}
});

test("leadership change discards an in-flight stale lesson", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-stale-faux" });
	try {
		let resolveLesson!: (message: ReturnType<typeof fauxAssistantMessage>) => void;
		registration.setResponses([
			() => new Promise((resolve) => { resolveLesson = resolve; }),
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 3 });
		const a = await makeSession({ model, modelRegistry: registry, sessionId: "stale-a" });
		const b = await makeSession({ model, modelRegistry: registry, sessionId: "stale-b" });
		await fake.fire(); // non-coordinator A cannot start generation
		await fake.fire(); // coordinator B starts the deferred LLM call
		assert.equal(registration.state.callCount, 1);
		a.handlers.input({ type: "input", text: "newer context", source: "interactive" }, a.ctx);
		resolveLesson(fauxAssistantMessage(lessonResponse("stale")));
		await fake.flush();
		await fake.flush();
		const db = openTestDb();
		const count = Number((db.prepare("SELECT COUNT(*) AS n FROM items").get() as any).n);
		const state = db.prepare("SELECT coordinator,generation_token,active_item_id FROM runtime_state WHERE id=1").get() as any;
		db.close();
		assert.equal(count, 0);
		assert.match(String(state.coordinator), /^stale-a::/);
		assert.equal(state.generation_token, null);
		assert.equal(state.active_item_id, null);
		await a.handlers.session_shutdown({ reason: "quit" }, a.ctx);
		await b.handlers.session_shutdown({ reason: "quit" }, b.ctx);
	} finally {
		registration.unregister();
		fake.restore();
	}
});



test("schema migration is idempotent and registers adaptive protocol 1", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		const harness = await createHarness();
		const checkSchema = () => {
			const db = openTestDb();
			const meta = db.prepare("SELECT schema_version, adaptive_protocol, migration_state FROM schema_meta WHERE id=1").get() as any;
			const versions = (db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as any[]).map((r) => r.version);
			const tableNames = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map((r) => r.name);
			const itemCols = (db.prepare("PRAGMA table_info(items)").all() as any[]).map((r) => r.name);
			const runtimeCols = (db.prepare("PRAGMA table_info(runtime_state)").all() as any[]).map((r) => r.name);
			const attemptCols = (db.prepare("PRAGMA table_info(attempts)").all() as any[]).map((r) => r.name);
			const idxNames = (db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as any[]).map((r) => r.name);
			db.close();
			assert.deepEqual({ ...meta }, { schema_version: 14, adaptive_protocol: 1, migration_state: "complete" });
			assert.deepEqual(versions, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
			for (const t of ["lessons","lexical_senses","lexical_surface_versions","exercises","exercise_senses","supporting_materials","content_catalog_state","attempts","mastery_state","content_reports","fsrs_corruptions","tutor_jobs","tutor_job_artifacts","replacement_requests","runtime_clients","custom_card_queue","schema_meta","schema_migrations"]) {
				assert.ok(tableNames.includes(t), `table ${t} exists`);
			}
			for (const c of ["lesson_id","lexical_sense_id","role","content_fingerprint","content_version","introduced_at","introduction_kind","introduction_accuracy","content_status","legacy_duplicate_of","fsrs_status","fsrs_error","fsrs_corrupt_at"]) {
				assert.ok(itemCols.includes(c), `items.${c} exists`);
			}
			for (const c of ["active_direction", "active_review_cycle_id", "active_exercise_id", "active_cycle_outcome", "active_retry_count", "active_assistance_level"]) {
				assert.ok(runtimeCols.includes(c), `runtime_state.${c} exists`);
			}
			assert.ok(attemptCols.includes("direction"), "attempts.direction exists");
			assert.ok(attemptCols.includes("question_text"), "attempts.question_text exists");
			assert.ok(idxNames.includes("items_content_fingerprint_uq"), "fingerprint unique index exists");
		};
		checkSchema();
		// A second session reopens the same DB: the migration must not re-run.
		await makeSession({ sessionId: "migration-idempotent" });
		checkSchema();
		const db = openTestDb();
		const client = db.prepare("SELECT protocol_version, last_seen FROM runtime_clients WHERE client_id LIKE 'migration-idempotent%'").get() as any;
		db.close();
		assert.ok(client, "second session registered a client heartbeat");
		assert.equal(client.protocol_version, 1);
		assert.ok(client.last_seen);
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("v13 quarantines same-surface lexical duplicates without deleting history", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		const first = await createHarness({ sessionId: "migration-v13-source" });
		await first.handlers.session_shutdown({ reason: "quit" }, first.ctx);
		let db = openTestDb();
		const now = new Date().toISOString();
		db.prepare(
			"INSERT INTO items(id,type,text,meaning,learned_at,due_at,shown,reviews,content_fingerprint,introduction_kind,introduced_at) VALUES(1,'word','workload','工作量；学习负担',?,?,1,6,'old-fp-1','legacy',?)",
		).run(now, "2026-09-08T09:46:19.372Z", now);
		db.prepare(
			"INSERT INTO items(id,type,text,meaning,learned_at,due_at,shown,reviews,content_fingerprint,introduction_kind,introduced_at) VALUES(2,'word','Workload','工作量',?,?,1,2,'old-fp-2','planned',?)",
		).run(now, "2026-08-29T05:26:59.135Z", now);
		db.prepare(
			"INSERT INTO attempts(id,item_id,review_cycle_id,claim_key,question_version,evaluation_version,kind,assistance_level,status,verdict,started_at) VALUES('duplicate-attempt',2,'cycle','duplicate-claim',1,1,'recall','none','evaluated','correct',?)",
		).run(now);
		db.prepare(
			"INSERT INTO custom_card_queue(created_at,prompt,fingerprint,payload) VALUES(?, 'p', 'old-queue-fp', ?)",
		).run(now, JSON.stringify({ type: "word", text: " workload ", meaning: "负担" }));
		db.prepare("UPDATE runtime_state SET active_item_id=2, active_kind='review'").run();
		db.prepare("DELETE FROM schema_migrations WHERE version=13").run();
		db.prepare("UPDATE schema_meta SET schema_version=12 WHERE id=1").run();
		db.close();

		const upgraded = await makeSession({ sessionId: "migration-v13-target" });
		db = openTestDb();
		const rows = db.prepare("SELECT id,content_fingerprint,legacy_duplicate_of FROM items ORDER BY id").all() as any[];
		const attemptCount = Number((db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE item_id=2").get() as any).n);
		const active = db.prepare("SELECT active_item_id FROM runtime_state WHERE id=1").get() as any;
		const queueCount = Number((db.prepare("SELECT COUNT(*) AS n FROM custom_card_queue").get() as any).n);
		const introduced = Number((db.prepare("SELECT COUNT(*) AS n FROM items WHERE introduction_kind IN ('planned','custom') AND introduced_at >= ? AND legacy_duplicate_of IS NULL").get(new Date(0).toISOString()) as any).n);
		const meta = db.prepare("SELECT schema_version FROM schema_meta WHERE id=1").get() as any;
		db.close();
		assert.deepEqual(
			rows.map((row) => ({ ...row })),
			[
				{ id: 1, content_fingerprint: contentFingerprint("word", "workload", "ignored"), legacy_duplicate_of: null },
				{ id: 2, content_fingerprint: null, legacy_duplicate_of: 1 },
			],
		);
		assert.equal(attemptCount, 1, "duplicate attempt history is preserved");
		assert.equal(active.active_item_id, null, "an active duplicate is released");
		assert.equal(queueCount, 0, "same-surface queued duplicate is removed");
		assert.equal(introduced, 0, "quarantined planned duplicate does not consume quota");
		assert.equal(meta.schema_version, 14);
		await upgraded.handlers.session_shutdown({ reason: "quit" }, upgraded.ctx);
	} finally {
		fake.restore();
	}
});

test("v14 defers recognition after proven unassisted production", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		const first = await createHarness({ sessionId: "migration-v14-source" });
		await first.handlers.session_shutdown({ reason: "quit" }, first.ctx);
		let db = openTestDb();
		const reviewedAt = "2026-08-28T05:42:37.302Z";
		const productionDue = "2026-09-05T05:42:37.302Z";
		const recognitionDue = "2026-08-29T05:42:37.302Z";
		db.prepare(
			"INSERT INTO items(id,type,text,meaning,learned_at,due_at,shown,reviews,content_fingerprint) VALUES(1,'word','kitchen','厨房',?,?,1,7,?)",
		).run(reviewedAt, recognitionDue, contentFingerprint("word", "kitchen", "厨房"));
		db.prepare(
			"INSERT INTO direction_state(item_id,direction,fsrs_state,due_at,updated_at) VALUES(1,'forward','forward-state',?,?), (1,'reverse','reverse-state',?,?)",
		).run(productionDue, reviewedAt, recognitionDue, reviewedAt);
		db.prepare(
			"INSERT INTO attempts(id,item_id,review_cycle_id,claim_key,question_version,evaluation_version,kind,direction,answer_text,assistance_level,status,verdict,started_at,completed_at,rated_at) VALUES('production-good',1,'cycle','production-claim',1,1,'recall','forward','kitchen','none','evaluated','correct',?,?,?)",
		).run(reviewedAt, reviewedAt, reviewedAt);
		db.prepare("DELETE FROM schema_migrations WHERE version=14").run();
		db.prepare("UPDATE schema_meta SET schema_version=13 WHERE id=1").run();
		db.close();

		const upgraded = await makeSession({ sessionId: "migration-v14-target" });
		db = openTestDb();
		const reverse = db.prepare("SELECT fsrs_state,due_at FROM direction_state WHERE item_id=1 AND direction='reverse'").get() as any;
		const item = db.prepare("SELECT due_at FROM items WHERE id=1").get() as any;
		const meta = db.prepare("SELECT schema_version FROM schema_meta WHERE id=1").get() as any;
		db.close();
		const expected = new Date(Date.parse(productionDue) - 60_000).toISOString();
		assert.deepEqual({ ...reverse }, { fsrs_state: "reverse-state", due_at: expected });
		assert.equal(item.due_at, expected);
		assert.equal(meta.schema_version, 14);
		await upgraded.handlers.session_shutdown({ reason: "quit" }, upgraded.ctx);
	} finally {
		fake.restore();
	}
});

test("v5 upgrades an existing v4 database without losing cards", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		const first = await createHarness({ sessionId: "migration-v4-source" });
		await first.handlers.session_shutdown({ reason: "quit" }, first.ctx);
		let db = openTestDb();
		insertDueWord(db, "preserved", "保留");
		for (const column of ["active_assistance_level", "active_retry_count", "active_cycle_outcome", "active_exercise_id", "active_review_cycle_id"]) {
			db.exec(`ALTER TABLE runtime_state DROP COLUMN ${column}`);
		}
		db.prepare("DELETE FROM schema_migrations WHERE version = 5").run();
		db.prepare("UPDATE schema_meta SET schema_version = 4 WHERE id = 1").run();
		db.close();

		const upgraded = await makeSession({ sessionId: "migration-v5-target" });
		db = openTestDb();
		const meta = db.prepare("SELECT schema_version FROM schema_meta WHERE id=1").get() as any;
		const cols = (db.prepare("PRAGMA table_info(runtime_state)").all() as any[]).map((row) => row.name);
		const card = db.prepare("SELECT text,meaning FROM items WHERE text='preserved'").get() as any;
		db.close();
		assert.equal(meta.schema_version, 14);
		for (const column of ["active_review_cycle_id", "active_exercise_id", "active_cycle_outcome", "active_retry_count", "active_assistance_level"]) {
			assert.ok(cols.includes(column), `${column} migrated`);
		}
		assert.deepEqual({ ...card }, { text: "preserved", meaning: "保留" });
		await upgraded.handlers.session_shutdown({ reason: "quit" }, upgraded.ctx);
	} finally {
		fake.restore();
	}
});

test("v7 restores fractional elapsed_days false-positive quarantines without losing history", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		const first = await createHarness({ sessionId: "migration-v7-source" });
		await first.handlers.session_shutdown({ reason: "quit" }, first.ctx);
		let db = openTestDb();
		const state = JSON.stringify({
			due: "2026-08-12T00:52:51.430Z",
			stability: 1.1801865605280295,
			difficulty: 6.632799999999999,
			elapsed_days: 2.4368512962962963,
			scheduled_days: 0,
			reps: 5,
			lapses: 1,
			state: 3,
			last_review: "2026-08-12T00:47:51.430Z",
		});
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown,reviews,fsrs_state,fsrs_status,fsrs_error,fsrs_corrupt_at) VALUES('sentence','preserved state','保留状态',?,?,1,5,?,'corrupt','invalid_field:elapsed_days',?)")
			.run(new Date().toISOString(), "2026-08-12T03:02:04.451Z", state, new Date().toISOString());
		db.prepare("INSERT INTO fsrs_corruptions(item_id,raw_fsrs_state,error_code,detected_at,resolution) VALUES(1,?,'invalid_field:elapsed_days',?,NULL)")
			.run(state, new Date().toISOString());
		db.prepare("DELETE FROM schema_migrations WHERE version=7").run();
		db.prepare("UPDATE schema_meta SET schema_version=6 WHERE id=1").run();
		db.close();

		const upgraded = await makeSession({ sessionId: "migration-v7-target" });
		db = openTestDb();
		const item = db.prepare("SELECT reviews,fsrs_state,fsrs_status,fsrs_error,fsrs_corrupt_at FROM items WHERE id=1").get() as any;
		const corruption = db.prepare("SELECT resolution FROM fsrs_corruptions WHERE item_id=1").get() as any;
		const meta = db.prepare("SELECT schema_version FROM schema_meta WHERE id=1").get() as any;
		db.close();
		assert.equal(meta.schema_version, 14);
		assert.deepEqual({ ...item }, { reviews: 5, fsrs_state: state, fsrs_status: "ok", fsrs_error: null, fsrs_corrupt_at: null });
		assert.equal(corruption.resolution, "restored:v7_fractional_elapsed_days_false_positive");
		await upgraded.handlers.session_shutdown({ reason: "quit" }, upgraded.ctx);
	} finally {
		fake.restore();
	}
});

test("v8 upgrades an existing v7 database and preserves directionless attempts", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		const first = await createHarness({ sessionId: "migration-v8-source" });
		await first.handlers.session_shutdown({ reason: "quit" }, first.ctx);
		let db = openTestDb();
		insertDueWord(db, "preserved", "保留");
		db.exec("ALTER TABLE attempts DROP COLUMN direction");
		db.prepare(
			"INSERT INTO attempts (id, item_id, exercise_id, review_cycle_id, claim_key, question_version, evaluation_version, kind, assistance_level, status, verdict, explicit_rating, started_at, completed_at, rated_at) VALUES ('legacy-attempt', 1, NULL, 'legacy-cycle', 'legacy-claim', 1, 1, 'recall', 'none', 'evaluated', 'correct', 'good', ?, ?, ?)",
		).run(new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
		db.prepare("DELETE FROM schema_migrations WHERE version = 8").run();
		db.prepare("UPDATE schema_meta SET schema_version = 7 WHERE id = 1").run();
		db.close();

		const upgraded = await makeSession({ sessionId: "migration-v8-target" });
		db = openTestDb();
		const meta = db.prepare("SELECT schema_version FROM schema_meta WHERE id=1").get() as any;
		const cols = (db.prepare("PRAGMA table_info(attempts)").all() as any[]).map((row) => row.name);
		const attempt = db.prepare("SELECT verdict, direction FROM attempts WHERE id = 'legacy-attempt'").get() as any;
		db.close();
		assert.equal(meta.schema_version, 14);
		assert.ok(cols.includes("direction"), "direction migrated");
		assert.deepEqual({ ...attempt }, { verdict: "correct", direction: null });
		await upgraded.handlers.session_shutdown({ reason: "quit" }, upgraded.ctx);
	} finally {
		fake.restore();
	}
});

test("v11 upgrades an existing v10 database and admits cloze items", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		const first = await createHarness({ sessionId: "migration-v11-source" });
		await first.handlers.session_shutdown({ reason: "quit" }, first.ctx);
		let db = openTestDb();
		insertDueWord(db, "preserved", "保留");
		// Rebuild items with the pre-cloze CHECK to simulate a v10 database.
		const createSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='items'").get() as any).sql as string;
		db.exec(createSql
			.replace(/CREATE TABLE "?items"?\s*\(/, "CREATE TABLE items_v10 (")
			.replace("'word', 'phrase', 'sentence', 'cloze'", "'word', 'phrase', 'sentence'"));
		db.exec("INSERT INTO items_v10 SELECT * FROM items; DROP TABLE items; ALTER TABLE items_v10 RENAME TO items;");
		assert.throws(
			() => db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at) VALUES('cloze','x ___ y','答案',?,?)").run(new Date().toISOString(), new Date(0).toISOString()),
			/CHECK constraint failed/,
			"v10 schema rejects cloze items",
		);
		db.prepare("DELETE FROM schema_migrations WHERE version = 11").run();
		db.prepare("UPDATE schema_meta SET schema_version = 10 WHERE id = 1").run();
		db.close();

		const upgraded = await makeSession({ sessionId: "migration-v11-target" });
		db = openTestDb();
		const meta = db.prepare("SELECT schema_version FROM schema_meta WHERE id=1").get() as any;
		const card = db.prepare("SELECT text,meaning FROM items WHERE text='preserved'").get() as any;
		db.prepare(
			"INSERT INTO items(type,text,phonetic,meaning,example,example_cn,learned_at,due_at) VALUES('cloze',?,NULL,?,?,?, ?,?)",
		).run(
			"The fix that ___ (commit) this morning won't take effect until you reload.",
			"was committed",
			"The fix that was committed this morning won't take effect until you reload.",
			"今早提交的修复要等你重载后才生效。",
			new Date().toISOString(),
			new Date(0).toISOString(),
		);
		db.close();
		assert.equal(meta.schema_version, 14, "v11 migration and later steps applied");
		assert.deepEqual({ ...card }, { text: "preserved", meaning: "保留" }, "existing cards survive the rebuild");
		await upgraded.handlers.session_shutdown({ reason: "quit" }, upgraded.ctx);
	} finally {
		fake.restore();
	}
});

test("legacy teach-state cloze renders as a quiz and answers", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-cloze-legacy-teach" });
	try {
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 0 });
		// Persist an active cloze card claimed under the old code (active_kind='teach').
		const seed = await makeSession({ model, modelRegistry: registry, sessionId: "cloze-legacy-seed" });
		await seed.handlers.session_shutdown({ reason: "quit" }, seed.ctx);
		const db = openTestDb();
		insertClozeCard(db, 1);
		db.prepare("UPDATE runtime_state SET active_item_id = 1, active_kind = 'teach', active_direction = 'forward', active_version = active_version + 1 WHERE id = 1").run();
		db.close();
		// Reattach: the persisted teach state must not restore the leaking teach face.
		const harness = await makeSession({ model, modelRegistry: registry, sessionId: "cloze-legacy-reattach" });
		const face = harness.widget().join(" ");
		assert.match(face, /语法填空：The fix that ___ \(commit\)/);
		assert.doesNotMatch(face, /was committed|句意|考点/, "legacy teach state renders the quiz face");
		// Flip reveals the answer side (was a no-op on the old teach face),
		// including the meaning-chunk reading aid.
		await harness.commands["anki:flip"].handler("", harness.ctx);
		assert.match(harness.widget().join(" "), /was committed/, "flip reveals the answer");
		assert.match(harness.widget().join(" "), /意群：The fix \/ that was committed this morning/, "answer face shows chunks");
		// And the card is answerable without flip, graded like a review.
		await harness.commands["anki:answer"].handler("was committed", harness.ctx);
		assert.match(harness.widget().join(" "), /答对了/);
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		registration.unregister();
		fake.restore();
	}
});

test("introduced_at is stamped when a new card is first displayed", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 3 });
		const harness = await makeSession({ sessionId: "quota-stamp" });
		const db = openTestDb();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at) VALUES('word','first','意',?,?)")
			.run(new Date().toISOString(), new Date(0).toISOString());
		db.prepare("UPDATE runtime_state SET active_item_id=NULL, next_check_at=? WHERE id=1")
			.run(new Date(0).toISOString());
		db.close();
		await fake.fire();
		const check = openTestDb();
		const row = check.prepare("SELECT shown,introduced_at,introduction_kind FROM items WHERE id=1").get() as any;
		check.close();
		assert.equal(row.shown, 1);
		assert.equal(row.introduction_kind, "planned");
		assert.ok(row.introduced_at, "introduced_at stamped at first display");
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("planned new-card quota blocks extra new cards at display", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 1 });
		const harness = await makeSession({ sessionId: "quota-block" });
		const db = openTestDb();
		// Card 1: already introduced today and scheduled into the future (quota used).
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown,introduced_at,introduction_kind) VALUES('word','first','意',?,?,1,?,'planned')")
			.run(new Date().toISOString(), "2099-01-01T00:00:00.000Z", new Date().toISOString());
		// Card 2: a queued-new card due now.
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at) VALUES('word','second','意二',?,?)")
			.run(new Date().toISOString(), new Date(0).toISOString());
		db.prepare("UPDATE runtime_state SET active_item_id=NULL, next_check_at=? WHERE id=1")
			.run(new Date(0).toISOString());
		db.close();
		await fake.fire();
		const check = openTestDb();
		const item2 = check.prepare("SELECT shown,introduced_at,introduction_kind FROM items WHERE id=2").get() as any;
		const state = check.prepare("SELECT active_item_id FROM runtime_state WHERE id=1").get() as any;
		check.close();
		assert.equal(item2.shown, 0, "queued-new card not claimed over quota");
		assert.equal(item2.introduced_at, null, "queued-new card not stamped over quota");
		assert.equal(state.active_item_id, null, "no active card surfaced over quota");
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("adaptive new-card mode starts at 17 without manual quota changes", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 22, adaptiveNewCards: true });
		const harness = await makeSession({ sessionId: "adaptive-quota-start" });
		const db = openTestDb();
		for (let index = 1; index <= 18; index++) {
			insertDueWord(db, `adaptive-${index}`, `自适应-${index}`);
		}
		db.close();

		await fake.fire();
		for (let index = 1; index <= 17; index++) {
			assert.match(harness.widget().join(" "), new RegExp(`自适应-${index}`));
			await harness.commands["anki:good"].handler("", harness.ctx);
		}
		await fake.fire();

		const check = openTestDb();
		const shown = Number((check.prepare("SELECT COUNT(*) AS n FROM items WHERE shown=1").get() as any).n);
		const hidden = Number((check.prepare("SELECT COUNT(*) AS n FROM items WHERE shown=0").get() as any).n);
		const state = check.prepare("SELECT active_item_id FROM runtime_state WHERE id=1").get() as any;
		const started = check.prepare("SELECT value FROM stats WHERE key='adaptive_new_started_on'").get() as any;
		const savedPlan = check.prepare("SELECT value FROM stats WHERE key='adaptive_new_plan'").get() as any;
		const parsedPlan = JSON.parse(savedPlan.value) as { limit: number; paused: boolean };
		check.close();
		assert.deepEqual({ shown, hidden, active: state.active_item_id }, { shown: 17, hidden: 1, active: null });
		assert.match(started.value, /^\d{4}-\d{2}-\d{2}$/);
		assert.deepEqual({ limit: parsedPlan.limit, paused: parsedPlan.paused }, { limit: 17, paused: false });
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("a negative dailyNewLimit falls back to the default quota", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		writeConfig({ intervalMinutes: 10, dailyNewLimit: -1 });
		const harness = await makeSession({ sessionId: "invalid-config-defaults" });
		const db = openTestDb();
		for (const [text, meaning] of [["one", "一"], ["two", "二"], ["three", "三"], ["four", "四"]]) {
			insertDueWord(db, text, meaning);
		}
		db.close();
		await fake.fire();
		assert.match(harness.widget().join(" "), /今日剩余卡片（复习 1 · 新卡 3）/);
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("today remaining counts due cards plus only the available new-card quota", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 2 });
		const harness = await makeSession({ sessionId: "remaining-quota" });
		const db = openTestDb();
		const now = new Date().toISOString();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown,introduced_at,introduction_kind) VALUES('word','review','复习',?,?,1,?,'planned')")
			.run(now, new Date(0).toISOString(), now);
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at) VALUES('word','new-one','新一',?,?)").run(now, new Date(0).toISOString());
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at) VALUES('word','new-two','新二',?,?)").run(now, new Date(0).toISOString());
		db.prepare("UPDATE runtime_state SET active_item_id=NULL, next_check_at=? WHERE id=1").run(new Date(0).toISOString());
		db.close();
		await fake.fire();
		assert.match(harness.widget().join(" "), /今日剩余卡片（复习 1 · 新卡 1）/, "current review plus one quota-eligible new card");
		await harness.commands["anki:good"].handler("", harness.ctx);
		const after = openTestDb();
		const localStart = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()).toISOString();
		const planned = Number((after.prepare("SELECT COUNT(*) AS n FROM items WHERE introduction_kind='planned' AND introduced_at >= ?").get(localStart) as any).n);
		const queued = Number((after.prepare("SELECT COUNT(*) AS n FROM items WHERE shown=0").get() as any).n);
		const tomorrow = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() + 1).toISOString();
		const due = Number((after.prepare("SELECT COUNT(*) AS n FROM items WHERE shown=1 AND due_at < ?").get(tomorrow) as any).n);
		after.close();
		assert.deepEqual({ planned, queued }, { planned: 2, queued: 1 });
		assert.match(
			harness.widget().join(" "),
			new RegExp(`今日剩余卡片（复习 ${due}）`),
			"the immediately activated new card consumes the final quota slot; the remaining hidden card is excluded",
		);
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("today remaining includes hidden quota-free replacements after planned quota is full", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 1 });
		const harness = await makeSession({ sessionId: "remaining-hidden-replacement" });
		const db = openTestDb();
		const now = new Date().toISOString();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown,introduced_at,introduction_kind) VALUES('word','used','已用',?,?,1,?,'planned')")
			.run(now, "2099-01-01T00:00:00.000Z", now);
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown,introduction_kind) VALUES('word','replacement','补卡',?,?,0,'replacement')")
			.run(now, new Date(0).toISOString());
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown,introduction_kind) VALUES('word','planned','计划卡',?,?,0,'planned')")
			.run(now, new Date(0).toISOString());
		db.prepare("UPDATE runtime_state SET next_check_at=? WHERE id=1").run("2099-01-01T00:00:00.000Z");
		db.close();
		await fake.fire();
		assert.match(harness.widget().join(" "), /今日剩余卡片（复习 0 · 新卡 1）/);
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("dailyNewLimit zero allows every queued planned card to surface", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 0 });
		const harness = await makeSession({ sessionId: "quota-unlimited" });
		const db = openTestDb();
		for (const [text, meaning] of [["one", "一"], ["two", "二"], ["three", "三"]]) insertDueWord(db, text, meaning);
		db.close();
		await fake.fire();
		for (const [text, meaning] of [["one", "一"], ["two", "二"], ["three", "三"]]) {
			assert.match(harness.widget().join(" "), new RegExp(meaning));
			assert.doesNotMatch(harness.widget().join(" "), new RegExp(text));
			if (text !== "three") await harness.commands["anki:good"].handler("", harness.ctx);
		}
		const check = openTestDb();
		const shown = Number((check.prepare("SELECT COUNT(*) AS n FROM items WHERE shown=1 AND introduction_kind='planned' AND introduced_at IS NOT NULL").get() as any).n);
		check.close();
		assert.equal(shown, 3);
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("a matured Skip card due today is counted and claimable", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 1 });
		const harness = await makeSession({ sessionId: "matured-skip-due" });
		const db = openTestDb();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown,status) VALUES('word','matured','到期熟词',?,?,1,'mastered')")
			.run(new Date().toISOString(), new Date(0).toISOString());
		db.close();
		await fake.fire();
		assert.match(harness.widget().join(" "), /到期熟词/);
		assert.match(harness.widget().join(" "), /今日剩余卡片（复习 1）/);
		assert.doesNotMatch(harness.widget().join(" "), /新卡 0/);
		const check = openTestDb();
		const active = check.prepare("SELECT active_item_id,active_kind FROM runtime_state WHERE id=1").get() as any;
		check.close();
		assert.deepEqual({ ...active }, { active_item_id: 1, active_kind: "review" });
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("lexical fingerprints reject same surfaces even when meanings differ", () => {
	assert.equal(
		contentFingerprint("word", " workload ", "工作量"),
		contentFingerprint("word", "WORKLOAD", "工作量；学习负担"),
	);
	assert.notEqual(
		contentFingerprint("cloze", "The team ___ ready.", "is"),
		contentFingerprint("cloze", "The team ___ ready.", "was"),
	);
});

test("content fingerprint unique index rejects exact duplicates", { concurrency: false }, async () => {
	const harness = await createHarness();
	try {
		const db = openTestDb();
		const now = new Date().toISOString();
		const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='items_content_fingerprint_uq'").get() as any;
		assert.ok(idx, "fingerprint unique index exists");
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,content_fingerprint) VALUES('word','x','意',?,?,?)").run(now, now, "FP1");
		assert.throws(() =>
			db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,content_fingerprint) VALUES('word','x2','意',?,?,?)").run(now, now, "FP1"),
			/duplicate|constraint/i,
		);
		// Distinct fingerprint succeeds.
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,content_fingerprint) VALUES('word','y','意二',?,?,?)").run(now, now, "FP2");
		db.close();
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		// no fake timers used
	}
});

test("generated lesson items carry unique content fingerprints", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-fp-faux" });
	try {
		registration.setResponses([
			fauxAssistantMessage(lessonResponse("fingerprint")),
			fauxAssistantMessage(JSON.stringify({ pass: true, issues: [], summary: "ok" })),
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 0 });
		await makeSession({ model, modelRegistry: registry, sessionId: "fp-a" });
		await fake.fire();
		await fake.flush();
		const db = openTestDb();
		const fps = (db.prepare("SELECT content_fingerprint FROM items WHERE content_fingerprint IS NOT NULL").all() as any[]).map((r) => r.content_fingerprint);
		db.close();
		assert.ok(fps.length > 0, "lesson items stamped with fingerprint");
		assert.equal(new Set(fps).size, fps.length, "fingerprints are unique");
	} finally {
		registration.unregister();
		fake.restore();
	}
});

test("word/phrase items link to a lexical sense; cloze items do not", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-sense-faux" });
	try {
		registration.setResponses([
			fauxAssistantMessage(lessonResponse("senses")),
			fauxAssistantMessage(JSON.stringify({ pass: true, issues: [], summary: "ok" })),
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 0 });
		await makeSession({ model, modelRegistry: registry, sessionId: "sense-a" });
		await fake.fire();
		await fake.flush();
		const db = openTestDb();
		const linked = db.prepare("SELECT COUNT(*) AS n FROM items WHERE type IN ('word','phrase') AND lexical_sense_id IS NOT NULL").get() as any;
		const cloze = db.prepare("SELECT lexical_sense_id FROM items WHERE type='cloze'").get() as any;
		const senses = db.prepare("SELECT COUNT(*) AS n FROM lexical_senses").get() as any;
		const distinctFps = (db.prepare("SELECT COUNT(*) AS n FROM (SELECT DISTINCT sense_fingerprint FROM lexical_senses)").get() as any).n;
		db.close();
		assert.ok(Number(linked.n) >= 2, "word/phrase items linked to senses");
		assert.equal(cloze.lexical_sense_id, null, "cloze has no sense");
		assert.ok(Number(senses.n) >= 2, "distinct senses created");
		assert.equal(Number(senses.n), distinctFps, "sense fingerprints are unique");
	} finally {
		registration.unregister();
		fake.restore();
	}
});

test("quality gate rejects lessons the critic flags and commits nothing", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-gate-faux" });
	try {
		registration.setResponses([
			fauxAssistantMessage(lessonResponse("gated")),
			fauxAssistantMessage(JSON.stringify({ pass: false, issues: [{ severity: "blocker", category: "natural", description: "句子不自然" }], summary: "不自然" })),
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 3 });
		await makeSession({ model, modelRegistry: registry, sessionId: "gate-a" });
		await fake.fire();
		await fake.flush();
		const db = openTestDb();
		const count = Number((db.prepare("SELECT COUNT(*) AS n FROM items").get() as any).n);
		const state = db.prepare("SELECT active_item_id, generation_token FROM runtime_state WHERE id=1").get() as any;
		db.close();
		assert.equal(count, 0, "no items committed when the critic rejects");
		assert.equal(state.active_item_id, null, "no active card after rejection");
		assert.equal(state.generation_token, null, "generation lease released after rejection");
	} finally {
		registration.unregister();
		fake.restore();
	}
});

test("deterministic budget gate rejects an out-of-budget generated lesson with zero writes", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-budget-gate" });
	try {
		// Cold-start DB -> B1 budget [12,18]. Each generated lesson has a 20-word
		// cloze sentence (too long): the deterministic critic gate rejects it
		// before any LLM critic call. The 4th response is the basic-vocabulary
		// fallback batch, also out of budget and rejected the same way.
		registration.setResponses([
			fauxAssistantMessage(longLessonResponse("too-long-1")),
			fauxAssistantMessage(longLessonResponse("too-long-2")),
			fauxAssistantMessage(longLessonResponse("too-long-3")),
			fauxAssistantMessage(longLessonResponse("too-long-basic")),
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 0 });
		await makeSession({ model, modelRegistry: registry, sessionId: "budget-gate" });
		await fake.fire();
		await fake.flush();
		const db = openTestDb();
		const count = Number((db.prepare("SELECT COUNT(*) AS n FROM items").get() as any).n);
		const state = db.prepare("SELECT active_item_id, generation_token FROM runtime_state WHERE id=1").get() as any;
		const status = String((db.prepare("SELECT value FROM stats WHERE key='last_gen_status'").get() as any).value);
		db.close();
		assert.equal(count, 0, "out-of-budget lesson writes nothing");
		assert.equal(state.active_item_id, null, "no active card after deterministic rejection");
		assert.equal(state.generation_token, null, "generation lease released");
		assert.match(status, /critic_rejected/, "deterministic gate reject recorded as critic_rejected");
		// 4 calls: 3 generation calls for the initial+revision batches, plus 1 basic
		// fallback generation. The LLM critic was never consulted because the
		// deterministic gate short-circuited every critiqueLesson.
		assert.equal(registration.state.callCount, 4, "no LLM critic call for the deterministic gate");
	} finally {
		registration.unregister();
		fake.restore();
	}
});

test("critic bad JSON fails closed and commits no lesson", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-critic-bad-json" });
	try {
		registration.setResponses([
			fauxAssistantMessage(lessonResponse("bad-critic-json")),
			fauxAssistantMessage("not-json"),
			fauxAssistantMessage(JSON.stringify({ ready: false, reason: "defer revision" })),
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 0 });
		await makeSession({ model, modelRegistry: registry, sessionId: "critic-bad-json" });
		await fake.fire();
		await fake.flush();
		const db = openTestDb();
		const count = Number((db.prepare("SELECT COUNT(*) AS n FROM items").get() as any).n);
		const status = String((db.prepare("SELECT value FROM stats WHERE key='last_gen_status'").get() as any).value);
		db.close();
		assert.equal(count, 0);
		assert.match(status, /critic_unavailable/);
		assert.equal(registration.state.callCount, 2, "unavailable critic defers without wasting a revision call");
	} finally {
		registration.unregister();
		fake.restore();
	}
});

test("revision loop recovers a lesson after an initial critic rejection", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-rev-faux" });
	try {
		registration.setResponses([
			fauxAssistantMessage(lessonResponse("rev-v1")),
			fauxAssistantMessage(JSON.stringify({ pass: false, issues: [{ severity: "blocker", category: "natural", description: "不自然" }], summary: "需修订" })),
			fauxAssistantMessage(lessonResponse("rev-fixed")),
			fauxAssistantMessage(JSON.stringify({ pass: true, issues: [], summary: "ok" })),
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 0 });
		await makeSession({ model, modelRegistry: registry, sessionId: "rev-a" });
		await fake.fire();
		await fake.flush();
		const db = openTestDb();
		const count = Number((db.prepare("SELECT COUNT(*) AS n FROM items").get() as any).n);
		const state = db.prepare("SELECT active_item_id FROM runtime_state WHERE id=1").get() as any;
		db.close();
		assert.equal(registration.state.callCount, 4, "generate + critique + revise generate + revise critique");
		assert.ok(count > 0, "revised lesson committed after the critic approved it");
		assert.equal(state.active_item_id, 1, "revised lesson activated");
	} finally {
		registration.unregister();
		fake.restore();
	}
});

test("basic-vocabulary fallback commits a lesson after the critic keeps rejecting", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-basic-fallback" });
	try {
		registration.setResponses([
			fauxAssistantMessage(lessonResponse("basic-v1")),
			fauxAssistantMessage(JSON.stringify({ pass: false, issues: [{ severity: "blocker", category: "natural", description: "不自然" }], summary: "需修订" })),
			fauxAssistantMessage(lessonResponse("basic-v2")),
			fauxAssistantMessage(JSON.stringify({ pass: false, issues: [{ severity: "blocker", category: "natural", description: "仍不自然" }], summary: "仍不达标" })),
			fauxAssistantMessage(lessonResponse("基础词汇")),
			fauxAssistantMessage(JSON.stringify({ pass: true, issues: [], summary: "ok" })),
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 0 });
		await makeSession({ model, modelRegistry: registry, sessionId: "basic-fallback" });
		await fake.fire();
		await fake.flush();
		const db = openTestDb();
		const count = Number((db.prepare("SELECT COUNT(*) AS n FROM items").get() as any).n);
		const state = db.prepare("SELECT active_item_id FROM runtime_state WHERE id=1").get() as any;
		const status = String((db.prepare("SELECT value FROM stats WHERE key='last_gen_status'").get() as any).value);
		db.close();
		assert.equal(registration.state.callCount, 6, "generate + critique + revise generate + revise critique + basic generate + basic critique");
		assert.ok(count > 0, "basic fallback batch committed after approval");
		assert.equal(state.active_item_id, 1, "basic fallback batch activated");
		assert.match(status, /ok: 基础词汇/, "basic fallback topic recorded");
	} finally {
		registration.unregister();
		fake.restore();
	}
});

test("basic-vocabulary fallback rescues a rejected replacement", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-replacement-basic" });
	try {
		registration.setResponses([
			fauxAssistantMessage(JSON.stringify({
				ready: true,
				item: { type: "word", text: "deadline", phonetic: "", meaning: "截止时间（名词，义项线索）", example: "The deadline is tomorrow.", example_cn: "截止时间是明天。" },
			})),
			fauxAssistantMessage(JSON.stringify({ pass: false, issues: [{ severity: "blocker", category: "natural", description: "reject" }], summary: "rejected" })),
			fauxAssistantMessage(JSON.stringify({
				ready: true,
				item: { type: "word", text: "morning", phonetic: "", meaning: "早晨（名词，义项线索）", example: "Good morning.", example_cn: "早上好。" },
			})),
			fauxAssistantMessage(JSON.stringify({ pass: true, issues: [], summary: "approved" })),
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 1 });
		const harness = await makeSession({ model, modelRegistry: registry, sessionId: "replacement-basic" });
		const db = openTestDb(); insertDueWord(db, "timer", "定时器"); db.close();
		await fake.fire();
		await harness.commands["anki:skip"].handler("", harness.ctx);
		const check = openTestDb();
		const items = check.prepare("SELECT text,introduction_kind FROM items ORDER BY id").all() as any[];
		const queue = JSON.parse(String((check.prepare("SELECT value FROM stats WHERE key='pending_replacements'").get() as any).value));
		const active = check.prepare("SELECT active_item_id FROM runtime_state WHERE id=1").get() as any;
		check.close();
		assert.equal(registration.state.callCount, 4, "replacement + critic + basic replacement + basic critic");
		assert.equal(items.length, 2, "basic fallback replacement inserted");
		assert.deepEqual({ text: items[1].text, kind: items[1].introduction_kind }, { text: "morning", kind: "replacement" });
		assert.deepEqual(queue, [], "FIFO obligation consumed after fallback insertion");
		assert.equal(active.active_item_id, 2);
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		registration.unregister();
		fake.restore();
	}
});

test("fallback session model is reused for the critic after configured generator failure", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const primary = registerFauxProvider({ provider: "kaomoji-primary-failure" });
	const fallback = registerFauxProvider({ provider: "kaomoji-session-fallback" });
	try {
		fallback.setResponses([
			fauxAssistantMessage(lessonResponse("fallback")),
			fauxAssistantMessage(JSON.stringify({ pass: true, issues: [], summary: "approved by fallback" })),
		]);
		const primaryModel = primary.getModel();
		const fallbackModel = fallback.getModel();
		const models = [primaryModel, fallbackModel];
		let primaryAuthCalls = 0;
		const registry = {
			getAvailable: () => models,
			find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
			hasConfiguredAuth: () => true,
			getApiKeyAndHeaders: async (model: any) => {
				if (model.provider === primaryModel.provider) {
					primaryAuthCalls++;
					throw new Error("primary unavailable");
				}
				return { ok: true, apiKey: "test-key" };
			},
		};
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 0, provider: primaryModel.provider, model: primaryModel.id });
		await makeSession({ model: fallbackModel, modelRegistry: registry, sessionId: "model-fallback" });
		await fake.fire();
		await fake.flush();
		const db = openTestDb();
		const count = Number((db.prepare("SELECT COUNT(*) AS n FROM items").get() as any).n);
		db.close();
		assert.ok(primaryAuthCalls >= 1, "configured provider was attempted first");
		assert.equal(fallback.state.callCount, 2, "fallback handles generation and independent critique");
		assert.equal(count, 11, "full daily batch committed via the fallback model");
	} finally {
		primary.unregister();
		fallback.unregister();
		fake.restore();
	}
});

test("active recall: a correct answer is judged and recorded", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		const harness = await createHarness();
		const db = openTestDb();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown) VALUES('word','hello','你好',?,?,1)")
			.run(new Date().toISOString(), new Date(0).toISOString());
		db.close();
		await fake.fire();
		assert.match(harness.widget().join(" "), /你好/, "review front shows the Chinese meaning, not the English answer");
		await harness.commands["anki:answer"].handler("hello", harness.ctx);
		assert.match(harness.widget().join(" "), /答对了/);
		assert.equal(fake.active().length, 1, "normal pacing timer remains when the queue is empty");
		assert.ok(fake.active()[0].delay > 590_000, "feedback is not overwritten by a 0ms idle tick");
		const check = openTestDb();
		const att = check.prepare("SELECT verdict, kind, answer_text, direction FROM attempts WHERE item_id = 1").get() as any;
		check.close();
		assert.equal(att.verdict, "correct");
		assert.equal(att.kind, "recall");
		assert.equal(att.answer_text, "hello");
		assert.equal(att.direction, "forward");
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("unassisted forward recall defers the easier reverse direction", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		const harness = await createHarness();
		const now = new Date();
		const lastReview = new Date(now.getTime() - 3 * 24 * 3600 * 1000);
		const dueNow = new Date(now.getTime() - 1000).toISOString();
		const forwardState = JSON.stringify({
			due: dueNow,
			stability: 7,
			difficulty: 5,
			elapsed_days: 3,
			scheduled_days: 3,
			reps: 4,
			lapses: 0,
			state: 2,
			last_review: lastReview.toISOString(),
		});
		const db = openTestDb();
		db.prepare("INSERT INTO items(id,type,text,meaning,learned_at,due_at,shown,reviews,fsrs_state) VALUES(1,'word','kitchen','厨房',?,?,1,6,?)")
			.run(lastReview.toISOString(), dueNow, forwardState);
		db.prepare("INSERT INTO direction_state(item_id,direction,fsrs_state,due_at,updated_at) VALUES(1,'forward',?,?,?), (1,'reverse','',?,?)")
			.run(forwardState, dueNow, lastReview.toISOString(), new Date(now.getTime() + 3600_000).toISOString(), lastReview.toISOString());
		db.close();

		await fake.fire();
		await harness.commands["anki:answer"].handler("kitchen", harness.ctx);
		const check = openTestDb();
		const directions = check.prepare("SELECT direction,due_at FROM direction_state WHERE item_id=1 ORDER BY direction").all() as any[];
		check.close();
		const forwardDue = Date.parse(directions[0].due_at);
		const reverseDue = Date.parse(directions[1].due_at);
		assert.ok(forwardDue - now.getTime() > 24 * 3600 * 1000, "mature production interval should exceed one day");
		assert.equal(forwardDue - reverseDue, 60_000, "recognition is checked near, not one day after, production");
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("active recall without model: a wrong answer stays pending with zero writes", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		const harness = await createHarness();
		const db = openTestDb();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown) VALUES('word','world','世界',?,?,1)")
			.run(new Date().toISOString(), new Date(0).toISOString());
		db.close();
		await fake.fire();
		await harness.commands["anki:answer"].handler("word", harness.ctx);
		assert.ok(harness.notifications().some((m) => /无法可靠判断/.test(m)), "warning shown for unavailable evaluator");
		const check = openTestDb();
		const att = check.prepare("SELECT COUNT(*) AS n FROM attempts WHERE item_id = 1").get() as any;
		const active = check.prepare("SELECT active_item_id FROM runtime_state WHERE id=1").get() as any;
		const item = check.prepare("SELECT reviews,fsrs_state FROM items WHERE id=1").get() as any;
		const mastery = Number((check.prepare("SELECT COUNT(*) AS n FROM mastery_state WHERE item_id=1").get() as any).n);
		check.close();
		assert.equal(att.n, 0, "zero attempts when evaluator unavailable");
		assert.equal(active.active_item_id, 1, "card stays pending");
		assert.deepEqual({ ...item }, { reviews: 0, fsrs_state: "" });
		assert.equal(mastery, 0);
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("bad evaluator JSON leaves word card pending with zero authoritative writes", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-eval-bad-json" });
	try {
		registration.setResponses([fauxAssistantMessage("not-json")]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 0 });
		const harness = await makeSession({ model, modelRegistry: registry, sessionId: "eval-bad-json" });
		const db = openTestDb();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown) VALUES('word','world','世界',?,?,1)")
			.run(new Date().toISOString(), new Date(0).toISOString());
		db.close();
		await fake.fire();
		await harness.commands["anki:answer"].handler("word", harness.ctx);
		const check = openTestDb();
		const item = check.prepare("SELECT reviews,fsrs_state FROM items WHERE id=1").get() as any;
		const attempts = Number((check.prepare("SELECT COUNT(*) AS n FROM attempts").get() as any).n);
		const mastery = Number((check.prepare("SELECT COUNT(*) AS n FROM mastery_state").get() as any).n);
		const active = check.prepare("SELECT active_item_id FROM runtime_state WHERE id=1").get() as any;
		check.close();
		assert.deepEqual({ ...item }, { reviews: 0, fsrs_state: "" });
		assert.equal(attempts, 0);
		assert.equal(mastery, 0);
		assert.equal(active.active_item_id, 1);
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		registration.unregister();
		fake.restore();
	}
});

test("LLM evaluation marks a near-miss answer as partial with feedback", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-eval-faux" });
	try {
		registration.setResponses([
			fauxAssistantMessage(JSON.stringify({ verdict: "partial", feedback: "少了复数 s" })),
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 0 });
		const harness = await makeSession({ model, modelRegistry: registry, sessionId: "eval-a" });
		const db = openTestDb();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown) VALUES('word','apples','苹果',?,?,1)")
			.run(new Date().toISOString(), new Date(0).toISOString());
		db.close();
		await fake.fire();
		await harness.commands["anki:answer"].handler("apple", harness.ctx);
		assert.match(harness.widget().join(" "), /差一点/);
		const check = openTestDb();
		const att = check.prepare("SELECT verdict, feedback_json, explicit_rating FROM attempts WHERE item_id = 1").get() as any;
		const item = check.prepare("SELECT reviews FROM items WHERE id=1").get() as any;
		const mastery = check.prepare("SELECT consecutive_again FROM mastery_state WHERE item_id=1").get() as any;
		check.close();
		assert.equal(att.verdict, "partial");
		assert.equal(att.explicit_rating, "again");
		assert.match(att.feedback_json, /少了复数/);
		assert.equal(item.reviews, 1);
		assert.equal(mastery.consecutive_again, 1);
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		registration.unregister();
		fake.restore();
	}
});

test("recall exercise template is persisted when a card is answered", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		const harness = await createHarness();
		const db = openTestDb();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown) VALUES('word','cat','猫',?,?,1)")
			.run(new Date().toISOString(), new Date(0).toISOString());
		db.close();
		await fake.fire();
		await harness.commands["anki:answer"].handler("cat", harness.ctx);
		const check = openTestDb();
		const ex = check.prepare("SELECT kind, stage, content_fingerprint FROM exercises WHERE item_id = 1").get() as any;
		check.close();
		assert.equal(ex.kind, "recall");
		assert.equal(ex.stage, "recall");
		assert.ok(ex.content_fingerprint, "exercise fingerprint stamped");
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("mastery state tracks Good and Again evidence", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		const harness = await createHarness();
		const db = openTestDb();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown) VALUES('word','dog','狗',?,?,1)")
			.run(new Date().toISOString(), new Date(0).toISOString());
		db.close();
		await fake.fire();
		await harness.commands["anki:again"].handler("", harness.ctx);
		let check = openTestDb();
		let m = check.prepare("SELECT unassisted_good, consecutive_again, stage FROM mastery_state WHERE item_id = 1").get() as any;
		check.close();
		assert.deepEqual({ ...m }, { unassisted_good: 0, consecutive_again: 1, stage: "exposure" });
		// Re-due the card, then rate Good.
		const db2 = openTestDb();
		db2.prepare("UPDATE items SET due_at = ? WHERE id = 1").run(new Date(0).toISOString());
		db2.prepare("UPDATE runtime_state SET active_item_id = NULL, next_check_at = ? WHERE id = 1").run(new Date(0).toISOString());
		db2.close();
		await fake.fire();
		await harness.commands["anki:answer"].handler("dog", harness.ctx);
		check = openTestDb();
		m = check.prepare("SELECT stage, unassisted_good, consecutive_again FROM mastery_state WHERE item_id = 1").get() as any;
		check.close();
		assert.equal(m.unassisted_good, 1, "objective correct clears the streak and counts one unassisted success");
		assert.equal(m.consecutive_again, 0, "Good resets consecutive Again");
		assert.equal(m.stage, "recognition", "one Good promotes exposure -> recognition");
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("consecutive Again triggers a reinforcement hint", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		const harness = await createHarness();
		const now = new Date().toISOString();
		const db = openTestDb();
		db.prepare("INSERT INTO items(type,text,meaning,example,example_cn,learned_at,due_at,shown) VALUES('word','run','跑','He runs fast.','他跑得快。',?,?,1)")
			.run(now, new Date(0).toISOString());
		db.prepare("INSERT INTO mastery_state (item_id, stage, unassisted_good, consecutive_again, updated_at) VALUES (1, 'recognition', 0, 1, ?)").run(now);
		db.close();
		await fake.fire();
		await harness.commands["anki:again"].handler("", harness.ctx);
		assert.match(harness.widget().join(" "), /反复忘了/);
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("anki:stats reports mastery distribution and accuracy without error", { concurrency: false }, async () => {
	const harness = await createHarness();
	try {
		assert.equal(typeof harness.commands["anki:stats"], "object");
		// Exercises the full query path on an empty DB (no rows → "暂无", 0 attempts).
		await harness.commands["anki:stats"].handler("", harness.ctx);
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		// no fake timers
	}
});

test("schema_meta records completed migration version", { concurrency: false }, async () => {
	const harness = await createHarness();
	const db = openTestDb();
	const meta = db.prepare("SELECT schema_version, migration_state FROM schema_meta WHERE id=1").get() as any;
	db.close();
	assert.equal(meta.schema_version, 14, "schema migrated to v14");
	assert.equal(meta.migration_state, "complete");
	await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
});

test("mastery stage promotes to controlled_recall after a second Good", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		const harness = await createHarness();
		const now = new Date().toISOString();
		const db = openTestDb();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown) VALUES('word','deploy','部署',?,?,1)")
			.run(now, new Date(0).toISOString());
		db.prepare("INSERT INTO mastery_state(item_id,stage,unassisted_good,consecutive_again,updated_at) VALUES(1,'recognition',1,0,?)").run(now);
		db.close();
		await fake.fire();
		await harness.commands["anki:answer"].handler("deploy", harness.ctx);
		const ck = openTestDb();
		const m = ck.prepare("SELECT stage, unassisted_good FROM mastery_state WHERE item_id=1").get() as any;
		ck.close();
		assert.equal(m.stage, "controlled_recall", "second objective correct promotes recognition -> controlled_recall");
		assert.equal(m.unassisted_good, 2);
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("mastery stage demotes one level on Again", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		const harness = await createHarness();
		const now = new Date().toISOString();
		const db = openTestDb();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown) VALUES('word','deploy','部署',?,?,1)")
			.run(now, new Date(0).toISOString());
		db.prepare("INSERT INTO mastery_state(item_id,stage,unassisted_good,consecutive_again,updated_at) VALUES(1,'controlled_recall',2,0,?)").run(now);
		db.close();
		await fake.fire();
		await harness.commands["anki:again"].handler("", harness.ctx);
		const ck = openTestDb();
		const m = ck.prepare("SELECT stage, consecutive_again FROM mastery_state WHERE item_id=1").get() as any;
		ck.close();
		assert.equal(m.stage, "recognition", "Again demotes controlled_recall -> recognition");
		assert.equal(m.consecutive_again, 1);
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("persistent status stays compact while anki:stats keeps detailed metrics", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		const harness = await createHarness();
		const db = openTestDb();
		db.prepare("INSERT INTO mastery_state(item_id,stage,unassisted_good,consecutive_again,updated_at) VALUES(1,'exposure',0,2,?)").run(new Date().toISOString());
		db.close();
		await fake.fire();
		const status = harness.widget().join(" ");
		assert.doesNotMatch(status, /连续学习|今日剩余卡片/);
		assert.doesNotMatch(status, /需强化|今日新增|今日复习|已学/);
		await harness.commands["anki:stats"].handler("", harness.ctx);
		assert.ok(harness.notifications().some((message) => /需强化：1/.test(message)));
		// The profile/budget transparency line includes band, confidence, evidence counts, and the budget range.
		assert.ok(harness.notifications().some((message) => /画像：句法 B1\(证据0,低\)/.test(message)), "stats shows syntax band with evidence");
		assert.ok(harness.notifications().some((message) => /预算 12-18词\/巩固/.test(message)), "stats shows the conservative cold-start budget");
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("lesson generation stamps content_fingerprint and lexical_sense_id", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-fp" });
	try {
		registration.setResponses([
			fauxAssistantMessage(lessonResponse()),
			fauxAssistantMessage(JSON.stringify({ pass: true, issues: [], summary: "ok" })),
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 0 });
		const s = await makeSession({ model, modelRegistry: registry, sessionId: "fp" });
		await fake.fire();
		await fake.flush();
		const db = openTestDb();
		const items = db.prepare("SELECT type, content_fingerprint, lexical_sense_id, introduction_kind, introduced_at FROM items ORDER BY id").all() as any[];
		const senses = (db.prepare("SELECT COUNT(*) AS n FROM lexical_senses").get() as any).n;
		db.close();
		assert.ok(items.length >= 3, "lesson inserted its three items");
		for (const it of items) {
			assert.ok(it.content_fingerprint, `${it.type} has content_fingerprint`);
			assert.equal(it.introduction_kind, "planned", `${it.type} stamped introduction_kind=planned`);
		}
		// Only the first card (displayed) has introduced_at; queued cards do not.
		assert.ok(items[0].introduced_at, "first item has introduced_at");
		for (let i = 1; i < items.length; i++) {
			assert.equal(items[i].introduced_at, null, `queued item ${i} has no introduced_at`);
		}
		const word = items.find((i) => i.type === "word");
		const phrase = items.find((i) => i.type === "phrase");
		const cloze = items.find((i) => i.type === "cloze");
		assert.ok(word.lexical_sense_id, "word linked to a lexical sense");
		assert.ok(phrase.lexical_sense_id, "phrase linked to a lexical sense");
		assert.ok(!cloze.lexical_sense_id, "cloze has no lexical sense");
		assert.ok(senses >= 2, "word + phrase each created a sense");
		await s.handlers.session_shutdown({ reason: "quit" }, s.ctx);
	} finally {
		registration.unregister();
		fake.restore();
	}
});

test("duplicate content fingerprint is rejected at commit", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-dup" });
	try {
		registration.setResponses([
			fauxAssistantMessage(lessonResponse()),
			fauxAssistantMessage(JSON.stringify({ pass: true, issues: [], summary: "ok" })),
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 3 });
		const s = await makeSession({ model, modelRegistry: registry, sessionId: "dup" });
		// Pre-insert the same surface with a broader meaning and a future due date;
		// protocol 1 must not create another sense card without grounded sense IDs.
		const db0 = openTestDb();
		const fp = contentFingerprint("word", "coordinate", "合作；协调");
		db0.prepare(
			"INSERT INTO items(type,text,meaning,learned_at,due_at,shown,content_fingerprint,introduction_kind) VALUES('word','coordinate','合作；协调',?,?,1,?,'legacy')",
		).run(new Date().toISOString(), new Date(Date.now() + 3600_000).toISOString(), fp);
		db0.close();
		await fake.fire();
		await fake.flush();
		const db = openTestDb();
		const count = (db.prepare("SELECT COUNT(*) AS n FROM items").get() as any).n;
		db.close();
		assert.equal(count, 1, "duplicate lesson rejected, only the pre-existing item remains");
		await s.handlers.session_shutdown({ reason: "quit" }, s.ctx);
	} finally {
		registration.unregister();
		fake.restore();
	}
});

test("critic rejection prevents insertion", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-critic" });
	const criticFail = JSON.stringify({ pass: false, issues: [{ severity: "blocker", category: "fact", description: "incorrect meaning" }], summary: "factual error" });
	const notReady = JSON.stringify({ ready: false, reason: "cannot fix without more context" });
	registration.setResponses([
		fauxAssistantMessage(lessonResponse()),	// initial generation: ready
		fauxAssistantMessage(criticFail),			// critic: reject
		fauxAssistantMessage(notReady),				// revision generation: gives up -> break loop
	]);
	const { model, registry } = fauxModelRegistry(registration);
	try {
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 3 });
		const s = await makeSession({ model, modelRegistry: registry, sessionId: "critic" });
		await fake.fire();
		await fake.flush();
		const db = openTestDb();
		const count = (db.prepare("SELECT COUNT(*) AS n FROM items").get() as any).n;
		db.close();
		assert.equal(count, 0, "critic rejection blocked the lesson from being inserted");
		await s.handlers.session_shutdown({ reason: "quit" }, s.ctx);
	} finally {
		registration.unregister();
		fake.restore();
	}
});

test("claimDueItem surfaces a new card within the dailyNewLimit quota", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 2 });
		const s = await makeSession({ sessionId: "quota" });
		const today = new Date().toISOString();
		const db = openTestDb();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown,introduction_kind,introduced_at) VALUES('word','alpha','阿尔法',?,?,0,'planned',?)")
			.run(today, new Date(0).toISOString(), today);
		db.close();
		await fake.fire();
		assert.match(s.widget().join(" "), /阿尔法/, "new card surfaced within quota");
		assert.doesNotMatch(s.widget().join(" "), /alpha/, "new-card front hides the target word");
		const ck = openTestDb();
		const active = ck.prepare("SELECT active_item_id FROM runtime_state WHERE id=1").get() as any;
		const item = ck.prepare("SELECT shown FROM items WHERE id=1").get() as any;
		ck.close();
		assert.equal(active.active_item_id, 1);
		assert.equal(item.shown, 1, "surfaced card marked shown");
		await s.handlers.session_shutdown({ reason: "quit" }, s.ctx);
	} finally {
		fake.restore();
	}
});

test("claimDueItem blocks new cards once dailyNewLimit is reached", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 1 });
		const s = await makeSession({ sessionId: "quota-full" });
		const today = new Date().toISOString();
		const db = openTestDb();
		// One planned card already counts against the quota of 1.
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown,introduction_kind,introduced_at) VALUES('word','beta','贝塔',?,?,0,'planned',?)")
			.run(today, new Date(0).toISOString(), today);
		// A second queued new card should not be surfaced.
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown,introduction_kind,introduced_at) VALUES('word','gamma','伽马',?,?,0,'planned',?)")
			.run(today, new Date(0).toISOString(), today);
		db.close();
		await fake.fire();
		const ck = openTestDb();
		const active = ck.prepare("SELECT active_item_id FROM runtime_state WHERE id=1").get() as any;
		const shown = ck.prepare("SELECT COUNT(*) AS n FROM items WHERE shown=1").get() as any;
		ck.close();
		assert.equal(active.active_item_id, null, "no new card surfaced once quota is full");
		assert.equal(shown.n, 0, "neither queued card was marked shown");
		await s.handlers.session_shutdown({ reason: "quit" }, s.ctx);
	} finally {
		fake.restore();
	}
});

test("manual teach requests queue behind an in-flight generation", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-teach-queue" });
	let releaseFirst!: () => void;
	let firstStarted!: () => void;
	const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
	const started = new Promise<void>((resolve) => { firstStarted = resolve; });
	try {
		registration.setResponses([
			async () => {
				firstStarted();
				await firstGate;
				return fauxAssistantMessage(JSON.stringify({ ready: false, reason: "gated" }));
			},
			fauxAssistantMessage(manualLessonResponse("queued lesson")),
			fauxAssistantMessage(JSON.stringify({ pass: true, issues: [], summary: "approved" })),
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 11 });
		const s = await makeSession({ model, modelRegistry: registry, sessionId: "teach-queue" });
		await fake.fire(); // tick: automatic generation starts and hangs on the gate
		await started;
		await s.commands["anki:teach"].handler("排队话题", s.ctx);
		const notes = s.notifications().join("\n");
		assert.match(notes, /已排队.*排队话题/);
		assert.doesNotMatch(notes, /请稍候|稍后再试/);
		releaseFirst(); // busy generation finishes -> finally drains the queue
		await fake.flush();
		await fake.flush();
		const db = openTestDb();
		const n = (db.prepare("SELECT COUNT(*) AS n FROM items").get() as any).n;
		const active = db.prepare("SELECT active_item_id FROM runtime_state WHERE id=1").get() as any;
		db.close();
		assert.ok(n > 0, "queued teach generated and inserted after the busy generation finished");
		assert.equal(active.active_item_id, null, "manual batch is retained while normal study pacing still delays activation");
		await s.handlers.session_shutdown({ reason: "quit" }, s.ctx);
	} finally {
		registration.unregister();
		fake.restore();
	}
});

test("teach retries generation when the batch duplicates existing cards", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-teach-duplicate-retry" });
	const word = (text: string, meaning: string) => ({
		type: "word", text, phonetic: "", meaning: `${meaning}（名词，义项线索）`,
		example: `We review the word ${text} today.`, example_cn: "例句翻译",
	});
	const phrase = (text: string, meaning: string) => ({
		type: "phrase", text, phonetic: "", meaning: `${meaning}（动词短语，义项线索）`,
		example: `They use the phrase ${text} here.`, example_cn: "例句翻译",
	});
	const cloze = () => ({
		type: "cloze", text: "The fix that ___ (commit) this morning won't take effect until you reload.", phonetic: "", meaning: "was committed",
		example: "The fix that was committed this morning won't take effect until you reload.", example_cn: "今早提交的修复要等你重载后才生效。（考点：一般过去时被动语态）",
		chunks: ["The fix", "that was committed this morning", "won't take effect", "until you reload"],
	});
	const batch = (first: ReturnType<typeof word>, tag: string) => JSON.stringify({
		ready: true,
		topic: `duplicate retry ${tag}`,
		items: [
			first,
			word(`river${tag}`, "河流"), word(`forest${tag}`, "森林"), word(`harbor${tag}`, "港口"), word(`meadow${tag}`, "草地"),
			word(`bridge${tag}`, "桥"), word(`ladder${tag}`, "梯子"),
			phrase(`keep pace ${tag}`, "保持节奏"), phrase(`on track ${tag}`, "步入正轨"), phrase(`in bloom ${tag}`, "盛开"),
			cloze(),
		],
	});
	// A pre-existing "coordinate" card (shown, far-future due) collides with the
// teach batch; the retry must regenerate before anything is inserted.
	const coordinate = word("coordinate", "协调");
	const pass = JSON.stringify({ pass: true, issues: [], summary: "approved" });
	try {
		registration.setResponses([
			fauxAssistantMessage(batch(coordinate, "dup")), // tick generation: contains a duplicate
			fauxAssistantMessage(pass),
			fauxAssistantMessage(batch(word("market", "市场"), "fresh")), // duplicate retry: no collisions
			fauxAssistantMessage(pass),
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 22 });
		const s = await makeSession({ model, modelRegistry: registry, sessionId: "teach-dup-retry" });
		const seed = openTestDb();
		seed.prepare(
			"INSERT INTO items(type,text,meaning,learned_at,due_at,shown,content_fingerprint) VALUES('word','coordinate','协调',?,?,1,?)",
		).run(new Date().toISOString(), "2099-01-01T00:00:00.000Z", contentFingerprint("word", "coordinate", "协调"));
		seed.close();
		await fake.fire(); // tick generation hits the duplicate and retries
		await fake.flush();
		await fake.flush();
		const db = openTestDb();
		const texts = (db.prepare("SELECT text FROM items ORDER BY id").all() as any[]).map((r) => r.text);
		const active = db.prepare("SELECT active_item_id FROM runtime_state WHERE id=1").get() as any;
		const log = JSON.parse((db.prepare("SELECT value FROM stats WHERE key='gen_log'").get() as any).value) as { s: string }[];
		db.close();
		assert.equal(texts.length, 12, "the retried full batch was delivered on top of the seeded card");
		assert.equal(texts.filter((t) => t === "coordinate").length, 1, "the duplicate word was never inserted twice");
		assert.ok(texts.includes("market"), "the retried batch's words were inserted");
		assert.equal(active.active_item_id, 2, "the retried lesson's first card was activated");
		assert.ok(log.some((e) => e.s.startsWith("duplicate_retry: coordinate")), "retry decision is auditable");
		assert.ok(!log.some((e) => e.s.startsWith("duplicate_batch")), "no wholesale rejection");
		await s.handlers.session_shutdown({ reason: "quit" }, s.ctx);
	} finally {
		registration.unregister();
		fake.restore();
	}
});

test("rpc sessions generate the IELTS basic line when the conversation is empty", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-rpc-fallback" });
	try {
		registration.setResponses([
			fauxAssistantMessage(lessonResponse("rpc fallback")),
			fauxAssistantMessage(JSON.stringify({ pass: true, issues: [], summary: "approved" })),
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 11 });
		const s = await makeSession({ model, modelRegistry: registry, sessionId: "rpc-fallback", mode: "rpc", branch: [] });
		await fake.fire();
		await fake.flush();
		const db = openTestDb();
		const n = (db.prepare("SELECT COUNT(*) AS n FROM items").get() as any).n;
		const status = (db.prepare("SELECT value FROM stats WHERE key='last_gen_status'").get() as any).value;
		const active = db.prepare("SELECT active_item_id FROM runtime_state WHERE id=1").get() as any;
		db.close();
		assert.ok(n > 0, "the tick generated a batch from the IELTS fallback topic");
		assert.match(status, /^ok:/);
		assert.ok(active.active_item_id != null, "the first card was activated");
		await s.handlers.session_shutdown({ reason: "quit" }, s.ctx);
	} finally {
		registration.unregister();
		fake.restore();
	}
});

test("a rejected rpc fallback batch retries on the next tick instead of cached-rejection idling", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-rpc-fallback-retry" });
	const fail = JSON.stringify({ pass: false, issues: [{ severity: "blocker", category: "dup", description: "释义并列" }], summary: "释义并列近义" });
	const notReady = JSON.stringify({ ready: false, reason: "cannot fix" });
	try {
		registration.setResponses([
			fauxAssistantMessage(lessonResponse("rpc fallback")), // tick 1 generation
			fauxAssistantMessage(fail), // critic rejects
			fauxAssistantMessage(notReady), // revision gives up
			fauxAssistantMessage(notReady), // basic fallback gives up
			fauxAssistantMessage(lessonResponse("rpc fallback 2")), // tick 2 regenerates
			fauxAssistantMessage(JSON.stringify({ pass: true, issues: [], summary: "approved" })),
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 11 });
		const s = await makeSession({ model, modelRegistry: registry, sessionId: "rpc-fallback-retry", mode: "rpc", branch: [] });
		await fake.fire(); // tick 1: generated, critic rejected, pacing deferred
		await fake.flush();
		const reset = openTestDb();
		reset.prepare("UPDATE runtime_state SET next_check_at = ? WHERE id = 1").run(new Date(0).toISOString());
		reset.close();
		await fake.fire(); // tick 2: must regenerate, not idle on cached_rejection
		await fake.flush();
		const db = openTestDb();
		const n = (db.prepare("SELECT COUNT(*) AS n FROM items").get() as any).n;
		const log = JSON.parse((db.prepare("SELECT value FROM stats WHERE key='gen_log'").get() as any).value) as { s: string }[];
		db.close();
		assert.ok(n > 0, "the second tick delivered a batch");
		assert.ok(!log.some((e) => e.s === "cached_rejection"), "the fallback topic is never cached-rejected");
		await s.handlers.session_shutdown({ reason: "quit" }, s.ctx);
	} finally {
		registration.unregister();
		fake.restore();
	}
});

test("tui sessions still idle on an empty conversation", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 11 });
		const s = await makeSession({ sessionId: "tui-empty", mode: "tui", branch: [] });
		await fake.fire();
		const db = openTestDb();
		const n = (db.prepare("SELECT COUNT(*) AS n FROM items").get() as any).n;
		const status = (db.prepare("SELECT value FROM stats WHERE key='last_gen_status'").get() as any).value;
		db.close();
		assert.equal(n, 0, "no generation without conversation content in tui mode");
		assert.equal(status, "empty_conversation");
		await s.handlers.session_shutdown({ reason: "quit" }, s.ctx);
	} finally {
		fake.restore();
	}
});

test("transient generation errors retry once on the same model", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-gen-retry" });
	try {
		registration.setResponses([
			fauxAssistantMessage("sorry, I cannot output JSON right now"), // first attempt: garbage
			fauxAssistantMessage(lessonResponse("retry ok")), // same-model retry
			fauxAssistantMessage(JSON.stringify({ pass: true, issues: [], summary: "approved" })),
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 11 });
		const s = await makeSession({ model, modelRegistry: registry, sessionId: "gen-retry" });
		await fake.fire();
		await fake.flush();
		const db = openTestDb();
		const n = (db.prepare("SELECT COUNT(*) AS n FROM items").get() as any).n;
		const status = (db.prepare("SELECT value FROM stats WHERE key='last_gen_status'").get() as any).value;
		db.close();
		assert.ok(n > 0, "the retried generation produced a batch");
		assert.match(status, /^ok:/);
		await s.handlers.session_shutdown({ reason: "quit" }, s.ctx);
	} finally {
		registration.unregister();
		fake.restore();
	}
});

test("persistent bad JSON retries the same full-quality prompt until the output is legal", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-gen-format-retry" });
	const captureFrom = capturedLlmContexts.length;
	try {
		registration.setResponses([
			fauxAssistantMessage("第一次不是 JSON"),
			fauxAssistantMessage("还是不是 JSON"),
			fauxAssistantMessage(lessonResponse("format retry ok")),
			fauxAssistantMessage(JSON.stringify({ pass: true, issues: [], summary: "approved" })),
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 11 });
		const s = await makeSession({ model, modelRegistry: registry, sessionId: "gen-format-retry" });
		await fake.fire();
		await fake.flush();
		const db = openTestDb();
		const n = (db.prepare("SELECT COUNT(*) AS n FROM items").get() as any).n;
		const status = (db.prepare("SELECT value FROM stats WHERE key='last_gen_status'").get() as any).value;
		db.close();
		assert.ok(n > 0, "the same-prompt format retry delivered a batch");
		assert.match(status, /^ok:/);
		const retried = capturedLlmContexts.slice(captureFrom).filter((p) => p.includes("上一次输出无法解析"));
		assert.equal(retried.length, 2, "both retries carried the parse-error note");
		for (const prompt of retried) {
			assert.match(prompt, /<conversation>/, "retry keeps the full original prompt");
			assert.match(prompt, /难度预算保持不变/, "retry keeps the no-difficulty-cut instruction");
		}
		await s.handlers.session_shutdown({ reason: "quit" }, s.ctx);
	} finally {
		registration.unregister();
		fake.restore();
	}
});

test("exhausted format retries surface the error and defer to the next tick", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-gen-format-exhaust" });
	try {
		registration.setResponses([
			fauxAssistantMessage("坏输出 1"),
			fauxAssistantMessage("坏输出 2"),
			fauxAssistantMessage("坏输出 3"),
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 11 });
		const s = await makeSession({ model, modelRegistry: registry, sessionId: "gen-format-exhaust" });
		await fake.fire();
		await fake.flush();
		const db = openTestDb();
		const n = (db.prepare("SELECT COUNT(*) AS n FROM items").get() as any).n;
		const status = (db.prepare("SELECT value FROM stats WHERE key='last_gen_status'").get() as any).value;
		const state = db.prepare("SELECT next_check_at FROM runtime_state WHERE id=1").get() as any;
		db.close();
		assert.equal(n, 0, "nothing inserted after exhausted retries");
		assert.match(status, /^error: BAD_JSON/);
		assert.ok(new Date(state.next_check_at).getTime() > Date.now(), "pacing deferred the next attempt");
		await s.handlers.session_shutdown({ reason: "quit" }, s.ctx);
	} finally {
		registration.unregister();
		fake.restore();
	}
});

test("active recall: reverse direction asks for the Chinese meaning", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		const harness = await createHarness();
		const db = openTestDb();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown) VALUES('word','hello','你好',?,?,1)")
			.run(new Date().toISOString(), new Date(0).toISOString());
		// Direction comes from per-direction scheduling state: reverse is due, forward is not.
		db.prepare("INSERT INTO direction_state(item_id,direction,fsrs_state,due_at,updated_at) VALUES(1,'forward','',?,?),(1,'reverse','',?,?)")
			.run("2099-01-01T00:00:00.000Z", new Date().toISOString(), new Date(0).toISOString(), new Date().toISOString());
		db.close();
		await fake.fire();
		assert.match(harness.widget().join(" "), /写出单词「hello」的中文释义/, "reverse front shows English, asks for Chinese");
		await harness.commands["anki:hint"].handler("", harness.ctx);
		assert.match(harness.notifications().at(-1) ?? "", /提示：你_/, "reverse hint masks the Chinese answer");
		await harness.commands["anki:answer"].handler("你好", harness.ctx);
		assert.match(harness.widget().join(" "), /答对了/, "correct Chinese answer auto-rates Good");
		const check = openTestDb();
		const att = check.prepare("SELECT verdict, answer_text, assistance_level, direction FROM attempts WHERE item_id = 1").get() as any;
		const mastery = check.prepare("SELECT stage, unassisted_good, assisted_good FROM mastery_state WHERE item_id = 1").get() as any;
		check.close();
		assert.deepEqual({ ...att }, { verdict: "correct", answer_text: "你好", assistance_level: "hint", direction: "reverse" });
		assert.deepEqual({ ...mastery }, { stage: "exposure", unassisted_good: 0, assisted_good: 1 });
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("active recall direction is shared across sessions and survives reattachment", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 0 });
		const a = await makeSession({ sessionId: "direction-a" });
		const b = await makeSession({ sessionId: "direction-b" });
		const db = openTestDb();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown) VALUES('word','persist','持久化',?,?,1)")
			.run(new Date().toISOString(), new Date(0).toISOString());
		// Reverse direction is due; forward is not.
		db.prepare("INSERT INTO direction_state(item_id,direction,fsrs_state,due_at,updated_at) VALUES(1,'forward','',?,?),(1,'reverse','',?,?)")
			.run("2099-01-01T00:00:00.000Z", new Date().toISOString(), new Date(0).toISOString(), new Date().toISOString());
		db.close();
		await fake.fire();
		await fake.fire();
		assert.match(a.widget().join(" "), /写出单词「persist」的中文释义/);
		assert.match(b.widget().join(" "), /写出单词「persist」的中文释义/);
		const check = openTestDb();
		const state = check.prepare("SELECT active_direction FROM runtime_state WHERE id = 1").get() as any;
		check.close();
		assert.equal(state.active_direction, "reverse");
		await b.handlers.session_shutdown({ reason: "quit" }, b.ctx);
		const c = await makeSession({ sessionId: "direction-c" });
		assert.match(c.widget().join(" "), /写出单词「persist」的中文释义/, "new session restores persisted direction");
		await c.handlers.session_shutdown({ reason: "quit" }, c.ctx);
		await a.handlers.session_shutdown({ reason: "quit" }, a.ctx);
	} finally {
		fake.restore();
	}
});

test("flip-assisted correct answer schedules Again (a revealed answer is not recall evidence)", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		const harness = await createHarness();
		const db = openTestDb();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown) VALUES('word','cat','猫',?,?,1)")
			.run(new Date().toISOString(), new Date(0).toISOString());
		db.prepare("INSERT INTO mastery_state(item_id,stage,unassisted_good,updated_at) VALUES(1,'controlled_recall',2,?)")
			.run(new Date().toISOString());
		db.close();
		await fake.fire();
		await harness.commands["anki:flip"].handler("", harness.ctx);
		await harness.commands["anki:answer"].handler("cat", harness.ctx);
		const check = openTestDb();
		const item = check.prepare("SELECT reviews FROM items WHERE id = 1").get() as any;
		const attempt = check.prepare("SELECT assistance_level, explicit_rating FROM attempts WHERE item_id = 1").get() as any;
		const mastery = check.prepare("SELECT stage, unassisted_good, assisted_good, consecutive_again FROM mastery_state WHERE item_id = 1").get() as any;
		check.close();
		assert.equal(item.reviews, 1, "the review still happened");
		assert.deepEqual({ ...attempt }, { assistance_level: "revealed", explicit_rating: "again" }, "correct-after-reveal schedules Again (P0-2)");
		assert.deepEqual({ ...mastery }, { stage: "recognition", unassisted_good: 0, assisted_good: 0, consecutive_again: 1 }, "a revealed answer produces no recall evidence");
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("stale async answer cannot record or rate the next global card", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-stale-eval" });
	let releaseResponse!: () => void;
	let responseStarted!: () => void;
	const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
	const started = new Promise<void>((resolve) => { responseStarted = resolve; });
	try {
		registration.setResponses([
			async () => {
				responseStarted();
				await responseGate;
				return fauxAssistantMessage(JSON.stringify({ verdict: "correct", feedback: "可接受" }));
			},
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 3 });
		const a = await makeSession({ model, modelRegistry: registry, sessionId: "stale-answer-a" });
		const b = await makeSession({ model, modelRegistry: registry, sessionId: "stale-answer-b" });
		const db = openTestDb();
		const now = new Date().toISOString();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown) VALUES('word','alpha','阿尔法',?,?,1)").run(now, new Date(0).toISOString());
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown) VALUES('word','beta','贝塔',?,?,1)").run(now, new Date(0).toISOString());
		db.close();
		await fake.fire(); // A claims alpha.
		await fake.fire(); // B renders alpha.
		const inFlight = a.commands["anki:answer"].handler("alph", a.ctx);
		await started;
		await b.commands["anki:good"].handler("", b.ctx); // B rates alpha.
		assert.match(b.widget().join(" "), /贝塔/, "B immediately advances the global slot before the old evaluation returns");
		releaseResponse();
		await inFlight;
		const check = openTestDb();
		const items = check.prepare("SELECT text, reviews FROM items ORDER BY id").all() as any[];
		const attemptCount = (check.prepare("SELECT COUNT(*) AS n FROM attempts WHERE status = 'evaluated'").get() as any).n;
		const active = check.prepare("SELECT active_item_id FROM runtime_state WHERE id = 1").get() as any;
		check.close();
		assert.deepEqual(items.map((row) => ({ ...row })), [
			{ text: "alpha", reviews: 1 },
			{ text: "beta", reviews: 0 },
		]);
		assert.equal(active.active_item_id, 2, "beta remains the authoritative next card");
		assert.equal(attemptCount, 0, "stale LLM result writes no evaluated attempt (B's manual self-report is recorded separately)");
		await a.handlers.session_shutdown({ reason: "quit" }, a.ctx);
		await b.handlers.session_shutdown({ reason: "quit" }, b.ctx);
	} finally {
		releaseResponse?.();
		registration.unregister();
		fake.restore();
	}
});

test("stale sentence evaluator result writes no retry or rating after another session ends the cycle", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-stale-sentence-eval" });
	let releaseResponse!: () => void;
	let responseStarted!: () => void;
	const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
	const started = new Promise<void>((resolve) => { responseStarted = resolve; });
	try {
		registration.setResponses([
			async () => {
				responseStarted();
				await responseGate;
				return fauxAssistantMessage(JSON.stringify({ verdict: "correct", feedback: "自然变体", correctedAnswer: "extension" }));
			},
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 0 });
		const a = await makeSession({ model, modelRegistry: registry, sessionId: "stale-sentence-a" });
		const b = await makeSession({ model, modelRegistry: registry, sessionId: "stale-sentence-b" });
		const db = openTestDb(); insertSentence(db); db.close();
		await fake.fire();
		await fake.fire();
		const inFlight = a.commands["anki:answer"].handler("extensio", a.ctx);
		await started;
		await b.commands["anki:again"].handler("", b.ctx);
		releaseResponse();
		await inFlight;
		const check = openTestDb();
		const item = check.prepare("SELECT progress,reviews FROM items WHERE id=1").get() as any;
		const attempts = check.prepare("SELECT kind,direction,explicit_rating FROM attempts").all() as any[];
		const state = check.prepare("SELECT active_item_id,active_review_cycle_id FROM runtime_state WHERE id=1").get() as any;
		check.close();
		assert.deepEqual({ ...item }, { progress: 0, reviews: 1 });
		assert.deepEqual(attempts.map((attempt) => ({ ...attempt })), [{ kind: "sentence_self_report", direction: "forward", explicit_rating: "again" }]);
		assert.deepEqual({ ...state }, { active_item_id: null, active_review_cycle_id: null });
		await a.handlers.session_shutdown({ reason: "quit" }, a.ctx);
		await b.handlers.session_shutdown({ reason: "quit" }, b.ctx);
	} finally {
		releaseResponse?.();
		registration.unregister();
		fake.restore();
	}
});

test("a sentence hint invalidates an in-flight clean evaluation", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-hint-race-eval" });
	let releaseResponse!: () => void;
	let responseStarted!: () => void;
	const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
	const started = new Promise<void>((resolve) => { responseStarted = resolve; });
	try {
		registration.setResponses([
			async () => {
				responseStarted();
				await responseGate;
				return fauxAssistantMessage(JSON.stringify({ verdict: "correct", feedback: "可接受", correctedAnswer: "extension" }));
			},
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 0 });
		const a = await makeSession({ model, modelRegistry: registry, sessionId: "hint-race-a" });
		const b = await makeSession({ model, modelRegistry: registry, sessionId: "hint-race-b" });
		const db = openTestDb(); insertSentence(db); db.close();
		await fake.fire();
		await fake.fire();
		const inFlight = a.commands["anki:answer"].handler("extensio", a.ctx);
		await started;
		await b.commands["anki:hint"].handler("", b.ctx);
		releaseResponse();
		await inFlight;
		const check = openTestDb();
		const state = check.prepare("SELECT active_item_id,active_cycle_outcome,active_assistance_level FROM runtime_state WHERE id=1").get() as any;
		const attempts = Number((check.prepare("SELECT COUNT(*) AS n FROM attempts").get() as any).n);
		const item = check.prepare("SELECT progress,reviews FROM items WHERE id=1").get() as any;
		check.close();
		assert.deepEqual({ ...state }, { active_item_id: 1, active_cycle_outcome: "again", active_assistance_level: "hint" });
		assert.deepEqual({ ...item }, { progress: 0, reviews: 0 });
		assert.equal(attempts, 0);
		await b.commands["anki:again"].handler("", b.ctx);
		await a.handlers.session_shutdown({ reason: "quit" }, a.ctx);
		await b.handlers.session_shutdown({ reason: "quit" }, b.ctx);
	} finally {
		releaseResponse?.();
		registration.unregister();
		fake.restore();
	}
});

test("manual Again immediately advances to the next due card without a feedback lock", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 0 });
		const harness = await makeSession({ sessionId: "again-feedback" });
		const db = openTestDb();
		const now = new Date().toISOString();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown) VALUES('word','alpha','阿尔法',?,?,1)").run(now, new Date(0).toISOString());
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown) VALUES('word','beta','贝塔',?,?,1)").run(now, new Date(0).toISOString());
		db.close();
		await fake.fire();
		await harness.commands["anki:again"].handler("", harness.ctx);
		assert.match(harness.widget().join(" "), /贝塔/, "the next due card is immediately usable");
		const check = openTestDb();
		assert.equal(check.prepare("SELECT active_item_id FROM runtime_state").get()?.active_item_id, 2);
		assert.ok(Date.parse(String(check.prepare("SELECT due_at FROM direction_state WHERE item_id=1 AND direction='forward'").get()?.due_at)) > Date.now(), "Again still schedules the failed direction for a future review");
		assert.equal(check.prepare("SELECT COUNT(*) AS n FROM attempts WHERE item_id=1 AND explicit_rating='again'").get()?.n, 1);
		check.close();
		assert.equal(fake.active().length, 0, "no timer locks the next stored card");
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("Anki-style: correct rating immediately surfaces the next due card", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 0 });
		const a = await makeSession({ sessionId: "anki" });
		const db = openTestDb();
		const now = new Date().toISOString();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown) VALUES('word','alpha','阿尔法',?,?,1)").run(now, new Date(0).toISOString());
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown) VALUES('word','beta','贝塔',?,?,1)").run(now, new Date(0).toISOString());
		db.close();
		await fake.fire(); // surface first due card
		assert.match(a.widget().join(" "), /阿尔法|贝塔/, "first card shown");
		await a.commands["anki:good"].handler("", a.ctx);
		assert.equal(fake.active().length, 0, "the rating command directly claims existing inventory");
		const w = a.widget().join(" ");
		assert.ok(/阿尔法|贝塔/.test(w), "next due card surfaced without waiting");
		await a.handlers.session_shutdown({ reason: "quit" }, a.ctx);
	} finally {
		fake.restore();
	}
});

test("lesson items leave introduced_at NULL until first display", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-intro-test" });
	try {
		registration.setResponses([
			fauxAssistantMessage(lessonResponse("intro-test")),
			fauxAssistantMessage(JSON.stringify({ pass: true, issues: [], summary: "ok" })),
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 0 });
		await makeSession({ model, modelRegistry: registry, sessionId: "intro-test" });
		await fake.fire();
		await fake.flush();
		const db = openTestDb();
		const items = db.prepare("SELECT introduced_at FROM items ORDER BY id").all() as any[];
		db.close();
		assert.equal(items.length, 11, "one daily batch of lesson items");
		assert.ok(items[0].introduced_at, "first item stamped at display");
		for (let i = 1; i < items.length; i++) {
			assert.equal(items[i].introduced_at, null, `queued item ${i} not yet displayed`);
		}
	} finally {
		registration.unregister();
		fake.restore();
	}
});

test("fractional elapsed_days produced by fsrs.js remains schedulable", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 3 });
		const harness = await makeSession({ sessionId: "fractional-elapsed-days" });
		const db = openTestDb();
		const lastReview = new Date(Date.now() - 2.5 * 24 * 60 * 60 * 1000).toISOString();
		const state = JSON.stringify({
			due: new Date(0).toISOString(),
			stability: 1.18,
			difficulty: 6.63,
			elapsed_days: 2.5,
			scheduled_days: 1,
			reps: 5,
			lapses: 1,
			state: 3,
			last_review: lastReview,
		});
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown,reviews,fsrs_state) VALUES('word','valid','有效',?,?,1,5,?)")
			.run(lastReview, new Date(0).toISOString(), state);
		db.prepare("UPDATE runtime_state SET active_item_id=1,active_kind='review',active_version=1 WHERE id=1").run();
		db.close();
		await harness.commands["anki:good"].handler("", harness.ctx);
		const check = openTestDb();
		const item = check.prepare("SELECT reviews,fsrs_status,fsrs_error FROM items WHERE id=1").get() as any;
		const corruptions = Number((check.prepare("SELECT COUNT(*) AS n FROM fsrs_corruptions WHERE item_id=1").get() as any).n);
		check.close();
		assert.equal(item.reviews, 6, "valid FSRS state advances normally");
		assert.equal(item.fsrs_status, "ok");
		assert.equal(item.fsrs_error, null);
		assert.equal(corruptions, 0);
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("corrupt FSRS state quarantines the card without silent reset", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 3 });
		const harness = await makeSession({ sessionId: "corrupt-test" });
		const db = openTestDb();
		const now = new Date().toISOString();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown,fsrs_state) VALUES('word','bad','坏',?,?,1,'NOT_JSON')").run(now, new Date(0).toISOString());
		db.prepare("UPDATE runtime_state SET active_item_id=1, active_kind='review', active_version=1 WHERE id=1").run();
		db.close();
		await harness.commands["anki:good"].handler("", harness.ctx);
		const check = openTestDb();
		const item = check.prepare("SELECT fsrs_status, fsrs_error FROM items WHERE id=1").get() as any;
		const corrupt = check.prepare("SELECT COUNT(*) AS n FROM fsrs_corruptions WHERE item_id=1").get() as any;
		const active = check.prepare("SELECT active_item_id FROM runtime_state WHERE id=1").get() as any;
		check.close();
		assert.equal(item.fsrs_status, "corrupt");
		assert.ok(item.fsrs_error, "error code recorded");
		assert.equal(corrupt.n, 1, "one diagnostic row");
		assert.equal(active.active_item_id, null, "active slot cleared");
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("non-object and invalid-date FSRS states are quarantined without throwing", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		const validDate = new Date().toISOString();
		const cases = [
			{ state: "null", error: /not_object/ },
			{
				state: JSON.stringify({ due: "not-a-date", last_review: "not-a-date", stability: 1, difficulty: 1, elapsed_days: 0, scheduled_days: 1, reps: 1, lapses: 0, state: 1 }),
				error: /invalid_date/,
			},
			{
				state: JSON.stringify({ due: validDate, last_review: validDate, stability: -1, difficulty: 1, elapsed_days: 0, scheduled_days: 1, reps: 1, lapses: 0, state: 2 }),
				error: /invalid_field:fsrs_range/,
			},
			{
				state: JSON.stringify({ due: validDate, last_review: validDate, stability: 1, difficulty: 1, elapsed_days: 0, scheduled_days: 1, reps: 1, lapses: 0, state: 999 }),
				error: /invalid_field:state/,
			},
		];
		for (const [index, fixture] of cases.entries()) {
			const harness = await createHarness({ sessionId: `corrupt-structure-${index}` });
			const db = openTestDb();
			const now = new Date().toISOString();
			db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown,fsrs_state) VALUES('word',?,?,?, ?,1,?)")
				.run(`bad-${index}`, "坏", now, new Date(0).toISOString(), fixture.state);
			db.prepare("UPDATE runtime_state SET active_item_id=1, active_kind='review', active_version=1 WHERE id=1").run();
			db.close();
			await harness.commands["anki:good"].handler("", harness.ctx);
			const check = openTestDb();
			const item = check.prepare("SELECT fsrs_status,fsrs_error FROM items WHERE id=1").get() as any;
			const count = Number((check.prepare("SELECT COUNT(*) AS n FROM fsrs_corruptions WHERE item_id=1").get() as any).n);
			check.close();
			assert.equal(item.fsrs_status, "corrupt");
			assert.match(item.fsrs_error, fixture.error);
			assert.equal(count, 1);
			await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
		}
	} finally {
		fake.restore();
	}
});

test("two sessions quarantine the same corrupt FSRS item only once", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 3 });
		const a = await makeSession({ sessionId: "corrupt-race-a" });
		const b = await makeSession({ sessionId: "corrupt-race-b" });
		const db = openTestDb();
		const now = new Date().toISOString();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown,fsrs_state) VALUES('word','bad','坏',?,?,1,'NOT_JSON')").run(now, new Date(0).toISOString());
		db.prepare("UPDATE runtime_state SET active_item_id=1,active_kind='review',active_version=1 WHERE id=1").run();
		db.close();
		await Promise.all([
			a.commands["anki:good"].handler("", a.ctx),
			b.commands["anki:good"].handler("", b.ctx),
		]);
		const check = openTestDb();
		const count = Number((check.prepare("SELECT COUNT(*) AS n FROM fsrs_corruptions WHERE item_id=1").get() as any).n);
		const state = check.prepare("SELECT active_item_id FROM runtime_state WHERE id=1").get() as any;
		check.close();
		assert.equal(count, 1);
		assert.equal(state.active_item_id, null);
		await a.handlers.session_shutdown({ reason: "quit" }, a.ctx);
		await b.handlers.session_shutdown({ reason: "quit" }, b.ctx);
	} finally {
		fake.restore();
	}
});

test("word/phrase evaluator unavailable keeps card pending with zero writes", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 0 });
		const harness = await makeSession({ sessionId: "eval-pending" });
		const db = openTestDb();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown) VALUES('word','hello','你好',?,?,1)").run(new Date().toISOString(), new Date(0).toISOString());
		db.close();
		await fake.fire();
		await harness.commands["anki:answer"].handler("wrong", harness.ctx);
		assert.ok(harness.notifications().some((m) => /无法可靠判断/.test(m)));
		const check = openTestDb();
		const att = check.prepare("SELECT COUNT(*) AS n FROM attempts").get() as any;
		const active = check.prepare("SELECT active_item_id FROM runtime_state WHERE id=1").get() as any;
		check.close();
		assert.equal(att.n, 0, "zero attempts");
		assert.equal(active.active_item_id, 1, "card stays pending");
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test.after(() => rmSync(agentDir, { recursive: true, force: true }));

// -- P0-2 assistance-aware scheduling (harness level) ----------------------

test("hint-assisted correct answer schedules Hard and says so", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		const harness = await createHarness();
		const db = openTestDb();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown) VALUES('word','apple','苹果',?,?,1)")
			.run(new Date().toISOString(), new Date(0).toISOString());
		db.close();
		await fake.fire();
		await harness.commands["anki:hint"].handler("", harness.ctx);
		await harness.commands["anki:answer"].handler("apple", harness.ctx);
		assert.match(harness.widget().join(" "), /记了个大概（用了提示，按困难安排）/);
		const check = openTestDb();
		const attempt = check.prepare("SELECT assistance_level, verdict, explicit_rating FROM attempts WHERE item_id = 1").get() as any;
		const mastery = check.prepare("SELECT unassisted_good, assisted_good FROM mastery_state WHERE item_id = 1").get() as any;
		check.close();
		assert.deepEqual({ ...attempt }, { assistance_level: "hint", verdict: "correct", explicit_rating: "hard" });
		assert.deepEqual({ ...mastery }, { unassisted_good: 0, assisted_good: 1 }, "hint-correct is assisted evidence, never unassisted");
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("manual /anki:good is recorded as a conservative self-report, not objective evidence", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		const harness = await createHarness();
		const db = openTestDb();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown) VALUES('word','banana','香蕉',?,?,1)")
			.run(new Date().toISOString(), new Date(0).toISOString());
		db.close();
		await fake.fire();
		await harness.commands["anki:good"].handler("", harness.ctx);
		assert.match(harness.widget().join(" "), /自评兜底，按困难保守安排/);
		const check = openTestDb();
		const attempt = check.prepare("SELECT kind, status, explicit_rating, assistance_level, question_text FROM attempts WHERE item_id = 1").get() as any;
		const mastery = check.prepare("SELECT stage, unassisted_good, assisted_good FROM mastery_state WHERE item_id = 1").get() as any;
		check.close();
		assert.deepEqual({ ...attempt }, { kind: "recall_self_report", status: "self_report", explicit_rating: "hard", assistance_level: "none", question_text: "默写单词「香蕉」的英文" });
		assert.deepEqual({ ...mastery }, { stage: "exposure", unassisted_good: 0, assisted_good: 0 }, "self-report produces no objective evidence");
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("word/phrase assistance persists across sessions (hint in A, answered in B still caps Hard)", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 0 });
		const a = await makeSession({ sessionId: "assist-a" });
		const db = openTestDb();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown) VALUES('word','cherry','樱桃',?,?,1)")
			.run(new Date().toISOString(), new Date(0).toISOString());
		db.close();
		await fake.fire();
		await a.commands["anki:hint"].handler("", a.ctx);
		// B attaches after the hint: it must still see assistance=hint.
		const b = await makeSession({ sessionId: "assist-b" });
		await b.commands["anki:answer"].handler("cherry", b.ctx);
		const check = openTestDb();
		const attempt = check.prepare("SELECT assistance_level, explicit_rating FROM attempts WHERE item_id = 1").get() as any;
		check.close();
		assert.deepEqual({ ...attempt }, { assistance_level: "hint", explicit_rating: "hard" }, "assistance survived reattachment and capped the rating");
		await a.handlers.session_shutdown({ reason: "quit" }, a.ctx);
		await b.handlers.session_shutdown({ reason: "quit" }, b.ctx);
	} finally {
		fake.restore();
	}
});

// -- P0-1 direction-independent scheduling (harness level) -----------------

test("after a forward Again, a due reverse surfaces in reverse direction", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		const harness = await createHarness();
		const db = openTestDb();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown) VALUES('word','grape','葡萄',?,?,1)")
			.run(new Date().toISOString(), new Date(0).toISOString());
		db.close();
		await fake.fire();
		assert.match(harness.widget().join(" "), /默写单词「葡萄」的英文/, "first surfacing defaults to forward production");
		await harness.commands["anki:again"].handler("", harness.ctx);
		// Forward was just rated (due soon); simulate time passing so only the
		// reverse direction is due, and the item itself is due again.
		const db2 = openTestDb();
		db2.prepare("UPDATE direction_state SET due_at = ? WHERE item_id = 1 AND direction = 'forward'").run("2099-01-01T00:00:00.000Z");
		db2.prepare("UPDATE direction_state SET due_at = ? WHERE item_id = 1 AND direction = 'reverse'").run(new Date(0).toISOString());
		db2.prepare("UPDATE items SET due_at = ? WHERE id = 1").run(new Date(0).toISOString());
		db2.prepare("UPDATE runtime_state SET active_item_id = NULL, next_check_at = ? WHERE id = 1").run(new Date(0).toISOString());
		db2.close();
		await fake.fire();
		assert.match(harness.widget().join(" "), /写出单词「grape」的中文释义/, "the due reverse direction surfaces, not a random one");
		const check = openTestDb();
		const state = check.prepare("SELECT active_direction FROM runtime_state WHERE id = 1").get() as any;
		const dirs = check.prepare("SELECT direction, fsrs_state FROM direction_state WHERE item_id = 1 ORDER BY direction").all() as any[];
		check.close();
		assert.equal(state.active_direction, "reverse");
		assert.ok(dirs.every((d) => typeof d.fsrs_state === "string"), "both direction rows exist after the first rating");
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

// -- Ambiguous forward production prompts (book/reserve → 预订) -------------

test("meaning-colliding forward reviews show target cues and matching audit snapshots", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 0 });
		const harness = await makeSession({ sessionId: "ambiguous-cue" });
		const db = openTestDb();
		db.prepare("INSERT INTO items(type,text,meaning,example,learned_at,due_at,shown) VALUES('word','book','预订',?,?,?,1)")
			.run("I want to book a table for two.", new Date().toISOString(), new Date(0).toISOString());
		db.prepare("INSERT INTO items(type,text,meaning,example,learned_at,due_at,shown) VALUES('word','reserve','预订',?,?,?,1)")
			.run("I want to reserve a table for two.", new Date().toISOString(), new Date(0).toISOString());
		db.close();

		await fake.fire();
		assert.match(harness.widget().join(" "), /默写单词「预订」的英文（例：I want to ____ a table for two\.）/);
		await harness.commands["anki:answer"].handler("", harness.ctx);
		assert.match(harness.widget().join(" "), /默写单词「预订」的英文（例：/);
		await harness.commands["anki:answer"].handler("book", harness.ctx);
		let check = openTestDb();
		let attempt = check.prepare("SELECT question_text FROM attempts WHERE item_id = 1 ORDER BY id DESC LIMIT 1").get() as any;
		check.close();
		assert.equal(attempt.question_text, "默写单词「预订」的英文（例：I want to ____ a table for two.）");

		assert.match(harness.widget().join(" "), /默写单词「预订」的英文（例：I want to ____ a table for two\.）/);
		await harness.commands["anki:answer"].handler("reserve", harness.ctx);
		check = openTestDb();
		attempt = check.prepare("SELECT question_text FROM attempts WHERE item_id = 2 ORDER BY id DESC LIMIT 1").get() as any;
		check.close();
		assert.equal(attempt.question_text, "默写单词「预订」的英文（例：I want to ____ a table for two.）");
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("forward reviews retain pre-answer context even with a POS-plus-clue meaning", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 0 });
		const harness = await makeSession({ sessionId: "unambiguous-word" });
		const db = openTestDb();
		db.prepare("INSERT INTO items(type,text,meaning,example,learned_at,due_at,shown) VALUES('word','apple','苹果（可数名词，一种常见水果）',?,?,?,1)")
			.run("I eat an apple every day.", new Date().toISOString(), new Date(0).toISOString());
		db.close();
		await fake.fire();
		const shown = harness.widget().join(" ");
		assert.match(shown, /默写单词「苹果（可数名词，一种常见水果）」的英文/);
		assert.match(shown, /例：I eat an ____ every day/);
		await harness.commands["anki:answer"].handler("apple", harness.ctx);
		const check = openTestDb();
		const attempt = check.prepare("SELECT question_text FROM attempts WHERE item_id = 1 ORDER BY id DESC LIMIT 1").get() as any;
		check.close();
		assert.equal(attempt.question_text, "默写单词「苹果（可数名词，一种常见水果）」的英文（例：I eat an ____ every day.）");
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("goal review with generic parentheses logs the same pre-answer context used for grading", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 0 });
		const harness = await makeSession({ sessionId: "goal-visible-context" });
		const db = openTestDb();
		db.prepare("INSERT INTO items(type,text,meaning,example,example_cn,learned_at,due_at,shown) VALUES('word','goal','目标（可数名词，指希望达到的结果）',?,?,?,?,1)")
			.run("My main goal this month is to learn fifty useful English words for travel.", "我这个月的主要目标是学习五十个有用的旅行英语单词。", new Date().toISOString(), new Date(0).toISOString());
		db.close();
		await fake.fire();
		const shown = harness.widget().join(" ");
		assert.doesNotMatch(shown, /首字母|开头|字母|词长/);
		assert.match(shown, /My main ____ this month/);
		assert.match(shown, /语境：我这个月的主要目标/);
		const legacy = openTestDb();
		legacy.prepare("UPDATE items SET meaning='目标 goal（可数名词，指希望达到的结果）' WHERE id=1").run();
		legacy.close();
		await harness.commands["anki:answer"].handler("", harness.ctx);
		assert.doesNotMatch(harness.widget().join(" "), /\bgoal\b/i, "empty-answer reminder must use the same safe question");
		await harness.commands["anki:answer"].handler("goal", harness.ctx);
		const check = openTestDb();
		const attempt = check.prepare("SELECT question_text FROM attempts WHERE item_id=1 ORDER BY id DESC LIMIT 1").get() as any;
		check.close();
		assert.match(attempt.question_text, /例：My main ____ this month/);
		assert.match(attempt.question_text, /语境：我这个月的主要目标/);
		assert.doesNotMatch(attempt.question_text, /\bgoal\b/i);
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally { fake.restore(); }
});

test("thin unique forward reviews show masked-example context without spelling hints", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 0 });
		const harness = await makeSession({ sessionId: "thin-unique-word" });
		const db = openTestDb();
		db.prepare("INSERT INTO items(type,text,meaning,example,learned_at,due_at,shown) VALUES('word','apple','苹果',?,?,?,1)")
			.run("I eat an apple every day.", new Date().toISOString(), new Date(0).toISOString());
		db.close();
		await fake.fire();
		assert.match(harness.widget().join(" "), /默写单词「苹果」的英文（例：I eat an ____ every day\.）/);
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

// -- /anki:add custom queue release (harness level) ------------------------

function queueWord(text: string, meaning: string) {
	return { type: "word", text, phonetic: "/x/", meaning: `${meaning}（名词，义项线索）`, example: `The ${text} helps.`, example_cn: `${meaning}有帮助。` };
}

function queueCloze() {
	return {
		type: "cloze",
		text: "The report that ___ (submit) yesterday is now public.",
		phonetic: "",
		meaning: "was submitted",
		example: "The report that was submitted yesterday is now public.",
		example_cn: "昨天提交的那份报告现在公开了。",
		chunks: ["The report", "that was submitted yesterday", "is now public"],
	};
}

/** Stage a finished card in custom_card_queue the way /anki:add does. */
function enqueueCustom(db: DatabaseSync, item: { type: string; text: string; meaning: string }) {
	db.prepare("INSERT INTO custom_card_queue (created_at, prompt, fingerprint, payload) VALUES (?, ?, ?, ?)")
		.run(new Date().toISOString(), "test", contentFingerprint(item.type, item.text, item.meaning), JSON.stringify(item));
}

const queueLength = (db: DatabaseSync) =>
	Number((db.prepare("SELECT COUNT(*) AS n FROM custom_card_queue").get() as any).n);

/** Make the global slot claimable: no active card, pacing window elapsed. */
function clearGlobalSlot(db: DatabaseSync) {
	db.prepare("UPDATE runtime_state SET active_item_id = NULL, next_check_at = ? WHERE id = 1").run(new Date(0).toISOString());
}

/** Await an async condition by draining microtasks/macrotasks. */
async function until(fake: ReturnType<typeof installFakeTimers>, condition: () => boolean, label: string) {
	for (let i = 0; i < 200 && !condition(); i++) await fake.flush();
	assert.ok(condition(), label);
}

test("queued custom cards release FIFO: first card activated as teach, rest wait shown=0", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 0 });
		const harness = await makeSession({ sessionId: "custom-release-fifo" });
		const db = openTestDb();
		enqueueCustom(db, queueWord("alpha", "阿尔法"));
		enqueueCustom(db, queueWord("beta", "贝塔"));
		enqueueCustom(db, queueWord("gamma", "伽马"));
		clearGlobalSlot(db);
		db.close();
		await fake.fire();
		const check = openTestDb();
		const items = (check.prepare("SELECT text, shown, introduced_at IS NOT NULL AS stamped, introduction_kind FROM items ORDER BY id").all() as any[]).map((row) => ({ ...row }));
		const state = check.prepare("SELECT active_item_id, active_kind FROM runtime_state WHERE id=1").get() as any;
		const queued = queueLength(check);
		check.close();
		assert.deepEqual(items, [
			{ text: "alpha", shown: 1, stamped: 1, introduction_kind: "custom" },
			{ text: "beta", shown: 0, stamped: 0, introduction_kind: "custom" },
			{ text: "gamma", shown: 0, stamped: 0, introduction_kind: "custom" },
		]);
		assert.equal(state.active_item_id, 1, "the first queued card is activated immediately");
		assert.equal(state.active_kind, "teach");
		assert.equal(queued, 0, "released rows leave the queue");
		assert.match(harness.widget().join(" "), /阿尔法/);
		assert.doesNotMatch(harness.widget().join(" "), /alpha/);
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("a cloze at the head of the custom queue is activated as a review quiz", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 0 });
		const harness = await makeSession({ sessionId: "custom-release-cloze" });
		const db = openTestDb();
		enqueueCustom(db, queueCloze());
		enqueueCustom(db, queueWord("beta", "贝塔"));
		clearGlobalSlot(db);
		db.close();
		await fake.fire();
		const check = openTestDb();
		const state = check.prepare("SELECT active_item_id, active_kind FROM runtime_state WHERE id=1").get() as any;
		const queued = queueLength(check);
		check.close();
		assert.equal(state.active_item_id, 1, "the queued cloze is activated first");
		assert.equal(state.active_kind, "review", "cloze cards quiz from the very first showing");
		assert.equal(queued, 0);
		assert.match(harness.widget().join(" "), /___/, "the quiz face shows the blanked sentence");
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("custom release is capped by the day's remaining new-card quota", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 2 });
		const harness = await makeSession({ sessionId: "custom-quota-cap" });
		const db = openTestDb();
		for (const text of ["q1", "q2", "q3", "q4", "q5"]) enqueueCustom(db, queueWord(text, `词 ${text}`));
		clearGlobalSlot(db);
		db.close();
		await fake.fire();
		const check = openTestDb();
		const released = Number((check.prepare("SELECT COUNT(*) AS n FROM items").get() as any).n);
		const queued = queueLength(check);
		const state = check.prepare("SELECT active_kind FROM runtime_state WHERE id=1").get() as any;
		check.close();
		assert.equal(released, 2, "only the remaining quota is released");
		assert.equal(queued, 3, "the rest stays queued for later days");
		assert.equal(state.active_kind, "teach");
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("a queue shorter than the quota releases everything at once", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 11 });
		const harness = await makeSession({ sessionId: "custom-quota-short" });
		const db = openTestDb();
		for (const text of ["r1", "r2", "r3", "r4", "r5"]) enqueueCustom(db, queueWord(text, `词 ${text}`));
		clearGlobalSlot(db);
		db.close();
		await fake.fire();
		const check = openTestDb();
		const released = Number((check.prepare("SELECT COUNT(*) AS n FROM items").get() as any).n);
		const queued = queueLength(check);
		check.close();
		assert.equal(released, 5, "a short queue releases in full");
		assert.equal(queued, 0);
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("a long queue releases at most the full daily quota", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 11 });
		const harness = await makeSession({ sessionId: "custom-quota-long" });
		const db = openTestDb();
		for (let i = 1; i <= 15; i++) enqueueCustom(db, queueWord(`long${i}`, `词 ${i}`));
		clearGlobalSlot(db);
		db.close();
		await fake.fire();
		const check = openTestDb();
		const released = Number((check.prepare("SELECT COUNT(*) AS n FROM items").get() as any).n);
		const queued = queueLength(check);
		check.close();
		assert.equal(released, 11, "exactly the daily quota is released");
		assert.equal(queued, 4);
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("custom release defers while a global card is active or replacements are pending", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		// Scenario 1: an active global card short-circuits petTick before release.
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 0 });
		let harness = await makeSession({ sessionId: "custom-defer-active" });
		let db = openTestDb();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown) VALUES('word','busy','忙',?,?,1)")
			.run(new Date().toISOString(), "2099-01-01T00:00:00.000Z");
		db.prepare("UPDATE runtime_state SET active_item_id=1, active_kind='review', active_version=1, next_check_at=? WHERE id=1")
			.run(new Date(0).toISOString());
		enqueueCustom(db, queueWord("hold1", "扣一"));
		enqueueCustom(db, queueWord("hold2", "扣二"));
		db.close();
		await fake.fire();
		db = openTestDb();
		assert.equal(queueLength(db), 2, "active card: queue untouched");
		assert.equal(Number((db.prepare("SELECT COUNT(*) AS n FROM items").get() as any).n), 1, "active card: nothing released");
		db.close();
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);

		// Scenario 2: a pending replacement obligation gates the release too.
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 3 });
		harness = await makeSession({ sessionId: "custom-defer-replacement" });
		db = openTestDb();
		db.prepare("INSERT INTO stats(key, value) VALUES('pending_replacements', ?)").run(JSON.stringify(["word"]));
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown) VALUES('word','skipme','已跳',?,?,1)")
			.run(new Date().toISOString(), "2099-01-01T00:00:00.000Z");
		enqueueCustom(db, queueWord("hold3", "扣三"));
		enqueueCustom(db, queueWord("hold4", "扣四"));
		clearGlobalSlot(db);
		db.close();
		await fake.fire();
		await fake.flush();
		db = openTestDb();
		assert.equal(queueLength(db), 2, "pending replacement: queue untouched");
		assert.equal(Number((db.prepare("SELECT COUNT(*) AS n FROM items WHERE introduction_kind='custom'").get() as any).n), 0, "pending replacement: nothing released");
		db.close();
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("custom release defers while a review is due or the daily quota is exhausted", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		// Scenario 1: a due review wins the tick before any custom release.
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 0 });
		let harness = await makeSession({ sessionId: "custom-defer-due" });
		let db = openTestDb();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown) VALUES('word','review','复习',?,?,1)")
			.run(new Date().toISOString(), new Date(0).toISOString());
		enqueueCustom(db, queueWord("hold5", "扣五"));
		enqueueCustom(db, queueWord("hold6", "扣六"));
		clearGlobalSlot(db);
		db.close();
		await fake.fire();
		db = openTestDb();
		assert.equal(queueLength(db), 2, "due review: queue untouched");
		const state = db.prepare("SELECT active_item_id FROM runtime_state WHERE id=1").get() as any;
		db.close();
		assert.equal(state.active_item_id, 1, "the due review is claimed instead");
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);

		// Scenario 2: the daily quota is already spent.
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 1 });
		harness = await makeSession({ sessionId: "custom-defer-quota" });
		db = openTestDb();
		const now = new Date().toISOString();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown,introduced_at,introduction_kind) VALUES('word','spent','已用',?,?,1,?,'planned')")
			.run(now, "2099-01-01T00:00:00.000Z", now);
		enqueueCustom(db, queueWord("hold7", "扣七"));
		enqueueCustom(db, queueWord("hold8", "扣八"));
		clearGlobalSlot(db);
		db.close();
		await fake.fire();
		db = openTestDb();
		assert.equal(queueLength(db), 2, "quota exhausted: queue untouched");
		assert.equal(Number((db.prepare("SELECT COUNT(*) AS n FROM items").get() as any).n), 1, "quota exhausted: nothing released");
		const idle = db.prepare("SELECT active_item_id FROM runtime_state WHERE id=1").get() as any;
		db.close();
		assert.equal(idle.active_item_id, null, "no card is activated over quota");
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("a fingerprint collision drops only the queued row; the rest still release", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	try {
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 3 });
		const harness = await makeSession({ sessionId: "custom-collision" });
		const db = openTestDb();
		const now = new Date().toISOString();
		// The deck already contains "menu" (introduced today): the queued copy collides.
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown,introduced_at,introduction_kind,content_fingerprint) VALUES('word','menu','菜单',?,?,1,?,'planned',?)")
			.run(now, "2099-01-01T00:00:00.000Z", now, contentFingerprint("word", "menu", "菜单"));
		enqueueCustom(db, queueWord("menu", "菜单"));
		enqueueCustom(db, queueWord("bill", "账单"));
		clearGlobalSlot(db);
		db.close();
		await fake.fire();
		const check = openTestDb();
		const items = (check.prepare("SELECT text, shown, introduction_kind FROM items ORDER BY id").all() as any[]).map((row) => ({ ...row }));
		const state = check.prepare("SELECT active_item_id, active_kind FROM runtime_state WHERE id=1").get() as any;
		const queued = queueLength(check);
		check.close();
		assert.deepEqual(items, [
			{ text: "menu", shown: 1, introduction_kind: "planned" },
			{ text: "bill", shown: 1, introduction_kind: "custom" },
		], "the colliding row inserts nothing; the fresh row still releases");
		assert.equal(queued, 0, "both queue rows are consumed");
		assert.equal(state.active_item_id, 2, "the first releasable card is activated");
		assert.equal(state.active_kind, "teach");
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		fake.restore();
	}
});

test("after a custom release, the remaining quota triggers a partial lesson batch", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-custom-partial" });
	try {
		// A 9-word lesson exactly fills 11 - 2 custom cards; the default {10,1}
		// batch shape would reject this response (INVALID_LESSON_SHAPE).
		const partialLesson = JSON.stringify({
			ready: true,
			topic: "aviation",
			items: ["aviation", "cockpit", "turbulence", "altitude", "runway", "hangar", "taxiway", "beacon", "vector"].map((text) => ({
				type: "word", text, phonetic: "/x/", meaning: `词 ${text}（名词，义项线索）`,
				example: `The ${text} matters.`, example_cn: `${text} 很重要。`,
			})),
		});
		registration.setResponses([
			fauxAssistantMessage(partialLesson),
			fauxAssistantMessage(JSON.stringify({ pass: true, issues: [], summary: "ok" })),
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 11 });
		const harness = await makeSession({ model, modelRegistry: registry, sessionId: "custom-partial" });
		const db = openTestDb();
		enqueueCustom(db, queueWord("alpha", "阿尔法"));
		enqueueCustom(db, queueWord("beta", "贝塔"));
		clearGlobalSlot(db);
		db.close();

		await fake.fire(); // release: alpha activated (teach).
		await harness.commands["anki:good"].handler("", harness.ctx);
		assert.match(harness.widget().join(" "), /贝塔/, "rating alpha immediately claims the next stored custom card");
		await harness.commands["anki:good"].handler("", harness.ctx);
		// The rating pushed the pacing window to the next interval; simulate the
		// elapsed interval so the deferred partial-batch generation can run.
		{ const c = openTestDb(); c.prepare("UPDATE runtime_state SET next_check_at = ? WHERE id=1").run(new Date(0).toISOString()); c.close(); }
		await fake.fire(); // no due cards left: generate a partial lesson for the 9 remaining slots.
		await until(fake, () => {
			const check = openTestDb();
			const n = Number((check.prepare("SELECT COUNT(*) AS n FROM items").get() as any).n);
			check.close();
			return n === 11;
		}, "partial lesson fills the remaining 9 slots");

		const check = openTestDb();
		const byKind = Object.fromEntries(
			(check.prepare("SELECT introduction_kind, COUNT(*) AS n FROM items GROUP BY introduction_kind").all() as any[])
				.map((row) => [row.introduction_kind, row.n]),
		);
		const state = check.prepare("SELECT active_kind FROM runtime_state WHERE id=1").get() as any;
		check.close();
		assert.deepEqual(byKind, { custom: 2, planned: 9 }, "2 released custom cards + a 9-item partial batch");
		assert.equal(state.active_kind, "teach", "the first partial-batch card is activated");
		assert.equal(registration.state.callCount, 2, "one generation + one critic call, no retries");
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		registration.unregister();
		fake.restore();
	}
});

test("/anki:add enqueues critic-approved cards and releases the first one immediately", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-add-cmd" });
	try {
		registration.setResponses([
			fauxAssistantMessage(JSON.stringify({
				ready: true,
				items: [
					{ type: "word", text: "napkin", phonetic: "/ˈnæpkɪn/", meaning: "餐巾（名词，义项线索）", example: "Please hand me a napkin.", example_cn: "请递给我一张餐巾。" },
					{ type: "word", text: "receipt", phonetic: "/rɪˈsiːt/", meaning: "收据（名词，义项线索）", example: "Keep the receipt for returns.", example_cn: "退货要保留收据。" },
				],
			})),
			fauxAssistantMessage(JSON.stringify({ pass: true, issues: [], summary: "ok" })),
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 5 });
		const harness = await makeSession({ model, modelRegistry: registry, sessionId: "add-immediate" });
		const db = openTestDb();
		clearGlobalSlot(db);
		db.close();

		await harness.commands["anki:add"].handler("2 张餐厅常用词", harness.ctx);
		await until(fake, () => {
			const check = openTestDb();
			const active = (check.prepare("SELECT active_item_id FROM runtime_state WHERE id=1").get() as any).active_item_id;
			check.close();
			return active != null;
		}, "the first enqueued card is released right after /anki:add");

		const check = openTestDb();
		const items = (check.prepare("SELECT text, shown, introduction_kind FROM items ORDER BY id").all() as any[]).map((row) => ({ ...row }));
		const queued = queueLength(check);
		const state = check.prepare("SELECT active_item_id, active_kind FROM runtime_state WHERE id=1").get() as any;
		check.close();
		assert.deepEqual(items, [
			{ text: "napkin", shown: 1, introduction_kind: "custom" },
			{ text: "receipt", shown: 0, introduction_kind: "custom" },
		]);
		assert.equal(queued, 0, "both cards moved into items within the quota");
		assert.equal(state.active_item_id, 1);
		assert.equal(state.active_kind, "teach");
		assert.match(harness.widget().join(" "), /餐巾/);
		assert.doesNotMatch(harness.widget().join(" "), /napkin/);
		assert.ok(harness.notifications().some((message) => message.includes("已做好 2 张卡并入队")));
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally {
		registration.unregister();
		fake.restore();
	}
});

test("background replacements drain FIFO with an active card and do not change its version", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-background-replacement" });
	try {
		registration.setResponses(["morning", "evening"].flatMap((text) => [
			fauxAssistantMessage(JSON.stringify({ ready: true, item: { type: "word", text, meaning: text === "morning" ? "早晨（名词，义项线索）" : "傍晚（名词，义项线索）", example: `Good ${text}.`, example_cn: "你好。" } })),
			fauxAssistantMessage(JSON.stringify({ pass: true, issues: [], summary: "approved" })),
		]));
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 0, dailyNewLimit: 1 });
		const harness = await makeSession({ model, modelRegistry: registry, branch: [] });
		const db = openTestDb();
		const now = new Date().toISOString();
		db.prepare("INSERT INTO items(type,text,meaning,status,learned_at,due_at,shown) VALUES('word','known','已会','mastered',?,?,1)").run(now, now);
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown) VALUES('word','current','当前',?,?,1)").run(now, now);
		db.prepare("UPDATE runtime_state SET active_item_id=2, active_kind='review', active_version=7 WHERE id=1").run();
		db.prepare("INSERT INTO stats(key,value) VALUES('pending_replacements',?)").run(JSON.stringify(["word", "word"]));
		db.close();
		await fake.firePoll();
		for (let i = 0; i < 2; i++) {
			assert.equal(fake.replacements().length, 1);
			assert.equal(fake.replacements()[0].delay, 0, "successful refill schedules the next immediately");
			await fake.fire(fake.replacements()[0]);
			await fake.flush();
		}
		const check = openTestDb();
		assert.deepEqual({ ...check.prepare("SELECT active_item_id,active_version FROM runtime_state WHERE id=1").get()! }, { active_item_id: 2, active_version: 7 });
		const cards = check.prepare("SELECT shown,introduced_at FROM items WHERE introduction_kind='replacement'").all() as any[];
		assert.equal(cards.length, 2);
		assert.ok(cards.every((card) => card.shown === 0 && card.introduced_at == null));
		assert.equal((check.prepare("SELECT value FROM stats WHERE key='pending_replacements'").get() as any).value, "[]");
		assert.equal(Number((check.prepare("SELECT value FROM stats WHERE key='total_learned'").get() as any)?.value ?? 0), 0, "inventory does not count as studied");
		check.close();
		assert.equal(registration.state.callCount, 4);
		assert.equal(fake.replacements().length, 0);
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
		assert.equal(fake.replacements().length, 0);
	} finally { registration.unregister(); fake.restore(); }
});

test("background replacement rejection retries empty RPC context after cooldown and stops on shutdown", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const originalNow = Date.now;
	const registration = registerFauxProvider({ provider: "kaomoji-background-retry" });
	try {
		registration.setResponses([
			fauxAssistantMessage(JSON.stringify({ ready: false, reason: "try later" })),
			fauxAssistantMessage(JSON.stringify({ ready: true, item: { type: "word", text: "morning", meaning: "早晨（名词，义项线索）", example: "Good morning.", example_cn: "早上好。" } })),
			fauxAssistantMessage(JSON.stringify({ pass: true, issues: [], summary: "approved" })),
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 0, dailyNewLimit: 1 });
		const harness = await makeSession({ model, modelRegistry: registry, branch: [] });
		const db = openTestDb();
		const now = new Date().toISOString();
		db.prepare("INSERT INTO items(type,text,meaning,status,learned_at,due_at,shown) VALUES('word','known','已会','mastered',?,?,1)").run(now, now);
		db.prepare("INSERT INTO stats(key,value) VALUES('pending_replacements','[\"word\"]')").run();
		db.close();
		await fake.firePoll();
		await fake.fire(fake.replacements()[0]);
		await fake.flush();
		assert.equal(registration.state.callCount, 1);
		assert.equal(fake.replacements().length, 1);
		assert.ok(fake.replacements()[0].delay > 29_000);
		const check = openTestDb();
		assert.equal((check.prepare("SELECT value FROM stats WHERE key='pending_replacements'").get() as any).value, '["word"]');
		check.close();
		Date.now = () => originalNow() + 31_000;
		await fake.fire(fake.replacements()[0]);
		await fake.flush();
		assert.equal(registration.state.callCount, 3, "same empty branch can retry after rejection expires");
		const after = openTestDb();
		assert.equal((after.prepare("SELECT value FROM stats WHERE key='pending_replacements'").get() as any).value, "[]");
		after.prepare("UPDATE stats SET value='[\"word\"]' WHERE key='pending_replacements'").run();
		after.close();
		await fake.firePoll();
		assert.equal(fake.replacements().length, 1);
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
		assert.equal(fake.replacements().length, 0, "shutdown cancels queued refill work");
	} finally { Date.now = originalNow; registration.unregister(); fake.restore(); }
});

test("two sessions share one background replacement lease", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-background-lease" });
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	try {
		registration.setResponses([
			async () => { await gate; return fauxAssistantMessage(JSON.stringify({ ready: true, item: { type: "word", text: "morning", meaning: "早晨（名词，义项线索）", example: "Good morning.", example_cn: "早上好。" } })); },
			fauxAssistantMessage(JSON.stringify({ pass: true, issues: [], summary: "approved" })),
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 0, dailyNewLimit: 1 });
		const first = await makeSession({ model, modelRegistry: registry, sessionId: "refill-one", branch: [] });
		const second = await makeSession({ model, modelRegistry: registry, sessionId: "refill-two", branch: [] });
		const db = openTestDb();
		const now = new Date().toISOString();
		db.prepare("INSERT INTO items(type,text,meaning,status,learned_at,due_at,shown) VALUES('word','known','已会','mastered',?,?,1)").run(now, now);
		db.prepare("INSERT INTO stats(key,value) VALUES('pending_replacements','[\"word\"]')").run();
		db.close();
		await fake.firePoll();
		const scheduled = fake.replacements();
		assert.equal(scheduled.length, 2);
		await fake.fire(scheduled[0]);
		await fake.fire(scheduled[1]);
		assert.equal(registration.state.callCount, 1, "only the lease owner invokes generation");
		release();
		await fake.flush();
		await fake.flush();
		const check = openTestDb();
		assert.equal((check.prepare("SELECT COUNT(*) AS n FROM items WHERE introduction_kind='replacement'").get() as any).n, 1);
		assert.equal((check.prepare("SELECT value FROM stats WHERE key='pending_replacements'").get() as any).value, "[]");
		check.close();
		await first.handlers.session_shutdown({ reason: "quit" }, first.ctx);
		await second.handlers.session_shutdown({ reason: "quit" }, second.ctx);
		assert.equal(fake.replacements().length, 0);
	} finally { release(); registration.unregister(); fake.restore(); }
});

test("direct skip completion cancels the worker busy cooldown and immediately continues refill", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "kaomoji-direct-refill-resume" });
	let release!: () => void;
	let started!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const generating = new Promise<void>((resolve) => { started = resolve; });
	const generated = (text: string) => fauxAssistantMessage(JSON.stringify({ ready: true, item: { type: "word", text, meaning: text === "morning" ? "早晨（名词，义项线索）" : "傍晚（名词，义项线索）", example: `Good ${text}.`, example_cn: "你好。" } }));
	try {
		registration.setResponses([
			async () => { started(); await gate; return generated("morning"); },
			fauxAssistantMessage(JSON.stringify({ pass: true, issues: [], summary: "approved" })),
			generated("evening"),
			fauxAssistantMessage(JSON.stringify({ pass: true, issues: [], summary: "approved" })),
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 1 });
		const harness = await makeSession({ model, modelRegistry: registry });
		const db = openTestDb(); insertDueWord(db, "known", "已会"); db.close();
		await fake.fire();
		const seeded = openTestDb();
		seeded.prepare("INSERT INTO stats(key,value) VALUES('pending_replacements','[\"word\"]')").run();
		seeded.close();
		const skip = harness.commands["anki:skip"].handler("", harness.ctx);
		await generating;
		await fake.fire(fake.replacements()[0]);
		assert.equal(fake.replacements().length, 1);
		assert.ok(fake.replacements()[0].delay > 29_000, "worker backs off while direct skip is generating");
		release();
		await skip;
		assert.equal(fake.replacements().length, 1);
		assert.equal(fake.replacements()[0].delay, 0, "successful direct generation replaces the stale busy timer");
		await fake.fire(fake.replacements()[0]);
		await fake.flush();
		const check = openTestDb();
		assert.equal((check.prepare("SELECT value FROM stats WHERE key='pending_replacements'").get() as any).value, "[]");
		assert.equal((check.prepare("SELECT COUNT(*) AS n FROM items WHERE introduction_kind='replacement'").get() as any).n, 2);
		assert.equal((check.prepare("SELECT active_item_id FROM runtime_state WHERE id=1").get() as any).active_item_id, 2);
		check.close();
		assert.equal(registration.state.callCount, 4);
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally { release(); registration.unregister(); fake.restore(); }
});

function manualLessonResponse(topic = "manual vocabulary") {
	return JSON.stringify({ ready: true, topic, items: lessonItems().slice(0, 5) });
}

test("desktop RPC fills today's remaining stock in serial batches even with five existing cards, then stays idle across restart", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "desktop-daily-batches" });
	const previousClient = process.env.IELTS_ANKI_CLIENT;
	process.env.IELTS_ANKI_CLIENT = "desktop";
	try {
		registration.setResponses([
			fauxAssistantMessage(JSON.stringify({ ready: true, topic: "batch one", items: lessonItems().slice(0, 10) })),
			fauxAssistantMessage(JSON.stringify({ pass: true, issues: [], summary: "approved" })),
			fauxAssistantMessage(JSON.stringify({ ready: true, topic: "batch two", items: [queueWord("morning", "早晨"), queueWord("garden", "花园"), queueWord("window", "窗户")] })),
			fauxAssistantMessage(JSON.stringify({ pass: true, issues: [], summary: "approved" })),
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 18 });
		const harness = await makeSession({ model, modelRegistry: registry, mode: "rpc", branch: [] });
		const db = openTestDb();
		for (let i = 0; i < 5; i++) insertDueWord(db, `stored-${i}`, `库存${i}`);
		db.exec("UPDATE items SET introduction_kind='planned'");
		const before = db.prepare("SELECT active_item_id,active_version,next_check_at FROM runtime_state").get();
		await fake.fire(fake.refills()[0]); await fake.flush();
		assert.equal(db.prepare("SELECT COUNT(*) n FROM items WHERE shown=0").get()?.n, 15);
		assert.equal(fake.refills().length, 1, "the remaining batch is scheduled immediately");
		await fake.fire(fake.refills()[0]); await fake.flush();
		assert.equal(db.prepare("SELECT COUNT(*) n FROM items WHERE shown=0").get()?.n, 18);
		assert.equal(registration.state.callCount, 4);
		const status = JSON.parse(String(db.prepare("SELECT value FROM stats WHERE key='auto_refill_status'").get()?.value));
		assert.equal(status.strategy, "daily"); assert.equal(status.phase, "ready");
		assert.equal(status.inventory + status.queued, status.target);
		assert.deepEqual(db.prepare("SELECT active_item_id,active_version,next_check_at FROM runtime_state").get(), before);
		await fake.firePoll();
		assert.equal(fake.refills().length, 0);
		await harness.handlers.session_start({ reason: "reload" }, harness.ctx);
		assert.equal(fake.refills().length, 0, "reopening does not generate another day-sized batch");
		assert.equal(registration.state.callCount, 4);
		db.close();
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally { if (previousClient == null) delete process.env.IELTS_ANKI_CLIENT; else process.env.IELTS_ANKI_CLIENT = previousClient; registration.unregister(); fake.restore(); }
});

test("desktop daily save rechecks a smaller remaining quota after another session introduces cards", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "desktop-daily-concurrent" });
	const previousClient = process.env.IELTS_ANKI_CLIENT;
	process.env.IELTS_ANKI_CLIENT = "desktop";
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	try {
		registration.setResponses([async () => { await gate; return fauxAssistantMessage(manualLessonResponse()); }, fauxAssistantMessage(JSON.stringify({ pass: true, issues: [], summary: "approved" }))]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 5 });
		const harness = await makeSession({ model, modelRegistry: registry, mode: "rpc", branch: [] });
		const db = openTestDb();
		await fake.fire(fake.refills()[0]);
		for (let i = 0; i < 3; i++) insertDueWord(db, `introduced-${i}`, `已学${i}`);
		db.prepare("UPDATE items SET shown=1,introduction_kind='planned',introduced_at=?").run(new Date().toISOString());
		release(); await fake.flush(); await fake.flush();
		assert.equal(db.prepare("SELECT COUNT(*) n FROM items WHERE shown=0").get()?.n, 2);
		assert.equal(db.prepare("SELECT COUNT(*) n FROM items").get()?.n, 5);
		assert.equal(fake.refills().length, 0);
		db.close();
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally { release(); if (previousClient == null) delete process.env.IELTS_ANKI_CLIENT; else process.env.IELTS_ANKI_CLIENT = previousClient; registration.unregister(); fake.restore(); }
});

test("a newer desktop session supersedes a late daily batch without duplicating inventory", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "desktop-daily-takeover" });
	const previousClient = process.env.IELTS_ANKI_CLIENT;
	process.env.IELTS_ANKI_CLIENT = "desktop";
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	try {
		registration.setResponses([
			async () => { await gate; return fauxAssistantMessage(manualLessonResponse()); },
			fauxAssistantMessage(manualLessonResponse()),
			fauxAssistantMessage(JSON.stringify({ pass: true, issues: [], summary: "approved" })),
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 5 });
		const a = await makeSession({ model, modelRegistry: registry, mode: "rpc", branch: [] });
		await fake.fire(fake.refills()[0]);
		const b = await makeSession({ model, modelRegistry: registry, mode: "rpc", branch: [] });
		await fake.fire(fake.refills()[0]); await fake.flush();
		release(); await fake.flush(); await fake.flush();
		const db = openTestDb();
		assert.equal(db.prepare("SELECT COUNT(*) n FROM items").get()?.n, 5);
		assert.equal(JSON.parse(String(db.prepare("SELECT value FROM stats WHERE key='auto_refill_status'").get()?.value)).phase, "ready");
		db.close();
		await a.handlers.session_shutdown({ reason: "quit" }, a.ctx);
		await b.handlers.session_shutdown({ reason: "quit" }, b.ctx);
	} finally { release(); if (previousClient == null) delete process.env.IELTS_ANKI_CLIENT; else process.env.IELTS_ANKI_CLIENT = previousClient; registration.unregister(); fake.restore(); }
});

test("a desktop environment marker alone does not enable background preparation in CLI mode", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const previousClient = process.env.IELTS_ANKI_CLIENT;
	process.env.IELTS_ANKI_CLIENT = "desktop";
	try {
		const harness = await createHarness();
		assert.equal(fake.refills().length, 0);
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally { if (previousClient == null) delete process.env.IELTS_ANKI_CLIENT; else process.env.IELTS_ANKI_CLIENT = previousClient; fake.restore(); }
});

test("desktop daily failure keeps prepared cards and retries only the missing batch after thirty seconds", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "desktop-daily-retry" });
	const previousClient = process.env.IELTS_ANKI_CLIENT;
	const realDateNow = Date.now;
	process.env.IELTS_ANKI_CLIENT = "desktop";
	try {
		registration.setResponses([
			fauxAssistantMessage(JSON.stringify({ ready: true, topic: "batch one", items: lessonItems().slice(0, 10) })),
			fauxAssistantMessage(JSON.stringify({ pass: true, issues: [], summary: "approved" })),
			fauxAssistantMessage(JSON.stringify({ ready: false, reason: "temporary refusal" })),
			fauxAssistantMessage(JSON.stringify({ ready: true, topic: "batch two", items: [queueWord("morning", "早晨"), queueWord("garden", "花园"), queueWord("window", "窗户")] })),
			fauxAssistantMessage(JSON.stringify({ pass: true, issues: [], summary: "approved" })),
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 13 });
		const harness = await makeSession({ model, modelRegistry: registry, mode: "rpc", branch: [] });
		const db = openTestDb();
		await fake.fire(fake.refills()[0]); await fake.flush();
		await fake.fire(fake.refills()[0]); await fake.flush();
		const waiting = JSON.parse(String(db.prepare("SELECT value FROM stats WHERE key='auto_refill_status'").get()?.value));
		assert.equal(waiting.phase, "retry_wait");
		assert.equal(waiting.inventory, 10); assert.equal(waiting.target, 13);
		assert.ok(Date.parse(waiting.retryAt) - Date.now() > 29_000);
		await fake.firePoll();
		assert.equal(fake.refills().length, 0);
		Date.now = () => Date.parse(waiting.retryAt) + 1;
		await fake.firePoll();
		await fake.fire(fake.refills()[0]); await fake.flush();
		assert.equal(db.prepare("SELECT COUNT(*) n FROM items WHERE shown=0").get()?.n, 13);
		assert.equal(registration.state.callCount, 5);
		assert.equal(JSON.parse(String(db.prepare("SELECT value FROM stats WHERE key='auto_refill_status'").get()?.value)).phase, "ready");
		db.close();
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally { Date.now = realDateNow; if (previousClient == null) delete process.env.IELTS_ANKI_CLIENT; else process.env.IELTS_ANKI_CLIENT = previousClient; registration.unregister(); fake.restore(); }
});

test("RPC automatically stocks five cards during reviews without changing the active card or study history", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "auto-stock-review" });
	try {
		registration.setResponses([fauxAssistantMessage(manualLessonResponse()), fauxAssistantMessage(JSON.stringify({ pass: true, issues: [], summary: "approved" }))]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 18 });
		const harness = await makeSession({ model, modelRegistry: registry, mode: "rpc", branch: [] });
		const db = openTestDb();
		for (let i = 0; i < 36; i++) insertDueWord(db, `review-${i}`, `复习${i}`);
		db.exec("UPDATE items SET shown=1,reviews=1; UPDATE runtime_state SET active_item_id=1,active_kind='review',active_version=7,next_check_at='2099-01-01T00:00:00.000Z' WHERE id=1");
		const beforeState = db.prepare("SELECT active_item_id,active_version,next_check_at FROM runtime_state").get();
		const beforeItems = db.prepare("SELECT * FROM items").all();
		await fake.fire(fake.refills()[0]);
		await fake.flush();
		assert.equal(registration.state.callCount, 2);
		assert.equal(db.prepare("SELECT COUNT(*) n FROM items WHERE shown=0 AND introduced_at IS NULL").get()?.n, 5);
		assert.deepEqual(db.prepare("SELECT active_item_id,active_version,next_check_at FROM runtime_state").get(), beforeState);
		assert.deepEqual(db.prepare("SELECT * FROM items WHERE id<=36").all(), beforeItems);
		assert.equal(db.prepare("SELECT COUNT(*) n FROM attempts").get()?.n, 0);
		assert.equal(JSON.parse(String(db.prepare("SELECT value FROM stats WHERE key='auto_refill_status'").get()?.value)).phase, "ready");
		await fake.firePoll();
		assert.equal(fake.refills().length, 0, "a stocked reserve does not generate repeatedly");
		db.close();
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally { registration.unregister(); fake.restore(); }
});

test("RPC refill failure publishes a retry without delaying due reviews", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "auto-stock-failure" });
	try {
		registration.setResponses([fauxAssistantMessage(JSON.stringify({ ready: false, reason: "temporary refusal" }))]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 5 });
		const harness = await makeSession({ model, modelRegistry: registry, mode: "rpc", branch: [] });
		const db = openTestDb();
		insertDueWord(db, "review-retry", "复习");
		db.exec("UPDATE items SET shown=1,reviews=1");
		const pacing = db.prepare("SELECT next_check_at FROM runtime_state").get();
		await fake.fire(fake.refills()[0]);
		await fake.flush();
		const status = JSON.parse(String(db.prepare("SELECT value FROM stats WHERE key='auto_refill_status'").get()?.value));
		assert.equal(status.phase, "retry_wait");
		assert.ok(Date.parse(status.retryAt) > Date.now());
		assert.deepEqual(db.prepare("SELECT next_check_at FROM runtime_state").get(), pacing);
		await fake.fire();
		assert.equal(db.prepare("SELECT active_item_id FROM runtime_state").get()?.active_item_id, 1);
		assert.equal(registration.state.callCount, 1);
		db.close();
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally { registration.unregister(); fake.restore(); }
});

test("RPC refill discards a late batch after another session uses today's quota", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "auto-stock-quota" });
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	try {
		registration.setResponses([async () => { await gate; return fauxAssistantMessage(manualLessonResponse()); }, fauxAssistantMessage(JSON.stringify({ pass: true, issues: [], summary: "approved" }))]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 5 });
		const harness = await makeSession({ model, modelRegistry: registry, mode: "rpc", branch: [] });
		const db = openTestDb();
		await fake.fire(fake.refills()[0]);
		for (let i = 0; i < 5; i++) insertDueWord(db, `introduced-${i}`, `已学${i}`);
		db.prepare("UPDATE items SET shown=1,introduction_kind='planned',introduced_at=?").run(new Date().toISOString());
		release();
		await fake.flush();
		await fake.flush();
		assert.equal(db.prepare("SELECT COUNT(*) n FROM items").get()?.n, 5);
		assert.equal(JSON.parse(String(db.prepare("SELECT value FROM stats WHERE key='auto_refill_status'").get()?.value)).phase, "quota_reached");
		db.close();
		await harness.handlers.session_shutdown({ reason: "quit" }, harness.ctx);
	} finally { release(); registration.unregister(); fake.restore(); }
});
function manualBadQualityResponse() {
	const lesson = JSON.parse(manualLessonResponse());
	lesson.items[0].meaning = "协调";
	return JSON.stringify(lesson);
}

// Manual preparation is inventory work; its dedicated receipt is the UI contract.
const manualId = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
function manualReceipt(db: DatabaseSync, n: number): any {
	const raw = db.prepare("SELECT value FROM stats WHERE key=?").get(`teach_request:${manualId(n)}`) as any;
	return raw ? JSON.parse(raw.value) : undefined;
}
async function settleManual(fake: ReturnType<typeof installFakeTimers>, db: DatabaseSync, n: number) {
	for (let i = 0; i < 20; i++) {
		const receipt = manualReceipt(db, n);
		if (receipt?.phase === "succeeded" || receipt?.phase === "failed") return receipt;
		await fake.flush();
	}
	assert.fail(`manual request did not settle: ${JSON.stringify(manualReceipt(db, n))}`);
}

test("manual preparation saves new inventory with active card, full quota, due review and replacement pending", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "manual-inventory" });
	let s: Awaited<ReturnType<typeof makeSession>> | undefined;
	let db: DatabaseSync | undefined;
	try {
		registration.setResponses([fauxAssistantMessage(manualLessonResponse()), fauxAssistantMessage(JSON.stringify({ pass: true, issues: [], summary: "approved" }))]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 0, dailyNewLimit: 1 });
		s = await makeSession({ model, modelRegistry: registry });
		db = openTestDb();
		insertDueWord(db, "existing", "现有的（形容词）");
		insertDueWord(db, "reservoir", "水库（名词，义项线索）");
		db.prepare("UPDATE items SET shown=1, introduction_kind='planned', introduced_at=?, reviews=4 WHERE id=1").run(new Date().toISOString());
		db.prepare("UPDATE runtime_state SET active_item_id=1, active_kind='review', active_direction='reverse', active_version=17, next_check_at='2099-01-01T00:00:00.000Z' WHERE id=1").run();
		db.prepare("INSERT INTO stats(key,value) VALUES('pending_replacements','[\"word\"]')").run();
		db.prepare("INSERT INTO attempts(id,item_id,review_cycle_id,claim_key,question_version,evaluation_version,kind,assistance_level,status,started_at) VALUES('attempt-before',1,'cycle-before','claim-before',1,1,'review','none','self_report',?)").run(new Date().toISOString());
		const oldItems = db.prepare("SELECT * FROM items ORDER BY id").all();
		const oldAttempts = db.prepare("SELECT * FROM attempts").all();
		const studyState = () => {
			const state = { ...db!.prepare("SELECT * FROM runtime_state").get() };
			for (const field of ["coordinator", "coordinator_until", "generation_token", "generation_until", "last_activity"]) delete state[field];
			return state;
		};
		const before = studyState();
		const capturedStart = capturedLlmContexts.length;
		await s.commands["anki:teach"].handler(`--request-id ${manualId(1)} 旅行 日常交流`, s.ctx);
		const receipt = await settleManual(fake, db, 1);
		assert.equal(receipt.phase, "succeeded", JSON.stringify(receipt));
		assert.equal(receipt.itemsAdded, 5);
		assert.equal(receipt.topic, "旅行 日常交流");
		assert.deepEqual(receipt.itemIds, db.prepare("SELECT id FROM items WHERE id>2 ORDER BY id").all().map(row => row.id));
		assert.deepEqual(db.prepare("SELECT * FROM items WHERE id<=2 ORDER BY id").all(), oldItems);
		assert.deepEqual(db.prepare("SELECT * FROM attempts").all(), oldAttempts);
		assert.deepEqual(studyState(), before);
		assert.equal(db.prepare("SELECT COUNT(*) AS n FROM items WHERE id>2 AND shown=0 AND introduced_at IS NULL").get()?.n, 5);
		assert.equal(db.prepare("SELECT value FROM stats WHERE key='pending_replacements'").get()?.value, '["word"]');
		const contexts = capturedLlmContexts.slice(capturedStart);
		assert.equal(contexts.length, 2);
		for (const context of contexts) assert.match(context, /reservoir/, "generator and critic include unshown inventory");
		assert.match(contexts[0], /必须生成 ready:true/);
		assert.match(contexts[0], /立即生成指定数量的新卡/);
		assert.doesNotMatch(contexts[0], /信息不足时宁可等待/);
		await s.commands["anki:teach"].handler(`--request-id ${manualId(1)} duplicate delivery`, s.ctx);
		await fake.flush();
		assert.equal(db.prepare("SELECT COUNT(*) AS n FROM items").get()?.n, 7);
		assert.deepEqual(manualReceipt(db, 1), receipt);
		assert.equal(manualReceipt(db, 999), undefined, "global successful generation does not invent another request receipt");
	} finally {
		if (s) await s.handlers.session_shutdown({ reason: "quit" }, s.ctx);
		db?.close(); registration.unregister(); fake.restore();
	}
});

test("manual preparation queue wakes on poll despite active card and disabled automatic timer", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "manual-poll" });
	let a: Awaited<ReturnType<typeof makeSession>> | undefined;
	let b: Awaited<ReturnType<typeof makeSession>> | undefined;
	let db: DatabaseSync | undefined;
	try {
		registration.setResponses([fauxAssistantMessage(manualLessonResponse()), fauxAssistantMessage(JSON.stringify({ pass: true, issues: [], summary: "approved" }))]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 0, dailyNewLimit: 1, verbose: true });
		a = await makeSession({ model, modelRegistry: registry });
		b = await makeSession({ model, modelRegistry: registry });
		db = openTestDb();
		insertDueWord(db, "existing", "现有的（形容词）");
		db.prepare("UPDATE items SET shown=1,introduction_kind='planned',introduced_at=? WHERE id=1").run(new Date().toISOString());
		db.prepare("UPDATE runtime_state SET active_item_id=1,active_kind='review',active_version=9,generation_token='foreign',generation_until=?,coordinator='foreign',coordinator_until=?").run(new Date(Date.now()+300_000).toISOString(), new Date(Date.now()+300_000).toISOString());
		const start = capturedLlmContexts.length;
		const notesBefore = [a.notifications().slice(), b.notifications().slice()];
		await a.commands["anki:teach"].handler(`--request-id ${manualId(2)} 排队备课`, a.ctx);
		await b.commands["anki:teach"].handler(`--request-id ${manualId(2)} 同号重复`, b.ctx);
		assert.equal(manualReceipt(db, 2).phase, "queued");
		assert.equal(capturedLlmContexts.length, start);
		db.prepare("UPDATE stats SET value='ok: unrelated auto batch' WHERE key='last_gen_status'").run();
		await fake.firePoll();
		assert.equal(manualReceipt(db, 2).phase, "queued");
		db.prepare("UPDATE runtime_state SET generation_token=NULL,generation_until=NULL").run();
		await fake.firePoll();
		const receipt = await settleManual(fake, db, 2);
		assert.equal(receipt.phase, "succeeded", JSON.stringify(receipt));
		assert.equal(receipt.itemsAdded, 5);
		await fake.firePoll();
		assert.deepEqual([a.notifications(), b.notifications()], notesBefore, "queued receipt updates stay out of the generic learning notification channel");
		assert.equal(capturedLlmContexts.length - start, 2, "same id accepted by exactly one runtime");
		assert.equal(db.prepare("SELECT COUNT(*) AS n FROM items").get()?.n, 6);
		assert.equal(db.prepare("SELECT active_item_id FROM runtime_state").get()?.active_item_id, 1);
	} finally {
		if (a) await a.handlers.session_shutdown({ reason: "quit" }, a.ctx);
		if (b) await b.handlers.session_shutdown({ reason: "quit" }, b.ctx);
		db?.close(); registration.unregister(); fake.restore();
	}
});

test("manual preparation survives conversation changes and renews its healthy pipeline lease", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "manual-lease" });
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	let s: Awaited<ReturnType<typeof makeSession>> | undefined;
	let db: DatabaseSync | undefined;
	try {
		registration.setResponses([async () => { await gate; return fauxAssistantMessage(manualLessonResponse()); }, fauxAssistantMessage(JSON.stringify({ pass: true, issues: [], summary: "approved" }))]);
		const { model, registry } = fauxModelRegistry(registration);
		const branch = [{ type: "message", message: { role: "user", content: [{ type: "text", text: "original topic" }] } }];
		writeConfig({ intervalMinutes: 0, dailyNewLimit: 1 });
		s = await makeSession({ model, modelRegistry: registry, branch });
		db = openTestDb();
		await s.commands["anki:teach"].handler(`--request-id ${manualId(3)} explicit topic`, s.ctx);
		await fake.flush();
		assert.equal(manualReceipt(db, 3).phase, "generating");
		const token = db.prepare("SELECT generation_token FROM runtime_state").get()?.generation_token;
		db.prepare("UPDATE runtime_state SET generation_until=?").run(new Date(Date.now()+100).toISOString());
		await fake.firePoll();
		const state = db.prepare("SELECT generation_token,generation_until FROM runtime_state").get() as any;
		assert.equal(state.generation_token, token);
		assert.ok(Date.parse(state.generation_until) - Date.now() > 240_000, "lease is renewed before five-minute expiry");
		branch[0].message.content[0].text = "unrelated later conversation";
		release();
		const receipt = await settleManual(fake, db, 3);
		assert.equal(receipt.phase, "succeeded", JSON.stringify(receipt));
		assert.equal(receipt.itemsAdded, 5);
	} finally {
		release();
		if (s) await s.handlers.session_shutdown({ reason: "quit" }, s.ctx);
		db?.close(); registration.unregister(); fake.restore();
	}
});

test("manual preparation failure and shutdown publish terminal receipts without pacing or partial cards", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "manual-failure" });
	let release!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	let s: Awaited<ReturnType<typeof makeSession>> | undefined;
	let db: DatabaseSync | undefined;
	try {
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 0, dailyNewLimit: 1 });
		s = await makeSession({ model, modelRegistry: registry });
		db = openTestDb();
		const nextCheck = db.prepare("SELECT next_check_at FROM runtime_state").get()?.next_check_at;
		registration.setResponses([fauxAssistantMessage("bad json"), fauxAssistantMessage("bad json"), fauxAssistantMessage("bad json")]);
		await s.commands["anki:teach"].handler(`--request-id ${manualId(4)} fail`, s.ctx);
		const failed = await settleManual(fake, db, 4);
		assert.equal(failed.phase, "failed");
		assert.equal(failed.errorCode, "BAD_JSON");
		assert.equal(failed.itemsAdded, 0);
		assert.equal(db.prepare("SELECT next_check_at FROM runtime_state").get()?.next_check_at, nextCheck);
		registration.setResponses([async () => { await gate; return fauxAssistantMessage(manualLessonResponse()); }]);
		await s.commands["anki:teach"].handler(`--request-id ${manualId(5)} interrupted`, s.ctx);
		await fake.flush();
		const shuttingDown = s.handlers.session_shutdown({ reason: "quit" }, s.ctx);
		assert.equal(manualReceipt(db, 5).phase, "failed");
		assert.equal(manualReceipt(db, 5).errorCode, "REQUEST_INTERRUPTED");
		release(); await shuttingDown; await fake.flush();
		s = undefined;
		assert.equal(db.prepare("SELECT COUNT(*) AS n FROM items").get()?.n, 0);
	} finally {
		release();
		if (s) await s.handlers.session_shutdown({ reason: "quit" }, s.ctx);
		db?.close(); registration.unregister(); fake.restore();
	}
});

test("manual preparation retries ready:false and exposes checking before success", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "manual-force" });
	let s: Awaited<ReturnType<typeof makeSession>> | undefined;
	let db: DatabaseSync | undefined;
	try {
		registration.setResponses([
			fauxAssistantMessage(JSON.stringify({ ready: false, reason: "no conversation" })),
			fauxAssistantMessage(manualLessonResponse()),
			async () => {
				assert.equal(manualReceipt(db!, 6).phase, "checking");
				assert.equal(db!.prepare("SELECT COUNT(*) AS n FROM items").get()?.n, 0, "no items before approval");
				return fauxAssistantMessage(JSON.stringify({ pass: true, issues: [], summary: "approved" }));
			},
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 0, dailyNewLimit: 1 });
		s = await makeSession({ model, modelRegistry: registry });
		db = openTestDb();
		const start = capturedLlmContexts.length;
		await s.commands["anki:teach"].handler(`--request-id ${manualId(6)} 新批次`, s.ctx);
		const receipt = await settleManual(fake, db, 6);
		assert.equal(receipt.phase, "succeeded", JSON.stringify(receipt));
		assert.equal(receipt.itemsAdded, 5);
		assert.equal(capturedLlmContexts.length - start, 3);
	} finally {
		if (s) await s.handlers.session_shutdown({ reason: "quit" }, s.ctx);
		db?.close(); registration.unregister(); fake.restore();
	}
});

test("manual preparation rolls back inserted cards when the success receipt cannot commit", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "manual-atomic" });
	let s: Awaited<ReturnType<typeof makeSession>> | undefined;
	let db: DatabaseSync | undefined;
	try {
		registration.setResponses([fauxAssistantMessage(manualLessonResponse()), fauxAssistantMessage(JSON.stringify({ pass: true, issues: [], summary: "approved" }))]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 0, dailyNewLimit: 1 });
		s = await makeSession({ model, modelRegistry: registry });
		db = openTestDb();
		db.exec(`CREATE TRIGGER reject_success_receipt BEFORE UPDATE OF value ON stats
			WHEN NEW.key='teach_request:${manualId(7)}' AND json_extract(NEW.value,'$.phase')='succeeded'
			BEGIN SELECT RAISE(FAIL,'test receipt persistence failure'); END`);
		await s.commands["anki:teach"].handler(`--request-id ${manualId(7)} rollback`, s.ctx);
		const receipt = await settleManual(fake, db, 7);
		assert.equal(receipt.phase, "failed");
		assert.equal(receipt.itemsAdded, 0);
		assert.equal(receipt.errorCode, "ERR_SQLITE_ERROR");
		assert.equal(db.prepare("SELECT COUNT(*) AS n FROM items").get()?.n, 0);
		assert.equal(db.prepare("SELECT generation_token FROM runtime_state").get()?.generation_token, null);
	} finally {
		if (s) await s.handlers.session_shutdown({ reason: "quit" }, s.ctx);
		db?.close(); registration.unregister(); fake.restore();
	}
});

test("manual preparation keeps quality revisions fail closed with a matching receipt", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "manual-quality" });
	let s: Awaited<ReturnType<typeof makeSession>> | undefined;
	let db: DatabaseSync | undefined;
	try {
		registration.setResponses([
			fauxAssistantMessage(manualBadQualityResponse()),
			async () => {
				assert.equal(manualReceipt(db!, 8).phase, "revising");
				return fauxAssistantMessage(manualBadQualityResponse());
			},
			fauxAssistantMessage(manualBadQualityResponse()),
			fauxAssistantMessage(manualBadQualityResponse()),
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 0, dailyNewLimit: 1, verbose: true });
		s = await makeSession({ model, modelRegistry: registry });
		db = openTestDb();
		const notesBefore = s.notifications().slice();
		await s.commands["anki:teach"].handler(`--request-id ${manualId(8)} quality`, s.ctx);
		const receipt = await settleManual(fake, db, 8);
		assert.equal(receipt.phase, "failed");
		assert.deepEqual(s.notifications(), notesBefore, "quality rejection is published only to this request receipt");
		assert.equal(receipt.errorCode, "TEACH_QUALITY_REJECTED");
		assert.equal(receipt.itemsAdded, 0);
		assert.equal(db.prepare("SELECT COUNT(*) AS n FROM items").get()?.n, 0);
	} finally {
		if (s) await s.handlers.session_shutdown({ reason: "quit" }, s.ctx);
		db?.close(); registration.unregister(); fake.restore();
	}
});

test("manual receipt progress never emits generic notifications while an answer is being judged", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "manual-answer-notify" });
	let releaseAnswer!: () => void;
	const gate = new Promise<void>(resolve => { releaseAnswer = resolve; });
	let s: Awaited<ReturnType<typeof makeSession>> | undefined;
	let db: DatabaseSync | undefined;
	let answer: Promise<void> | undefined;
	try {
		registration.setResponses([
			async () => { await gate; return fauxAssistantMessage(JSON.stringify({ verdict: "correct", feedback: "表达正确" })); },
			fauxAssistantMessage(manualLessonResponse()),
			fauxAssistantMessage(JSON.stringify({ pass: true, issues: [], summary: "approved" })),
		]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 0, dailyNewLimit: 1, verbose: true });
		s = await makeSession({ model, modelRegistry: registry });
		db = openTestDb();
		insertDueWord(db, "existing", "现有的（形容词）");
		db.prepare("UPDATE items SET shown=1 WHERE id=1").run();
		db.prepare("UPDATE runtime_state SET active_item_id=1,active_kind='review',active_version=1").run();
		answer = s.commands["anki:answer"].handler("preexisting", s.ctx);
		await fake.flush();
		const notesBefore = s.notifications().slice();
		await s.commands["anki:teach"].handler(`--request-id ${manualId(9)} parallel lesson`, s.ctx);
		const receipt = await settleManual(fake, db, 9);
		assert.equal(receipt.phase, "succeeded", JSON.stringify(receipt));
		assert.deepEqual(s.notifications(), notesBefore, "receipt-specific generation must not look like an answer rejection");
		assert.equal(db.prepare("SELECT COUNT(*) AS n FROM attempts").get()?.n, 0, "answer remains pending until its own evaluation returns");
		releaseAnswer(); await answer; answer = undefined;
		assert.equal(db.prepare("SELECT verdict FROM attempts WHERE item_id=1").get()?.verdict, "correct");
	} finally {
		releaseAnswer(); if (answer) await answer;
		if (s) await s.handlers.session_shutdown({ reason: "quit" }, s.ctx);
		db?.close(); registration.unregister(); fake.restore();
	}
});

test("Again advances stored new cards with automatic checks off while replacement generation is still pending", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "again-next-during-refill" });
	let release!: () => void;
	let started!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	const running = new Promise<void>(resolve => { started = resolve; });
	let s: Awaited<ReturnType<typeof makeSession>> | undefined;
	let db: DatabaseSync | undefined;
	try {
		registration.setResponses([async () => {
			started(); await gate;
			return fauxAssistantMessage(JSON.stringify({ ready: false, reason: "test refill still waiting" }));
		}]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 0, dailyNewLimit: 2 });
		s = await makeSession({ model, modelRegistry: registry });
		db = openTestDb();
		insertDueWord(db, "alpha", "阿尔法（名词，义项线索）");
		insertDueWord(db, "beta", "贝塔（名词，义项线索）");
		db.prepare("INSERT INTO items(type,text,meaning,status,learned_at,due_at,shown) VALUES('word','known','已会（形容词）','mastered',?,'2099-01-01T00:00:00.000Z',1)").run(new Date().toISOString());
		db.prepare("UPDATE items SET shown=1,introduction_kind='planned',introduced_at=? WHERE id=1").run(new Date().toISOString());
		db.prepare("UPDATE runtime_state SET active_item_id=1,active_kind='review',active_version=1").run();
		db.prepare("INSERT INTO stats(key,value) VALUES('pending_replacements','[\"word\"]')").run();
		await fake.firePoll();
		const contextsBefore = capturedLlmContexts.length;
		await fake.fire(fake.replacements()[0]);
		await running;
		await s.commands["anki:again"].handler("", s.ctx);
		assert.equal(db.prepare("SELECT active_item_id FROM runtime_state").get()?.active_item_id, 2, "stored new card is claimed before the unresolved refill returns");
		assert.equal(db.prepare("SELECT shown FROM items WHERE id=2").get()?.shown, 1);
		assert.equal(db.prepare("SELECT reviews FROM items WHERE id=1").get()?.reviews, 1);
		assert.equal(db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE item_id=1 AND explicit_rating='again'").get()?.n, 1);
		assert.equal(db.prepare("SELECT value FROM stats WHERE key='pending_replacements'").get()?.value, '["word"]');
		assert.equal(capturedLlmContexts.length - contextsBefore, 1, "advancing inventory performs no model call");
		assert.match(s.widget().join(" "), /贝塔/);
		assert.ok(fake.active().every(timer => timer.delay >= 60_000), "only the pending model deadline remains; no next-card grace timer");
	} finally {
		release(); await fake.flush();
		if (s) await s.handlers.session_shutdown({ reason: "quit" }, s.ctx);
		db?.close(); registration.unregister(); fake.restore();
	}
});

test("automatic Again immediately advances due inventory while preserving the original answer for each direction", { concurrency: false }, async () => {
	for (const [type, direction, text, meaning, expected] of [
		["word", "forward", "alpha", "阿尔法（名词，义项线索）", "alpha"],
		["phrase", "reverse", "in advance", "提前（副词短语）", "提前（副词短语）"],
		["cloze", "forward", "She ___ (be) at home yesterday.", "was", "was"],
	] as const) {
		const fake = installFakeTimers();
		const registration = registerFauxProvider({ provider: `again-original-answer-${type}` });
		let s: Awaited<ReturnType<typeof makeSession>> | undefined;
		let db: DatabaseSync | undefined;
		try {
			registration.setResponses([fauxAssistantMessage(JSON.stringify({ verdict: "incorrect", feedback: "请核对原题答案" }))]);
			const { model, registry } = fauxModelRegistry(registration);
			writeConfig({ intervalMinutes: 0, dailyNewLimit: 1 });
			s = await makeSession({ model, modelRegistry: registry });
			db = openTestDb();
			db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown,introduced_at) VALUES(?,?,?,?,?,1,?)").run(type, text, meaning, new Date().toISOString(), new Date(0).toISOString(), new Date().toISOString());
			db.prepare("UPDATE items SET introduction_kind='planned' WHERE id=1").run();
			insertDueWord(db, "beta", "贝塔（名词，义项线索）");
			db.prepare("UPDATE items SET shown=1 WHERE id=2").run();
			db.prepare("UPDATE runtime_state SET active_item_id=1,active_kind='review',active_direction=?,active_version=1").run(direction);
			await s.commands["anki:answer"].handler("wrong answer", s.ctx);
			assert.equal(db.prepare("SELECT active_item_id FROM runtime_state").get()?.active_item_id, 2, `${type}: due review remains eligible despite full new quota`);
			const attempt = db.prepare("SELECT item_id,verdict,explicit_rating,feedback_json FROM attempts").get() as any;
			assert.equal(attempt.item_id, 1);
			assert.equal(attempt.verdict, "incorrect");
			assert.equal(attempt.explicit_rating, "again");
			assert.equal(JSON.parse(attempt.feedback_json).correctedAnswer, expected, "correction stays bound to the old card after B is activated");
			assert.equal(db.prepare("SELECT reviews FROM items WHERE id=1").get()?.reviews, 1);
			assert.equal(db.prepare("SELECT reviews FROM items WHERE id=2").get()?.reviews, 0);
			assert.equal(fake.active().length, 0);
		} finally {
			if (s) await s.handlers.session_shutdown({ reason: "quit" }, s.ctx);
			db?.close(); registration.unregister(); fake.restore();
		}
	}
});

test("Again does not mistake replacement backlog or quota-blocked or future cards for ready inventory", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	let s: Awaited<ReturnType<typeof makeSession>> | undefined;
	let db: DatabaseSync | undefined;
	try {
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 1 });
		s = await makeSession();
		db = openTestDb();
		insertDueWord(db, "alpha", "阿尔法（名词，义项线索）");
		insertDueWord(db, "beta", "贝塔（名词，义项线索）");
		insertDueWord(db, "gamma", "伽马（名词，义项线索）");
		db.prepare("UPDATE items SET shown=1,introduction_kind='planned',introduced_at=? WHERE id=1").run(new Date().toISOString());
		db.prepare("UPDATE items SET shown=1,due_at='2099-01-01T00:00:00.000Z' WHERE id=3").run();
		db.prepare("UPDATE runtime_state SET active_item_id=1,active_kind='review',active_version=1").run();
		db.prepare("INSERT INTO stats(key,value) VALUES('pending_replacements','[\"word\"]')").run();
		await s.commands["anki:again"].handler("", s.ctx);
		const state = db.prepare("SELECT active_item_id,next_check_at FROM runtime_state").get() as any;
		assert.equal(state.active_item_id, null);
		assert.ok(Date.parse(state.next_check_at) - Date.now() > 590_000, "no stored eligible card preserves the normal automatic interval");
		assert.equal(db.prepare("SELECT shown FROM items WHERE id=2").get()?.shown, 0, "new-card daily quota is respected");
		assert.equal(db.prepare("SELECT due_at FROM items WHERE id=3").get()?.due_at, "2099-01-01T00:00:00.000Z", "future review is untouched");
		assert.match(s.widget().join(" "), /没关系，待会儿再考你一次/);
		assert.ok(fake.active()[0].delay > 590_000);
	} finally {
		if (s) await s.handlers.session_shutdown({ reason: "quit" }, s.ctx);
		db?.close(); fake.restore();
	}
});

test("a stale second manual Again cannot rate the newly claimed card", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	let a: Awaited<ReturnType<typeof makeSession>> | undefined;
	let b: Awaited<ReturnType<typeof makeSession>> | undefined;
	let db: DatabaseSync | undefined;
	try {
		writeConfig({ intervalMinutes: 0, dailyNewLimit: 1 });
		a = await makeSession(); b = await makeSession();
		db = openTestDb();
		insertDueWord(db, "alpha", "阿尔法（名词，义项线索）");
		insertDueWord(db, "beta", "贝塔（名词，义项线索）");
		db.prepare("UPDATE items SET shown=1").run();
		db.prepare("UPDATE runtime_state SET active_item_id=1,active_kind='review',active_version=1").run();
		await fake.firePoll();
		await a.commands["anki:again"].handler("", a.ctx);
		await b.commands["anki:again"].handler("", b.ctx);
		assert.equal(db.prepare("SELECT active_item_id FROM runtime_state").get()?.active_item_id, 2);
		assert.equal(db.prepare("SELECT COUNT(*) AS n FROM attempts").get()?.n, 1);
		assert.deepEqual(db.prepare("SELECT reviews FROM items ORDER BY id").all().map(row => row.reviews), [1, 0]);
	} finally {
		if (a) await a.handlers.session_shutdown({ reason: "quit" }, a.ctx);
		if (b) await b.handlers.session_shutdown({ reason: "quit" }, b.ctx);
		db?.close(); fake.restore();
	}
});

function readForecast(db: DatabaseSync) {
	const raw = db.prepare("SELECT value FROM stats WHERE key='next_card_forecast'").get()?.value;
	assert.equal(typeof raw, "string", "every attached session has a next-card projection");
	return JSON.parse(String(raw));
}

test("forecast follows active card advancement with automatic scheduling disabled", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	let s: Awaited<ReturnType<typeof makeSession>> | undefined;
	let db: DatabaseSync | undefined;
	try {
		writeConfig({ intervalMinutes: 0, dailyNewLimit: 1 });
		s = await makeSession(); db = openTestDb();
		assert.equal(readForecast(db).status, "disabled");
		insertDueWord(db, "alpha", "阿尔法（名词，义项线索）");
		db.prepare("UPDATE items SET shown=1").run();
		db.prepare("UPDATE runtime_state SET active_item_id=1,active_kind='review',active_version=1").run();
		await fake.firePoll();
		assert.equal(readForecast(db).activeItemId, 1);
		assert.equal(readForecast(db).status, "current_card");
		assert.equal(readForecast(db).hasReadyAfterCurrent, false);
		insertDueWord(db, "beta", "贝塔（名词，义项线索）");
		await fake.firePoll();
		assert.equal(readForecast(db).hasReadyAfterCurrent, true);
		await s.commands["anki:again"].handler("", s.ctx);
		assert.equal(readForecast(db).activeItemId, 2, "a preview for the old card must not remain attached to the next one");
		assert.equal(readForecast(db).hasReadyAfterCurrent, false);
		await s.commands["anki:again"].handler("", s.ctx);
		assert.equal(readForecast(db).activeItemId, null);
		assert.equal(readForecast(db).status, "disabled");
		assert.equal(readForecast(db).scheduledAt, null);
		assert.equal(db.prepare("SELECT COUNT(*) AS n FROM attempts").get()?.n, 2);
	} finally {
		if (s) await s.handlers.session_shutdown({ reason: "quit" }, s.ctx);
		db?.close(); fake.restore();
	}
});

test("forecast belongs to the live coordinator and is cleared when its timer is disabled", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	let older: Awaited<ReturnType<typeof makeSession>> | undefined;
	let owner: Awaited<ReturnType<typeof makeSession>> | undefined;
	let db: DatabaseSync | undefined;
	try {
		writeConfig({ intervalMinutes: 0, dailyNewLimit: 1 });
		older = await makeSession();
		writeFileSync(`${agentDir}/kaomoji-english-tutor.json`, JSON.stringify({ intervalMinutes: 0.1, dailyNewLimit: 1, adaptiveNewCards: false }));
		owner = await makeSession(); db = openTestDb();
		insertDueWord(db, "future", "未来（名词，义项线索）");
		const now = Date.now();
		db.prepare("UPDATE items SET shown=1,due_at=?").run(new Date(now + 3000).toISOString());
		db.prepare("UPDATE runtime_state SET next_check_at=?").run(new Date(now + 6000).toISOString());
		await owner.commands["anki:interval"].handler("0.1", owner.ctx);
		const original = readForecast(db);
		assert.ok(original.scheduledAt);
		await fake.firePoll();
		assert.deepEqual(readForecast(db), original, "the disabled follower cannot replace the owner's actual timer promise");
		await older.handlers.session_shutdown({ reason: "quit" }, older.ctx); older = undefined;
		assert.deepEqual(readForecast(db), original, "shutdown of an old owner must not clear the new owner's forecast");
		await owner.commands["anki:interval"].handler("off", owner.ctx);
		assert.equal(readForecast(db).status, "disabled");
		assert.equal(readForecast(db).scheduledAt, null);
		assert.equal(readForecast(db).checkAt, null, "cancellation publishes immediately, without waiting for polling");
		await owner.commands["anki:interval"].handler("0.1", owner.ctx);
		assert.ok(readForecast(db).scheduledAt);
		await owner.handlers.session_shutdown({ reason: "quit" }, owner.ctx); owner = undefined;
		assert.equal(readForecast(db).scheduledAt, null);
		assert.equal(readForecast(db).checkAt, null, "owner shutdown cannot leave an automatic promise behind");
	} finally {
		if (older) await older.handlers.session_shutdown({ reason: "quit" }, older.ctx);
		if (owner) await owner.handlers.session_shutdown({ reason: "quit" }, owner.ctx);
		db?.close(); fake.restore();
	}
});

test("expired coordinator lets different-config followers clear stale promises only once", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const sessions: Awaited<ReturnType<typeof makeSession>>[] = [];
	let db: DatabaseSync | undefined;
	try {
		writeConfig({ intervalMinutes: 0, dailyNewLimit: 1 });
		sessions.push(await makeSession());
		let offPoll = fake.poll()[0];
		writeFileSync(`${agentDir}/kaomoji-english-tutor.json`, JSON.stringify({ intervalMinutes: 5, dailyNewLimit: 20, adaptiveNewCards: false }));
		sessions.push(await makeSession());
		let onPoll = fake.poll().find(timer => timer !== offPoll)!;
		writeFileSync(`${agentDir}/kaomoji-english-tutor.json`, JSON.stringify({ intervalMinutes: 0.1, dailyNewLimit: 1, adaptiveNewCards: false }));
		const owner = await makeSession(); sessions.push(owner); db = openTestDb();
		insertDueWord(db, "future", "未来（名词，义项线索）");
		const now = Date.now();
		db.prepare("UPDATE items SET shown=1,due_at=?").run(new Date(now + 3000).toISOString());
		db.prepare("UPDATE runtime_state SET next_check_at=?").run(new Date(now + 6000).toISOString());
		await owner.commands["anki:interval"].handler("0.1", owner.ctx);
		assert.ok(readForecast(db).scheduledAt);
		const ownerId = db.prepare("SELECT coordinator FROM runtime_state").get()?.coordinator;
		db.exec("CREATE TABLE forecast_writes(n INTEGER); INSERT INTO forecast_writes VALUES(0); CREATE TRIGGER count_forecast_writes AFTER UPDATE OF value ON stats WHEN NEW.key='next_card_forecast' BEGIN UPDATE forecast_writes SET n=n+1; END;");
		db.prepare("UPDATE runtime_state SET coordinator_until=?").run(new Date(0).toISOString());
		async function pollAndRenew(timer: FakeTimer) {
			const before = new Set(fake.poll());
			await fake.fire(timer);
			return fake.poll().find(next => !before.has(next))!;
		}
		offPoll = await pollAndRenew(offPoll);
		const neutral = readForecast(db);
		assert.equal(neutral.status, "waiting_check");
		assert.equal(neutral.availableAt, null);
		assert.equal(neutral.scheduledAt, null);
		assert.equal(neutral.checkAt, null);
		for (let i = 0; i < 3; i++) {
			onPoll = await pollAndRenew(onPoll);
			offPoll = await pollAndRenew(offPoll);
			assert.deepEqual(readForecast(db), neutral, "followers must not apply their own conflicting interval/quota settings");
		}
		assert.equal(db.prepare("SELECT n FROM forecast_writes").get()?.n, 1, "neutral clearing is one semantic update, never per-poll churn");
		assert.equal(db.prepare("SELECT coordinator FROM runtime_state").get()?.coordinator, ownerId, "publishing must not acquire the expired lease");
		db.prepare("UPDATE runtime_state SET active_item_id=1,active_kind='review',active_version=1").run();
		onPoll = await pollAndRenew(onPoll);
		assert.equal(readForecast(db).status, "current_card");
		assert.equal(readForecast(db).activeItemId, 1);
		assert.equal(readForecast(db).hasReadyAfterCurrent, false);
	} finally {
		for (const session of sessions) await session.handlers.session_shutdown({ reason: "quit" }, session.ctx);
		db?.close(); fake.restore();
	}
});

function undoReceipt(db: DatabaseSync) {
	return JSON.parse(String(db.prepare("SELECT value FROM stats WHERE key='study_undo'").get()?.value));
}
function learningRows(db: DatabaseSync) {
	return {
		items: db.prepare("SELECT * FROM items ORDER BY id").all(),
		directions: db.prepare("SELECT * FROM direction_state ORDER BY item_id,direction").all(),
		attempts: db.prepare("SELECT * FROM attempts ORDER BY id").all(),
		mastery: db.prepare("SELECT * FROM mastery_state ORDER BY item_id").all(),
		exercises: db.prepare("SELECT * FROM exercises ORDER BY id").all(),
		stats: db.prepare("SELECT key,value FROM stats WHERE key IN ('total_reviews','total_skipped','total_learned','streak_days','last_active_date','pending_replacements') ORDER BY key").all(),
		state: db.prepare("SELECT active_item_id,active_kind,active_direction,active_review_cycle_id,active_exercise_id,active_cycle_outcome,active_retry_count,active_assistance_level,next_check_at FROM runtime_state").get(),
	};
}
async function invokeUndo(s: Awaited<ReturnType<typeof makeSession>>, db: DatabaseSync, actionId: string, requestId = randomUUID()) {
	await s.commands["anki:undo"].handler(`${actionId} --request-id ${requestId}`, s.ctx);
	return JSON.parse(String(db.prepare("SELECT value FROM stats WHERE key=?").get(`study_undo_result:${requestId}`)?.value));
}

test("undo restores manual ratings and untouched next-card introduction after restart", { concurrency: false }, async () => {
	for (const kind of ["good", "again"]) {
		const fake = installFakeTimers();
		let s: Awaited<ReturnType<typeof makeSession>> | undefined;
		let db: DatabaseSync | undefined;
		try {
			writeConfig({ intervalMinutes: 0, dailyNewLimit: 1 });
			s = await makeSession(); db = openTestDb();
			insertDueWord(db, "alpha", "阿尔法（名词，义项线索）"); insertDueWord(db, "beta", "贝塔（名词，义项线索）");
			db.prepare("UPDATE items SET shown=1 WHERE id=1").run();
			db.prepare("UPDATE runtime_state SET active_item_id=1,active_kind='review',active_direction='reverse',active_version=3,active_assistance_level='revealed'").run();
			db.prepare("INSERT INTO stats(key,value) VALUES('total_reviews','9'),('total_learned','4'),('streak_days','3'),('last_active_date','2020-01-01')").run();
			await fake.firePoll();
			const before = learningRows(db);
			await s.commands[`anki:${kind}`].handler("", s.ctx);
			assert.equal(db.prepare("SELECT active_item_id FROM runtime_state").get()?.active_item_id, 2);
			assert.equal(db.prepare("SELECT introduced_at FROM items WHERE id=2").get()?.introduced_at != null, true);
			const receipt = undoReceipt(db);
			assert.equal(receipt.available, true); assert.equal(receipt.kind, kind); assert.equal(receipt.itemId, 1);
			await s.handlers.session_shutdown({ reason: "quit" }, s.ctx);
			s = await makeSession();
			const version = Number(db.prepare("SELECT active_version FROM runtime_state").get()?.active_version);
			assert.equal((await invokeUndo(s, db, receipt.actionId)).status, "succeeded");
			assert.deepEqual(learningRows(db), before, "restore exact source learning data, next introduction and counters");
			assert.ok(Number(db.prepare("SELECT active_version FROM runtime_state").get()?.active_version) > version, "old in-flight commands cannot target the restored card version");
			const after = learningRows(db);
			assert.equal((await invokeUndo(s, db, receipt.actionId)).status, "rejected", "a new request cannot undo the same action twice");
			assert.deepEqual(learningRows(db), after);
		} finally { if (s) await s.handlers.session_shutdown({ reason: "quit" }, s.ctx); db?.close(); fake.restore(); }
	}
});

test("undo rejects subsequent text answers, hints, edits, generation and stale actions", { concurrency: false }, async () => {
	for (const change of ["answer", "hint", "edit", "generation", "rating"]) {
		const fake = installFakeTimers();
		let s: Awaited<ReturnType<typeof makeSession>> | undefined;
		let db: DatabaseSync | undefined;
		try {
			writeConfig({ intervalMinutes: 0, dailyNewLimit: 0 });
			s = await makeSession(); db = openTestDb();
			insertDueWord(db, "alpha", "阿尔法（名词，义项线索）"); insertDueWord(db, "beta", "贝塔（名词，义项线索）");
			db.prepare("UPDATE items SET shown=1").run();
			db.prepare("UPDATE runtime_state SET active_item_id=1,active_kind='review',active_version=1").run();
			await fake.firePoll(); await s.commands["anki:again"].handler("", s.ctx);
			const old = undoReceipt(db);
			if (change === "answer") await s.commands["anki:answer"].handler("beta", s.ctx);
			if (change === "hint") await s.commands["anki:hint"].handler("", s.ctx);
			if (change === "edit") db.prepare("UPDATE items SET meaning='另一会话修订（名词，义项线索）',content_version=content_version+1 WHERE id=1").run();
			if (change === "generation") insertDueWord(db, "newlycreated", "新生成（形容词）");
			if (change === "rating") await s.commands["anki:again"].handler("", s.ctx);
			const preserved = learningRows(db);
			const result = await invokeUndo(s, db, old.actionId);
			assert.equal(result.status, "rejected", change); assert.equal(result.itemId, 1, "stale result still refers to its requested action");
			assert.deepEqual(learningRows(db), preserved, "never overwrite later business changes");
		} finally { if (s) await s.handlers.session_shutdown({ reason: "quit" }, s.ctx); db?.close(); fake.restore(); }
	}
});

test("undo skip cancels only its in-flight refill and ignores the late model result", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "undo-skip-pending" });
	let release!: () => void, started!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	const running = new Promise<void>(resolve => { started = resolve; });
	let s: Awaited<ReturnType<typeof makeSession>> | undefined;
	let db: DatabaseSync | undefined;
	let skip: Promise<void> | undefined;
	try {
		registration.setResponses([async () => { started(); await gate; return fauxAssistantMessage(JSON.stringify({ ready: true, item: queueWord("morning", "早晨") })); }]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 0, dailyNewLimit: 1 });
		s = await makeSession({ model, modelRegistry: registry }); db = openTestDb();
		insertDueWord(db, "alpha", "阿尔法（名词，义项线索）");
		db.prepare("UPDATE items SET shown=1").run();
		db.prepare("UPDATE runtime_state SET active_item_id=1,active_kind='review',active_version=1").run();
		await fake.firePoll();
		const before = learningRows(db);
		skip = s.commands["anki:skip"].handler("", s.ctx);
		await running;
		const receipt = undoReceipt(db);
		assert.equal(receipt.kind, "skip"); assert.equal(receipt.available, true);
		assert.ok(db.prepare("SELECT generation_token FROM runtime_state").get()?.generation_token);
		assert.equal((await invokeUndo(s, db, receipt.actionId)).status, "succeeded");
		assert.deepEqual(learningRows(db), before);
		assert.equal(db.prepare("SELECT generation_token FROM runtime_state").get()?.generation_token, null);
		release(); await skip; await fake.flush();
		assert.deepEqual(learningRows(db), before, "late refill must not insert a new card or change restored pacing");
	} finally { release(); if (skip) await skip; if (s) await s.handlers.session_shutdown({ reason: "quit" }, s.ctx); db?.close(); registration.unregister(); fake.restore(); }
});

test("undo skip restores both directions with next review displayed and preserves committed refill", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	let s: Awaited<ReturnType<typeof makeSession>> | undefined;
	let db: DatabaseSync | undefined;
	try {
		writeConfig({ intervalMinutes: 0, dailyNewLimit: 0 });
		s = await makeSession(); db = openTestDb();
		insertDueWord(db, "alpha", "阿尔法（名词，义项线索）"); insertDueWord(db, "beta", "贝塔（名词，义项线索）");
		db.prepare("UPDATE items SET shown=1").run();
		db.prepare("UPDATE runtime_state SET active_item_id=1,active_kind='review',active_version=1").run();
		await fake.firePoll(); const before = learningRows(db);
		await s.commands["anki:skip"].handler("", s.ctx);
		const first = undoReceipt(db);
		assert.equal(db.prepare("SELECT active_item_id FROM runtime_state").get()?.active_item_id, 2);
		const requestId = randomUUID();
		assert.equal((await invokeUndo(s, db, first.actionId, requestId)).status, "succeeded");
		assert.deepEqual(learningRows(db), before);
		assert.equal((await invokeUndo(s, db, first.actionId, requestId)).status, "succeeded", "identical request is idempotent");
		assert.deepEqual(learningRows(db), before);
		await s.commands["anki:skip"].handler("", s.ctx);
		const second = undoReceipt(db);
		const conflict = undoStudyAction(db, second.actionId, requestId);
		assert.equal(conflict.status, "rejected"); assert.equal(conflict.errorCode, "UNDO_REQUEST_CONFLICT");
		insertDueWord(db, "committedrefill", "已入库（名词，义项线索）");
		db.prepare("UPDATE stats SET value='[]' WHERE key='pending_replacements'").run();
		const committed = learningRows(db);
		assert.equal((await invokeUndo(s, db, second.actionId)).status, "rejected");
		assert.deepEqual(learningRows(db), committed, "never delete or overwrite already committed refill work");
	} finally { if (s) await s.handlers.session_shutdown({ reason: "quit" }, s.ctx); db?.close(); fake.restore(); }
});

test("undo restores sentence-cycle rating and newly displayed sentence setup", { concurrency: false }, async () => {
	for (const sourceSentence of [false, true]) {
		const fake = installFakeTimers();
		let s: Awaited<ReturnType<typeof makeSession>> | undefined;
		let db: DatabaseSync | undefined;
		try {
			writeConfig({ intervalMinutes: 0, dailyNewLimit: 1 });
			s = await makeSession(); db = openTestDb();
			if (sourceSentence) insertSentence(db); else insertDueWord(db, "alpha", "阿尔法（名词，义项线索）");
			insertSentence(db);
			db.prepare("UPDATE items SET shown=1 WHERE id=1").run();
			db.prepare("UPDATE runtime_state SET active_item_id=1,active_kind='review',active_version=1").run();
			await fake.firePoll();
			if (sourceSentence) {
				const cycle = db.prepare("SELECT active_review_cycle_id,active_exercise_id FROM runtime_state").get()!;
				db.prepare("INSERT INTO attempts(id,item_id,exercise_id,review_cycle_id,claim_key,question_version,evaluation_version,kind,assistance_level,status,verdict,started_at,completed_at) VALUES('existing',1,?,?,'existing',1,1,'sentence_production','none','evaluated','incorrect',?,?)")
					.run(cycle.active_exercise_id, cycle.active_review_cycle_id, new Date().toISOString(), new Date().toISOString());
			}
			const before = learningRows(db);
			await s.commands["anki:again"].handler("", s.ctx);
			assert.equal(db.prepare("SELECT active_item_id FROM runtime_state").get()?.active_item_id, 2);
			assert.equal((await invokeUndo(s, db, undoReceipt(db).actionId)).status, "succeeded");
			assert.deepEqual(learningRows(db), before, "restore linked old attempt fields and remove only the next card's new cycle setup");
		} finally { if (s) await s.handlers.session_shutdown({ reason: "quit" }, s.ctx); db?.close(); fake.restore(); }
	}
});

test("undo with no next card restores cloze scheduling and rolls back atomically on failure", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	let s: Awaited<ReturnType<typeof makeSession>> | undefined;
	let db: DatabaseSync | undefined;
	try {
		writeConfig({ intervalMinutes: 0, dailyNewLimit: 1 });
		s = await makeSession(); db = openTestDb();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown,chunks) VALUES('cloze','She ___ (be) here.','is',?,'1970-01-01T00:00:00.000Z',1,'[\"She\",\"is here.\"]')").run(new Date().toISOString());
		db.prepare("UPDATE runtime_state SET active_item_id=1,active_kind='review',active_version=1").run();
		await fake.firePoll(); const before = learningRows(db);
		await s.commands["anki:again"].handler("", s.ctx);
		assert.equal(db.prepare("SELECT active_item_id FROM runtime_state").get()?.active_item_id, null);
		const receipt = undoReceipt(db), rated = learningRows(db);
		db.exec("CREATE TRIGGER prevent_undo_test BEFORE DELETE ON attempts BEGIN SELECT RAISE(ABORT,'test-only failure'); END;");
		assert.equal((await invokeUndo(s, db, receipt.actionId)).errorCode, "UNDO_FAILED");
		assert.deepEqual(learningRows(db), rated, "a failure mid-undo cannot partially restore counters or the active card");
		db.exec("DROP TRIGGER prevent_undo_test");
		assert.equal((await invokeUndo(s, db, receipt.actionId)).status, "succeeded");
		assert.deepEqual(learningRows(db), before);
	} finally { if (s) await s.handlers.session_shutdown({ reason: "quit" }, s.ctx); db?.close(); fake.restore(); }
});

test("undo cached success cannot cancel a newer study timer", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	let s: Awaited<ReturnType<typeof makeSession>> | undefined;
	let db: DatabaseSync | undefined;
	try {
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 0 });
		s = await makeSession(); db = openTestDb();
		insertDueWord(db, "alpha", "阿尔法（名词，义项线索）");
		db.prepare("UPDATE items SET shown=1").run();
		db.prepare("UPDATE runtime_state SET active_item_id=1,active_kind='review',active_version=1").run();
		await fake.firePoll();
		await s.commands["anki:again"].handler("", s.ctx);
		const first = undoReceipt(db), requestId = randomUUID();
		assert.equal((await invokeUndo(s, db, first.actionId, requestId)).status, "succeeded");
		await s.commands["anki:again"].handler("", s.ctx);
		const second = undoReceipt(db), waiting = learningRows(db), timer = fake.active()[0];
		assert.ok(timer?.active);
		assert.equal((await invokeUndo(s, db, first.actionId, requestId)).status, "succeeded", "the old durable result may still be read");
		assert.deepEqual(learningRows(db), waiting);
		assert.deepEqual(undoReceipt(db), second);
		assert.ok(timer.active && fake.active().includes(timer), "cached results cannot perform local cancellation or rescheduling");
	} finally { if (s) await s.handlers.session_shutdown({ reason: "quit" }, s.ctx); db?.close(); fake.restore(); }
});

test("undo newer rating keeps its pacing and receipt when an older skip fails late", { concurrency: false }, async () => {
	const fake = installFakeTimers();
	const registration = registerFauxProvider({ provider: "undo-old-skip-late" });
	let release!: () => void, started!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	const running = new Promise<void>(resolve => { started = resolve; });
	let s: Awaited<ReturnType<typeof makeSession>> | undefined;
	let db: DatabaseSync | undefined;
	let skip: Promise<void> | undefined;
	try {
		registration.setResponses([async () => { started(); await gate; return fauxAssistantMessage(JSON.stringify({ ready: false, reason: "test-only no replacement" })); }]);
		const { model, registry } = fauxModelRegistry(registration);
		writeConfig({ intervalMinutes: 10, dailyNewLimit: 1 });
		s = await makeSession({ model, modelRegistry: registry }); db = openTestDb();
		insertDueWord(db, "alpha", "阿尔法（名词，义项线索）"); insertDueWord(db, "beta", "贝塔（名词，义项线索）");
		db.prepare("UPDATE items SET shown=1 WHERE id=1").run();
		db.prepare("UPDATE runtime_state SET active_item_id=1,active_kind='review',active_version=1").run();
		await fake.firePoll();
		skip = s.commands["anki:skip"].handler("", s.ctx); await running;
		// A timer may claim stored inventory while the old refill remains in flight.
		await s.commands["anki:interval"].handler("10", s.ctx);
		await fake.fire(fake.active().find(timer => timer.delay > 590_000));
		assert.equal(db.prepare("SELECT active_item_id FROM runtime_state").get()?.active_item_id, 2);
		await s.commands["anki:again"].handler("", s.ctx);
		const newer = undoReceipt(db), waiting = learningRows(db);
		assert.equal(newer.itemId, 2); assert.equal(newer.available, true);
		release(); await skip; await fake.flush();
		assert.deepEqual(learningRows(db), waiting, "old skip cleanup cannot alter the newer rating's pacing");
		assert.deepEqual(undoReceipt(db), newer);
		assert.equal((await invokeUndo(s, db, newer.actionId)).status, "succeeded");
		assert.equal(db.prepare("SELECT active_item_id FROM runtime_state").get()?.active_item_id, 2);
	} finally { release(); if (skip) await skip; if (s) await s.handlers.session_shutdown({ reason: "quit" }, s.ctx); db?.close(); registration.unregister(); fake.restore(); }
});
