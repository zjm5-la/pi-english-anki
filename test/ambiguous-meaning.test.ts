import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PiSdkLlmClient } from "../pi-sdk-llm.ts";
import type { PetConfig } from "../config.ts";
import {
	knownList,
	replacementKnownList,
	meaningCollisions,
	normalizeMeaning,
	openDb,
	type ItemRow,
} from "../db.ts";
import {
	critiqueLesson,
	evaluateAttempt,
	generateCustomCards,
	generateLesson,
	generateReplacement,
	type GeneratedItem,
} from "../llm.ts";
import {
	forwardCue,
	forwardCueSuffix,
	meaningHasForwardSenseClue,
	meaningHasVisiblePos,
	questionHasForwardCue,
	recallQuestionText,
} from "../render.ts";
import {
	coldStartProfile,
	deriveBudget,
	type AdaptiveContext,
} from "../learner-profile.ts";

// -- Ambiguous forward production prompts (book/reserve → 预订) ---------------

const FAKE_CTX = {} as ExtensionContext;
const FAKE_CONFIG = { thinkingLevel: "off" } as unknown as PetConfig;
const ADAPTIVE: AdaptiveContext = {
	profile: coldStartProfile(),
	budget: deriveBudget(coldStartProfile()),
};
const RESOLVED = { provider: "p", model: "m", fromSession: false } as const;

function wordItem(
	overrides: Partial<ItemRow> & Pick<ItemRow, "id" | "text" | "meaning">,
): ItemRow {
	return {
		type: "word",
		phonetic: null,
		example: null,
		example_cn: null,
		learned_at: "2026-01-01T00:00:00.000Z",
		fsrs_state: "",
		due_at: "2026-01-01T00:00:00.000Z",
		shown: 1,
		reviews: 0,
		status: "learning",
		levels: null,
		levels_cn: null,
		chunks: null,
		key_words: null,
		progress: 0,
		...overrides,
	} as ItemRow;
}

const CLOZE = wordItem({
	id: 5,
	text: "He ___ (reserve) a table.",
	meaning: "reserved",
});
CLOZE.type = "cloze";

const BOOK = wordItem({
	id: 1,
	text: "book",
	meaning: "预订",
	example: "I want to book a table for two.",
});
const RESERVE = wordItem({
	id: 2,
	text: "reserve",
	meaning: "预订",
	example: "I want to reserve a table for two.",
});

interface DbHandle {
	db: ReturnType<typeof openDb>;
	close: () => void;
}

