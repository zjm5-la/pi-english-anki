// /anki:add custom-card queue: migration, FIFO staging, quota accounting,
// partial lesson batches, custom generation, and critic composition.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PiSdkLlmClient } from "../pi-sdk-llm.ts";
import type { PetConfig } from "../config.ts";
import type { AdaptiveContext } from "../learner-profile.ts";
import type { GeneratedItem } from "../llm.ts";
import { coldStartProfile, deriveBudget } from "../learner-profile.ts";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "kaomoji-custom-queue-"));

const { MAX_CUSTOM_PER_ADD } = await import("../config.ts");
const {
	contentFingerprint,
	countTodayNew,
	customQueueCount,
	enqueueCustomCard,
	insertItem,
	listCustomQueue,
	openDb,
	peekCustomQueue,
	removeCustomQueueRows,
} = await import("../db.ts");
const {
	critiqueLesson,
	generateLesson,
	parseGeneratedItem,
	validAnimation,
} = await import("../llm.ts");
const { formatStatusLine } = await import("../render.ts");

const FAKE_CTX = {} as ExtensionContext;
const FAKE_CONFIG = { thinkingLevel: "off" } as unknown as PetConfig;
const ADAPTIVE: AdaptiveContext = { profile: coldStartProfile(), budget: deriveBudget(coldStartProfile()) };
const FIXED_DAILY_PLAN = {
	adaptive: false,
	limit: 11,
	paused: false,
	wordTarget: 10,
	clozeTarget: 1,
	rampTarget: 11,
	dueReviews: 0,
	reason: "fixed test",
};

/** LLM mock returning canned JSON for every complete() call. */
function mockLlm(response: () => string, captured: { prompt?: string } = {}): PiSdkLlmClient {
	return {
		complete: async (_ctx: unknown, _resolved: unknown, request: { prompt: string }) => {
			captured.prompt = request.prompt;
			return response();
		},
		dispose: async () => {},
	} as unknown as PiSdkLlmClient;
}

function word(text: string, meaning = `释义 ${text}`): GeneratedItem {
	return { type: "word", text, meaning, phonetic: "/x/", example: `The ${text} runs.`, example_cn: `${text} 在跑。` };
}

function wordJson(text: string, meaning = `释义 ${text}`): GeneratedItem {
	return { type: "word", text, meaning, phonetic: "/x/", example: `The ${text} runs.`, example_cn: `${text} 在跑。` };
}

// -- db: migration + FIFO queue ------------------------------------------------

test("latest migration keeps custom_card_queue and registers schema version 16", () => {
	const db = openDb();
	try {
		const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='custom_card_queue'").get() as { name: string } | undefined;
		assert.ok(table, "custom_card_queue exists");
		const meta = db.prepare("SELECT schema_version FROM schema_meta WHERE id=1").get() as { schema_version: number };
		assert.equal(meta.schema_version, 18);
		const migrations = (db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as { version: number }[]).map((r) => r.version);
		assert.equal(migrations[migrations.length - 1], 18);
	} finally {
		db.close();
	}
});

test("enqueue/peek/remove keep FIFO order and stage fingerprints", () => {
	const db = openDb();
	try {
		enqueueCustomCard(db, "p1", word("alpha"));
		enqueueCustomCard(db, "p2", word("beta"));
		enqueueCustomCard(db, "p3", word("gamma"));
		assert.equal(customQueueCount(db), 3);

		const firstTwo = peekCustomQueue(db, 2);
		assert.deepEqual(
			firstTwo.map((row) => (JSON.parse(row.payload) as GeneratedItem).text),
			["alpha", "beta"],
			"peek returns oldest rows first",
		);
		assert.equal(firstTwo[0].fingerprint, contentFingerprint("word", "alpha", "释义 alpha"));
		assert.equal(firstTwo[0].prompt, "p1");

		removeCustomQueueRows(db, firstTwo.map((row) => row.id));
		assert.deepEqual(
			listCustomQueue(db).map((row) => (JSON.parse(row.payload) as GeneratedItem).text),
			["gamma"],
			"FIFO order preserved after removal",
		);
		assert.equal(customQueueCount(db), 1);
	} finally {
		db.close();
	}
});

