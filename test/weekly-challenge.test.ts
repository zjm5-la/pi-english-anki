import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "anki-weekly-test-"));
const { insertItem, openDb } = await import("../db.ts");
const {
	WEEKLY_CHALLENGE_MAX_PER_RUN,
	recordWeeklyChallengeDelivery,
	weeklyChallengeOwed,
	weeklyChallengePrompt,
	weeklyChallengeState,
} = await import("../weekly-challenge.ts");

const WEEK_MS = 7 * 24 * 3600 * 1000;

test("owed counts whole elapsed weeks and never goes negative", () => {
	const now = new Date();
	const state = { version: 1 as const, anchor: new Date(now.getTime() - 6.9 * WEEK_MS).toISOString(), delivered: 0 };
	assert.equal(weeklyChallengeOwed(state, now), 6, "6.9 weeks elapsed owe six whole weeks");
	const full = { ...state, anchor: new Date(now.getTime() - 7 * WEEK_MS).toISOString() };
	assert.equal(weeklyChallengeOwed(full, now), 7);
	assert.equal(weeklyChallengeOwed({ ...full, delivered: 1 }, now), 6);
	assert.equal(weeklyChallengeOwed({ ...full, delivered: 99 }, now), 0);
});

test("ledger anchors at the first learned card and owes every elapsed week", () => {
	const db = openDb();
	const anchor = new Date(Date.now() - 9 * WEEK_MS - 3600 * 1000);
	insertItem(db, "word", "anchorword", null, "锚（名词）", "An anchor word.", "锚词。", anchor);
	const state = weeklyChallengeState(db);
	assert.equal(Date.parse(state.anchor), anchor.getTime());
	assert.equal(state.delivered, 0);
	assert.equal(weeklyChallengeOwed(state), 9, "nine elapsed weeks are owed as backfill");
});

test("delivery persists and malformed state re-initializes from the deck", () => {
	const db = openDb();
	const state = weeklyChallengeState(db);
	assert.equal(state.delivered, 0);
	const updated = recordWeeklyChallengeDelivery(db, state, 2);
	assert.equal(updated.delivered, 2);
	assert.equal(weeklyChallengeOwed(updated), 7, "seven weeks still owed");
	assert.equal(weeklyChallengeState(db).delivered, 2, "persisted across reads");
	db.prepare("UPDATE stats SET value = 'not json' WHERE key = 'weekly_challenge'").run();
	const reset = weeklyChallengeState(db);
	assert.equal(reset.delivered, 0, "malformed state resets");
	assert.equal(weeklyChallengeOwed(reset), 9, "anchor falls back to the deck's first learned card");
	assert.ok(WEEKLY_CHALLENGE_MAX_PER_RUN >= 1);
});

test("prompt demands challenging but common vocabulary", () => {
	const prompt = weeklyChallengePrompt(3);
	assert.match(prompt, /3 张/);
	assert.match(prompt, /B2–C1/);
	assert.match(prompt, /高频常用/);
	assert.match(prompt, /严禁生僻词/);
	assert.match(prompt, /推文/);
});