function freshDb(): DbHandle {
	const agentDir = mkdtempSync(join(tmpdir(), "kaomoji-ambiguous-test-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const db = openDb();
	return {
		db,
		close: () => {
			db.close();
			rmSync(agentDir, { recursive: true, force: true });
		},
	};
}

function insertWord(
	db: ReturnType<typeof openDb>,
	text: string,
	meaning: string,
	type: "word" | "sentence" = "word",
): number {
	const r = db
		.prepare(
			"INSERT INTO items (type, text, meaning, learned_at, due_at) VALUES (?, ?, ?, ?, ?)",
		)
		.run(type, text, meaning, new Date().toISOString(), new Date().toISOString());
	return Number(r.lastInsertRowid);
}

// -- Cue computation -------------------------------------------------------

test("forwardCue: context only with a uniform blank regardless of target length", () => {
	const bookCue = forwardCue(BOOK);
	assert.ok(bookCue);
	assert.deepEqual(Object.keys(bookCue).sort(), ["chineseContext", "context"]);
	assert.equal(bookCue.context, "I want to ____ a table for two.");

	const reserveCue = forwardCue(RESERVE);
	assert.ok(reserveCue);
	assert.doesNotMatch(forwardCueSuffix(reserveCue), /首字母|开头|字母|词长/);
	assert.equal(reserveCue.context, "I want to ____ a table for two.");

	// Case-insensitive containment still masks; missing target yields no context.
	const upper = forwardCue(
		wordItem({
			id: 3,
			text: "reserve",
			meaning: "预订",
			example: "Please RESERVE two seats.",
		}),
	);
	assert.equal(upper?.context, "Please ____ two seats.");
	const absent = forwardCue(
		wordItem({
			id: 4,
			text: "reserve",
			meaning: "预订",
			example: "I called the restaurant.",
		}),
	);
	assert.equal(absent?.context, undefined);
	assert.equal(absent, undefined);
	const inflected = forwardCue(
		wordItem({
			id: 6,
			text: "book",
			meaning: "预订",
			example: "I am booking a room.",
		}),
	);
	assert.equal(inflected?.context, "I am ____ a room.", "inflected targets are fully masked");
});

test("meaningHasForwardSenseClue requires POS plus a same-paren collocation or sense limit", () => {
	assert.equal(meaningHasVisiblePos("表演"), false);
	assert.equal(meaningHasForwardSenseClue("表演"), false);
	assert.equal(meaningHasVisiblePos("表演（名词）"), true);
	assert.equal(meaningHasForwardSenseClue("表演（名词）"), false);
	assert.equal(meaningHasForwardSenseClue("【名词】表演"), false);
	assert.equal(
		meaningHasForwardSenseClue("一场具体的演出（可数名词，常与 give 搭配，强调演出本身或当场表现）"),
		true,
	);
	assert.equal(meaningHasForwardSenseClue("【动词】交流（指与他人交换信息或想法）"), true);
});

test("recallQuestionText adds forward collision cues and reverse sense context", () => {
	const cue = forwardCue(RESERVE);
	assert.equal(
		recallQuestionText(BOOK, "forward"),
		"默写单词「预订」的英文",
		"no cue argument keeps the bare prompt",
	);
	assert.equal(
		recallQuestionText(RESERVE, "forward", cue),
		"默写单词「预订」的英文（例：I want to ____ a table for two.）",
	);
	assert.equal(
		recallQuestionText(RESERVE, "reverse", cue),
		"在例句「I want to reserve a table for two.」中，单词「reserve」是什么意思？",
		"reverse prompt uses the English example to identify the intended sense",
	);
	assert.equal(
		recallQuestionText(wordItem({ id: 7, text: "work", meaning: "起作用" }), "reverse"),
		"写出单词「work」的中文释义",
		"legacy cards without an example retain the generic fallback",
	);
	assert.equal(
		recallQuestionText(CLOZE, "forward", cue),
		"语法填空：He ___ (reserve) a table.",
	);
	assert.ok(questionHasForwardCue(recallQuestionText(RESERVE, "forward", cue)));
	assert.equal(
		questionHasForwardCue(recallQuestionText(BOOK, "forward")),
		false,
	);
});

// -- DB collision helper ---------------------------------------------------

test("meaningCollisions: exact normalized meaning match across approved word/phrase items", () => {
	const handle = freshDb();
	try {
		const bookId = insertWord(handle.db, "book", "预订");
		const reserveId = insertWord(handle.db, "reserve", " 预订 "); // trimmed/collapsed equal
		const appleId = insertWord(handle.db, "apple", "苹果");
		const sentenceId = insertWord(handle.db, "book", "预订", "sentence");

		const forBook = meaningCollisions(handle.db, {
			id: bookId,
			type: "word",
			meaning: "预订",
		});
		assert.deepEqual(
			forBook.map((row) => row.text),
			["reserve"],
		);
		const forReserve = meaningCollisions(handle.db, {
			id: reserveId,
			type: "word",
			meaning: "预订",
		});
		assert.deepEqual(
			forReserve.map((row) => row.text),
			["book"],
		);
		// A sentence sharing the meaning never collides (only word/phrase prompts can collide).
		assert.deepEqual(
			meaningCollisions(handle.db, {
				id: sentenceId,
				type: "sentence",
				meaning: "预订",
			}),
			[],
		);
		assert.deepEqual(
			meaningCollisions(handle.db, { id: appleId, type: "word", meaning: "苹果" }),
			[],
		);
		// The sentence item does not make book's prompt ambiguous.
		assert.deepEqual(
			meaningCollisions(handle.db, {
				id: bookId,
				type: "word",
				meaning: "预订",
			}).map((r) => r.id),
			[forBook[0].id],
		);
	} finally {
		handle.close();
	}
});

test("knownList includes text plus meaning so the critic can see prior collisions", () => {
	const handle = freshDb();
	try {
		insertWord(handle.db, "book", "预订");
		handle.db.prepare("UPDATE items SET shown = 1").run();
		assert.deepEqual(knownList(handle.db), ["book（预订）"]);
	} finally {
		handle.close();
	}
});

test("normalizeMeaning trims, lowercases, and collapses whitespace", () => {
	assert.equal(normalizeMeaning("  预订\t订　位 "), "预订 订 位");
	assert.equal(normalizeMeaning("Book"), "book");
});

// -- Evaluator rubric grades against the shown prompt -----------------------

test("bare forward prompt: natural synonym matching the Chinese cue is correct with distinguishing feedback", async () => {
	const captured: string[] = [];
	const llm = {
		complete: async (_ctx: unknown, _r: unknown, request: { prompt: string }) => {
			captured.push(request.prompt);
			return JSON.stringify({ verdict: "correct", feedback: "ok" });
		},
		dispose: async () => {},
	} as unknown as PiSdkLlmClient;
	const result = await evaluateAttempt(
		llm,
		FAKE_CTX,
		BOOK,
		"reserve",
		{ provider: "p", model: "m" },
		"forward",
		"默写单词「预订」的英文",
	);
	assert.equal(result.verdict, "correct");
	const prompt = captured[0];
	assert.match(prompt, /题面（按题面判分）：默写单词「预订」的英文/);
	assert.match(prompt, /任何一个自然且完全符合该中文提示的英文单词\/词组都算对/);
	assert.match(prompt, /book 与 reserve 都可表示「预订」/);
	assert.match(prompt, /反馈须点明本题目标是「book」/);
	assert.doesNotMatch(prompt, /题面线索已唯一指向/);
});

test("contextual forward prompt accepts natural synonyms without assuming uniqueness", async () => {
	const captured: string[] = [];
	const llm = {
		complete: async (_ctx: unknown, _r: unknown, request: { prompt: string }) => {
			captured.push(request.prompt);
			return JSON.stringify({ verdict: "partial", feedback: "线索不符" });
		},
		dispose: async () => {},
	} as unknown as PiSdkLlmClient;
	const question = recallQuestionText(RESERVE, "forward", forwardCue(RESERVE));
	await evaluateAttempt(
		llm,
		FAKE_CTX,
		RESERVE,
		"book",
		{ provider: "p", model: "m" },
		"forward",
		question,
	);
	const prompt = captured[0];
	assert.match(prompt, /题面（按题面判分）：默写单词「预订」的英文（例：/);
	assert.match(prompt, /语境存在不代表答案唯一/);
	assert.match(
		prompt,
		/只要能自然代入已展示的挖空例句和中文语境，也算 correct/,
	);
	assert.doesNotMatch(prompt, /任何一个自然且完全符合该中文提示/);
});

test("contextual reverse prompt grades only the sense used in the shown example", async () => {
	const captured: string[] = [];
	const work = wordItem({
		id: 8,
		text: "work",
		meaning: "起作用",
		example: "The new settings work after a restart.",
	});
	const llm = {
		complete: async (_ctx: unknown, _r: unknown, request: { prompt: string }) => {
			captured.push(request.prompt);
			return JSON.stringify({ verdict: "incorrect", feedback: "义项不符" });
		},
		dispose: async () => {},
	} as unknown as PiSdkLlmClient;
	await evaluateAttempt(
		llm,
		FAKE_CTX,
		work,
		"工作",
		{ provider: "p", model: "m" },
		"reverse",
		recallQuestionText(work, "reverse"),
	);
	assert.match(captured[0], /题面（按题面判分）：在例句「The new settings work after a restart\.」中/);
	assert.match(captured[0], /题面例句已经限定目标义项/);
	assert.match(captured[0], /不符合本句的其它常见义项，应判 incorrect/);
});

test("generic reverse fallback accepts any valid common sense because the prompt is ambiguous", async () => {
	const captured: string[] = [];
	const llm = {
		complete: async (_ctx: unknown, _r: unknown, request: { prompt: string }) => {
			captured.push(request.prompt);
			return JSON.stringify({ verdict: "correct", feedback: "也是常见义项" });
		},
		dispose: async () => {},
	} as unknown as PiSdkLlmClient;
	await evaluateAttempt(
		llm,
		FAKE_CTX,
		wordItem({ id: 9, text: "work", meaning: "起作用" }),
		"工作",
		{ provider: "p", model: "m" },
		"reverse",
		"写出单词「work」的中文释义",
	);
	assert.match(captured[0], /题面没有提供义项语境/);
	assert.match(captured[0], /任一常见且成立的中文义项都算 correct/);
});

test("cloze evaluation remains independent of the recall question text", async () => {
	const captured: string[] = [];
	const llm = {
		complete: async (_ctx: unknown, _r: unknown, request: { prompt: string }) => {
			captured.push(request.prompt);
			return JSON.stringify({ verdict: "incorrect", feedback: "" });
		},
		dispose: async () => {},
	} as unknown as PiSdkLlmClient;
	await evaluateAttempt(
		llm,
		FAKE_CTX,
		CLOZE,
		"reserve",
		{ provider: "p", model: "m" },
		"forward",
		"语法填空：He ___ (reserve) a table.",
	);
	assert.doesNotMatch(captured[0], /题面（按题面判分）/);
	assert.match(captured[0], /填空句/);
});

// -- Content prevention ----------------------------------------------------

test("critic deterministically rejects a batch with two identical normalized meanings", async () => {
	const llm = {
		complete: async () => {
			throw new Error("LLM must not be called for a deterministic rejection");
		},
		dispose: async () => {},
	} as unknown as PiSdkLlmClient;
	const colliding: GeneratedItem[] = [
		{
			type: "word",
			text: "book",
			meaning: " 预订 ",
			example: "I want to book a table.",
			example_cn: "我想订个位子。",
		},
		{
			type: "word",
			text: "reserve",
			meaning: "预订",
			example: "I want to reserve a table.",
			example_cn: "我想订个位子。",
		},
	];
	const verdict = await critiqueLesson(
		llm,
		FAKE_CTX,
		RESOLVED,
		{ topic: "t", items: colliding },
		[],
		FAKE_CONFIG,
		ADAPTIVE,
	);
	assert.equal(verdict.available, true);
	assert.equal(verdict.pass, false);
	const dup = verdict.issues.find((issue) => issue.category === "dup");
	assert.ok(dup, "collision is reported as a dup blocker");
	assert.match(dup.description, /book.*reserve.*预订/);
	// Distinct meanings reach the LLM critic normally.
	const distinct: GeneratedItem[] = [
		{
			type: "word",
			text: "book",
			meaning: "预订（动词，提前占座位或房间）",
			example: "I want to book a table.",
			example_cn: "我想订个位子。",
		},
		{
			type: "word",
			text: "bank",
			meaning: "银行（名词，存放钱的机构）",
			example: "The bank opens at nine.",
			example_cn: "银行九点开门。",
		},
	];
	const llm2 = {
		complete: async () =>
			JSON.stringify({ pass: true, issues: [], summary: "ok" }),
		dispose: async () => {},
	} as unknown as PiSdkLlmClient;
	const ok = await critiqueLesson(
		llm2,
		FAKE_CTX,
		RESOLVED,
		{ topic: "t", items: distinct },
		[],
		FAKE_CONFIG,
		ADAPTIVE,
	);
	assert.equal(ok.pass, true);
});

test("generation and critic prompts carry the example-must-contain-text and sense-specific meaning rules", async () => {
	const prompts: Record<string, string> = {};
	const capture = (key: string) =>
		({
			complete: async (
				_ctx: unknown,
				_r: unknown,
				request: { prompt: string },
			) => {
				prompts[key] = request.prompt;
				return JSON.stringify({ ready: false, reason: "test" });
			},
			dispose: async () => {},
		}) as unknown as PiSdkLlmClient;
	await generateLesson(
		capture("lesson"),
		FAKE_CTX,
		RESOLVED,
		"a real conversation with english",
		[],
		FAKE_CONFIG,
		undefined,
		ADAPTIVE,
	);
	const skipped = {
		type: "word",
		text: "reload",
		meaning: "重新加载",
	} as unknown as ItemRow;
	await generateReplacement(
		capture("replacement"),
		FAKE_CTX,
		RESOLVED,
		"conversation",
		[],
		FAKE_CONFIG,
		skipped,
		ADAPTIVE,
	);
	await generateCustomCards(
		capture("custom"),
		FAKE_CTX,
		RESOLVED,
		"5 张点餐词汇",
		[],
		FAKE_CONFIG,
		ADAPTIVE,
	);
	for (const [key, prompt] of Object.entries(prompts)) {
		assert.match(
			prompt,
			/example 必须原样包含所教.*text（大小写不限）/,
			`${key} requires examples to contain the taught text`,
		);
		assert.match(
			prompt,
			/book 与 reserve 都表示「预订」/,
			`${key} names the collision example`,
		);
		assert.match(
			prompt,
			/可区分的义项或场景/,
			`${key} requires sense-specific meanings`,
		);
	}
	// The critic (LLM path) carries the same contract.
	const criticCapture = {
		complete: async (_ctx: unknown, _r: unknown, request: { prompt: string }) => {
			prompts.critic = request.prompt;
			return JSON.stringify({ pass: true, issues: [], summary: "ok" });
		},
		dispose: async () => {},
	} as unknown as PiSdkLlmClient;
	const word: GeneratedItem = {
		type: "word",
		text: "reload",
		meaning: "重新加载（动词，把最新内容再载入一次）",
		example: "Reload the extension.",
		example_cn: "重新加载扩展。",
	};
	await critiqueLesson(
		criticCapture,
		FAKE_CTX,
		RESOLVED,
		{ topic: "t", items: [word] },
		["book（预订）"],
		FAKE_CONFIG,
		ADAPTIVE,
	);
	assert.match(
		prompts.critic,
		/example 必须原样包含所教 text（大小写不限）；违反记 blocker/,
	);
	assert.match(
		prompts.critic,
		/中文释义与批内其它学习项或已学内容完全相同时.*book 与 reserve 都是「预订」/,
	);
	assert.match(
		prompts.critic,
		/book（预订）/,
		"critic sees prior collisions via the known list",
	);
});


test("replacement prompt includes all canonical cards beyond the most recent fifty", async () => {
	const handle = freshDb();
	try {
		const oldest = insertWord(handle.db, "morning", "早晨");
		for (let i = 0; i < 60; i++) insertWord(handle.db, `newer-${i}`, `新词${i}`);
		const duplicate = insertWord(handle.db, "legacy-morning", "历史重复");
		handle.db.prepare("UPDATE items SET legacy_duplicate_of=? WHERE id=?").run(oldest, duplicate);
		const known = replacementKnownList(handle.db);
		assert.equal(known.length, 61);
		assert.ok(known.includes("word: morning = 早晨"), "oldest card remains in exclusion context");
		assert.ok(known.includes("word: newer-59 = 新词59"), "unshown inventory is excluded too");
		assert.ok(!known.some((entry) => entry.includes("legacy-morning")));
		let prompt = "";
		const llm = {
			complete: async (_ctx: unknown, _resolved: unknown, request: { prompt: string }) => {
				prompt = request.prompt;
				return JSON.stringify({ ready: false, reason: "test" });
			},
		} as unknown as PiSdkLlmClient;
		await generateReplacement(llm, FAKE_CTX, RESOLVED, "", known, FAKE_CONFIG,
			wordItem({ id: oldest, text: "morning", meaning: "早晨" }), ADAPTIVE);
		assert.match(prompt, /word: morning = 早晨/);
		assert.match(prompt, /word: newer-59 = 新词59/);
	} finally { handle.close(); }
});


test("forward target context masks repeated forms and bilingual answer fragments", () => {
	const item = wordItem({ id: 282, text: "goal", meaning: "目标（可数名词，指希望达到的结果）", example: "My goal is clear. These goals matter.", example_cn: "我的 goal 很清楚，这些 goals 很重要。" });
	const cue = forwardCue(item)!;
	assert.doesNotMatch(forwardCueSuffix(cue), /首字母|开头|字母|词长/);
	assert.equal(cue.context, "My ____ is clear. These ____ matter.");
	assert.equal(cue.chineseContext, "我的 ____ 很清楚，这些 ____ 很重要。");
	assert.doesNotMatch(recallQuestionText(item, "forward", cue), /goal/i);
	const unsafe = forwardCue({ ...item, example: "Goalkeeper is my goal." });
	assert.equal(unsafe?.context, undefined, "unknown target fragments never escape masking");
	const oneLetter = wordItem({ id: 1, text: "a", meaning: "一个（冠词，泛指任意一个）", example: "I need a pen." });
	const question = recallQuestionText(oneLetter, "forward", forwardCue(oneLetter));
	assert.doesNotMatch(question, /以 a 开头/);
	assert.match(question, /例：I need ____ pen/);
	assert.equal(questionHasForwardCue(question), true);
});


test("inflected targets mask their base forms and unsafe qualifiers retain the Chinese core", () => {
	for (const [text, example, expected] of [
		["goals", "One goal and two goals.", "One ____ and two ____."],
		["booked", "I booked it; I book rooms often.", "I ____ it; I ____ rooms often."],
	]) {
		assert.equal(forwardCue(wordItem({ id: 1, text, meaning: "测试", example }))?.context, expected);
	}
	const work = wordItem({ id: 2, text: "work", meaning: "工作（名词，指 workplace 里的任务）" });
	const question = recallQuestionText(work, "forward", forwardCue(work));
	assert.match(question, /工作（名词）/);
	assert.doesNotMatch(question, /workplace|根据语境回忆目标词/);
});