test("countTodayNew counts custom introductions alongside planned", () => {
	const db = openDb();
	try {
		const now = new Date();
		const customId = insertItem(db, "word", "queueword", null, "排队词", null, null, now, { introductionKind: "custom" });
		const plannedId = insertItem(db, "word", "planword", null, "计划词", null, null, now, { introductionKind: "planned" });
		const duplicateId = insertItem(db, "word", "oldduplicate", null, "旧重复卡", null, null, now, { introductionKind: "planned" });
		assert.equal(countTodayNew(db, now), 0, "not yet introduced");
		db.prepare("UPDATE items SET introduced_at = ? WHERE id IN (?, ?, ?)").run(now.toISOString(), customId, plannedId, duplicateId);
		db.prepare("UPDATE items SET content_fingerprint = NULL, legacy_duplicate_of = ? WHERE id = ?").run(customId, duplicateId);
		assert.equal(countTodayNew(db, now), 2, "planned + custom count, quarantined duplicate does not");
	} finally {
		db.close();
	}
});

test("insertItem rejects the same lexical surface with a different meaning", () => {
	const db = openDb();
	try {
		const now = new Date();
		insertItem(db, "word", "workload-guard", null, "工作量；学习负担", null, null, now);
		const sensesBefore = Number((db.prepare("SELECT COUNT(*) AS n FROM lexical_senses").get() as { n: number }).n);
		assert.throws(
			() => insertItem(db, "word", " Workload-Guard ", null, "工作量", null, null, now),
			/DUPLICATE_CONTENT/,
		);
		const sensesAfter = Number((db.prepare("SELECT COUNT(*) AS n FROM lexical_senses").get() as { n: number }).n);
		assert.equal(sensesAfter, sensesBefore, "rejected duplicate creates no orphan lexical sense");
	} finally {
		db.close();
	}
});

// -- llm: partial lesson batches -------------------------------------------------

test("generateLesson partial batch accepts exactly 4 word items and rejects 5", async () => {
	const four = JSON.stringify({ ready: true, topic: "t", items: [0, 1, 2, 3].map((i) => wordJson(`fox${i}`)) });
	const decision = await generateLesson(
		mockLlm(() => four), FAKE_CTX, { provider: "p", model: "m", fromSession: false },
		"a conversation", [], FAKE_CONFIG, undefined, undefined, undefined,
		{ wordItems: 4, clozeItems: 0 },
	);
	assert.equal(decision.ready, true);
	assert.ok(decision.ready);
	assert.equal(decision.items.length, 4);

	const five = JSON.stringify({ ready: true, topic: "t", items: [0, 1, 2, 3, 4].map((i) => wordJson(`fox${i}`)) });
	await assert.rejects(
		generateLesson(
			mockLlm(() => five), FAKE_CTX, { provider: "p", model: "m", fromSession: false },
			"a conversation", [], FAKE_CONFIG, undefined, undefined, undefined,
			{ wordItems: 4, clozeItems: 0 },
		),
		/INVALID_LESSON_SHAPE/,
	);
});

test("generateLesson partial batch enforces the scaled phrase cap and word floor", async () => {
	// 4 phrases with wordItems=4: cap = min(3, 4) = 3 -> rejected by the objective gate.
	const fourPhrases = JSON.stringify({
		ready: true, topic: "t",
		items: [0, 1, 2, 3].map((i) => ({ ...wordJson(`lazy dog ${i}`), type: "phrase" })),
	});
	await assert.rejects(
		generateLesson(
			mockLlm(() => fourPhrases), FAKE_CTX, { provider: "p", model: "m", fromSession: false },
			"a conversation", [], FAKE_CONFIG, undefined, undefined, undefined,
			{ wordItems: 4, clozeItems: 0 },
		),
		/INVALID_LESSON_SHAPE/,
	);
	// 1 word + 1 phrase with wordItems=2: cap = min(3, 2) = 2 -> accepted.
	const mixed = JSON.stringify({
		ready: true, topic: "t",
		items: [wordJson("fox"), { ...wordJson("lazy dog"), type: "phrase" }],
	});
	const decision = await generateLesson(
		mockLlm(() => mixed), FAKE_CTX, { provider: "p", model: "m", fromSession: false },
		"a conversation", [], FAKE_CONFIG, undefined, undefined, undefined,
		{ wordItems: 2, clozeItems: 0 },
	);
	assert.ok(decision.ready);
});

// -- llm: critic composition -------------------------------------------------------

