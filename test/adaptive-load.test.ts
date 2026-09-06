import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
	deriveAdaptiveDailyLoad,
	formatDailyLoadPlan,
	nextAdaptiveLessonBatch,
} from "../adaptive-load.ts";

const STRONG = {
	dueReviews: 0,
	recallEvidence: 50,
	recallRate: 0.88,
	assistanceRate: 0.04,
};

test("adaptive load starts at 17 and rises by one every 14 days to 22", () => {
	assert.equal(deriveAdaptiveDailyLoad({ ...STRONG, dayIndex: 0 }).limit, 17);
	assert.equal(deriveAdaptiveDailyLoad({ ...STRONG, dayIndex: 14 }).limit, 18);
	assert.equal(deriveAdaptiveDailyLoad({ ...STRONG, dayIndex: 42 }).limit, 20);
	const mature = deriveAdaptiveDailyLoad({ ...STRONG, dayIndex: 70 });
	assert.deepEqual(
		{ limit: mature.limit, words: mature.wordTarget, clozes: mature.clozeTarget },
		{ limit: 22, words: 20, clozes: 2 },
	);
});

test("ramp waits for enough evidence and respects the configured ceiling", () => {
	const waiting = deriveAdaptiveDailyLoad({ ...STRONG, dayIndex: 70, recallEvidence: 12 });
	assert.equal(waiting.limit, 17);
	assert.match(waiting.reason, /积累答题证据/);
	assert.equal(
		deriveAdaptiveDailyLoad({ ...STRONG, dayIndex: 70, recallEvidence: 12, recallRate: 0.5 }).limit,
		11,
		"poor recall still reduces load while evidence is sparse",
	);
	assert.equal(deriveAdaptiveDailyLoad({ ...STRONG, dayIndex: 70 }, 19).limit, 19);
});

test("quality and due-review load automatically reduce or pause new cards", () => {
	assert.equal(
		deriveAdaptiveDailyLoad({ ...STRONG, dayIndex: 42, recallRate: 0.58 }).limit,
		11,
	);
	assert.equal(
		deriveAdaptiveDailyLoad({ ...STRONG, dayIndex: 42, assistanceRate: 0.3 }).limit,
		14,
	);
	assert.equal(
		deriveAdaptiveDailyLoad({ ...STRONG, dayIndex: 42, dueReviews: 40 }).limit,
		11,
	);
	const catchUp = deriveAdaptiveDailyLoad({ ...STRONG, dayIndex: 42, dueReviews: 60 });
	assert.equal(catchUp.paused, true);
	assert.equal(catchUp.limit, 0);
	assert.match(formatDailyLoadPlan(catchUp), /暂停新增.*只复习/);
});

test("adaptive generation fills 17 cards as 10+1 then 5+1", () => {
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE items (type TEXT, introduction_kind TEXT, introduced_at TEXT, legacy_duplicate_of INTEGER)");
	const now = new Date(2026, 7, 27, 12, 0, 0);
	const plan = deriveAdaptiveDailyLoad({ ...STRONG, dayIndex: 0 });
	assert.deepEqual(nextAdaptiveLessonBatch(db, now, plan), { wordItems: 10, clozeItems: 1 });

	const insert = db.prepare("INSERT INTO items(type,introduction_kind,introduced_at) VALUES(?,?,?)");
	for (let index = 0; index < 10; index++) insert.run("word", "planned", now.toISOString());
	insert.run("cloze", "planned", now.toISOString());
	assert.deepEqual(nextAdaptiveLessonBatch(db, now, plan), { wordItems: 5, clozeItems: 1 });

	for (let index = 0; index < 5; index++) insert.run("word", "planned", now.toISOString());
	insert.run("cloze", "planned", now.toISOString());
	assert.equal(nextAdaptiveLessonBatch(db, now, plan), undefined);
	db.close();
});