test("critiqueLesson custom composition skips the fixed-composition gate", async () => {
	// 11 items with 5 phrases trip the default full-batch composition rule...
	const items: GeneratedItem[] = [];
	for (let i = 0; i < 6; i++) items.push({ ...word(`fox${i}`), meaning: `狐狸${i}（名词，一种动物）` });
	for (let i = 0; i < 5; i++) items.push({ ...word(`lazy dog ${i}`), type: "phrase", meaning: `懒狗${i}（名词短语，懒惰的狗）` });
	const passLlm = mockLlm(() => JSON.stringify({ pass: true, issues: [], summary: "ok" }));

	const defaultVerdict = await critiqueLesson(
		passLlm, FAKE_CTX, { provider: "p", model: "m", fromSession: false },
		{ topic: "t", items }, [], FAKE_CONFIG, ADAPTIVE,
	);
	assert.equal(defaultVerdict.pass, false, "default composition gate rejects 5 phrases");
	assert.ok(defaultVerdict.issues.some((i) => i.category === "composition"));

	// ...but a custom batch (composition === null) must not be judged by it.
	const customVerdict = await critiqueLesson(
		passLlm, FAKE_CTX, { provider: "p", model: "m", fromSession: false },
		{ topic: "t", items }, [], FAKE_CONFIG, ADAPTIVE, null,
	);
	assert.equal(customVerdict.pass, true, "custom composition descriptor bypasses the fixed gate");
});

test("critiqueLesson explicit partial composition still enforces its own cap", async () => {
	const items = [0, 1, 2, 3].map((i) => ({ ...word(`lazy dog ${i}`), type: "phrase" }) as GeneratedItem);
	let calls = 0;
	const llm = mockLlm(() => { calls++; return JSON.stringify({ pass: true, issues: [], summary: "ok" }); });
	const verdict = await critiqueLesson(
		llm, FAKE_CTX, { provider: "p", model: "m", fromSession: false },
		{ topic: "t", items }, [], FAKE_CONFIG, ADAPTIVE, { wordItems: 4, clozeItems: 0 },
	);
	assert.equal(verdict.pass, false);
	assert.ok(verdict.issues.some((i) => i.category === "composition"));
	assert.equal(calls, 0, "deterministic gate short-circuits before the LLM critic");
});

// -- render: status line queue badge ---------------------------------------------

test("formatStatusLine appends the queue badge only when cards are queued", () => {
	const db = openDb();
	try {
		db.exec("DELETE FROM items; DELETE FROM custom_card_queue;");
		assert.equal(formatStatusLine(db, FIXED_DAILY_PLAN), "", "nothing left and empty queue -> no line");
		enqueueCustomCard(db, "p", word("alpha"));
		enqueueCustomCard(db, "p", word("beta"));
		const line = formatStatusLine(db, FIXED_DAILY_PLAN);
		assert.match(line, /排队 2/);
		assert.doesNotMatch(line, /今日剩余卡片/);
	} finally {
		db.close();
	}
});

// -- verb sense animation ---------------------------------------------------------

const GOOD_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 90"><circle cx="30" cy="60" r="10" fill="#4a7ebb"><animate attributeName="cy" values="60;30;60" dur="1.4s" repeatCount="indefinite"/></circle></svg>';

test("validAnimation accepts small SMIL svg and rejects unsafe or malformed input", () => {
	assert.equal(validAnimation(GOOD_SVG), true);
	assert.equal(validAnimation(GOOD_SVG.replace("</svg>", "") ), false);
	assert.equal(validAnimation("hello"), false);
	assert.equal(validAnimation('<svg onload="x()"></svg>'), false);
	assert.equal(validAnimation('<svg><script>1</script></svg>'), false);
	assert.equal(validAnimation('<svg><a href="http://x"></a></svg>'), false);
	assert.equal(validAnimation(`<svg>${"x".repeat(2100)}</svg>`), false);
});

test("parseGeneratedItem carries a valid animation and drops an invalid one", () => {
	const base = { type: "word", text: "jump", meaning: "v. 跳，跳跃" };
	const kept = parseGeneratedItem({ ...base, animation: GOOD_SVG });
	assert.equal(kept?.animation, GOOD_SVG);
	assert.equal(parseGeneratedItem({ ...base, animation: "<svg><script>x</script></svg>" }), undefined);
	assert.equal(parseGeneratedItem({ ...base, animation: 42 }), undefined);
	assert.equal(parseGeneratedItem(base)?.animation, undefined);
});

test("insertItem persists the animation column", () => {
	const db = openDb(join(mkdtempSync(join(tmpdir(), "anki-anim-")), "t.db"));
	try {
		const id = insertItem(db, "word", "jump", null, "v. 跳，跳跃", null, null, new Date(), { animation: GOOD_SVG, introductionKind: "custom" });
		const row = db.prepare("SELECT animation FROM items WHERE id = ?").get(id) as { animation: string };
		assert.equal(row.animation, GOOD_SVG);
		insertItem(db, "word", "sigh", null, "v. 叹气", null, null, new Date(), {});
		assert.equal((db.prepare("SELECT animation FROM items WHERE text = 'sigh'").get() as { animation: string | null }).animation, null);
	} finally {
		db.close();
	}
});
