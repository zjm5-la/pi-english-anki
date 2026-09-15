import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULTS } from "../config.ts";
import { getStat, openDb } from "../db.ts";
import { autoRefillPlan, autoRefillStrategy, AUTO_REFILL_STAT, writeAutoRefillStatus } from "../auto-refill.ts";

const NOW = new Date("2026-09-15T04:00:00.000Z");
const config = { ...DEFAULTS, adaptiveNewCards: false, dailyNewLimit: 18 };
function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "anki-refill-test-"));
	process.env.PI_CODING_AGENT_DIR = dir;
	const db = openDb();
	let seq = 0;
	return {
		db,
		word(shown = 0, introduced = false) {
			return Number(db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown,reviews,introduction_kind,introduced_at) VALUES('word',?,'词（名词）',?,?,?,?,'planned',?)")
				.run(`word${++seq}`, NOW.toISOString(), NOW.toISOString(), shown, shown, introduced ? NOW.toISOString() : null).lastInsertRowid);
		},
		close() { db.close(); rmSync(dir, { recursive: true, force: true }); },
	};
}

test("refill reserve accounts for today's introductions, inventory, and staged custom cards", () => {
	const f = fixture();
	try {
		for (let i = 0; i < 15; i++) f.word(1, true);
		f.word();
		assert.equal(autoRefillPlan(f.db, config, NOW).slots, 2);
		f.db.prepare("INSERT INTO custom_card_queue(created_at,prompt,fingerprint,payload) VALUES(?,'test','queued','{}')").run(NOW.toISOString());
		const reserve = autoRefillPlan(f.db, config, NOW);
		assert.equal(reserve.slots, 1);
		assert.equal(reserve.shouldRefill, false, "low-water trigger avoids a new model call for each consumed card");
		assert.equal(reserve.status.target, 3);
	} finally { f.close(); }
});

test("disabled, exhausted, and review-overloaded plans never launch generation", () => {
	const f = fixture();
	try {
		assert.equal(autoRefillPlan(f.db, { ...config, intervalMinutes: 0 }, NOW).status.phase, "paused");
		for (let i = 0; i < 60; i++) f.word(1, true);
		assert.equal(autoRefillPlan(f.db, config, NOW).status.phase, "quota_reached");
		const overloaded = autoRefillPlan(f.db, { ...config, adaptiveNewCards: true }, NOW);
		assert.equal(overloaded.status.phase, "paused");
		assert.equal(overloaded.shouldRefill, false);
		assert.equal(overloaded.slots, 0);
	} finally { f.close(); }
});

test("unlimited quota still keeps only a five-card reserve and ignores quarantined stock", () => {
	const f = fixture();
	try {
		const bad = f.word();
		f.db.prepare("UPDATE items SET content_status='quarantined' WHERE id=?").run(bad);
		const cfg = { ...config, dailyNewLimit: 0 };
		assert.equal(autoRefillPlan(f.db, cfg, NOW).slots, 5);
		for (let i = 0; i < 5; i++) f.word();
		assert.equal(autoRefillPlan(f.db, cfg, NOW).shouldRefill, false);
	} finally { f.close(); }
});

test("small automatic batches retain the adaptive grammar allocation", () => {
	const f = fixture();
	try {
		const cfg = { ...config, adaptiveNewCards: true };
		assert.deepEqual(autoRefillPlan(f.db, cfg, NOW).batch, { wordItems: 4, clozeItems: 1 });
		for (let i = 0; i < 2; i++) {
			const id = f.word(1, true);
			f.db.prepare("UPDATE items SET type='cloze' WHERE id=?").run(id);
		}
		assert.deepEqual(autoRefillPlan(f.db, cfg, NOW).batch, { wordItems: 5, clozeItems: 0 });
	} finally { f.close(); }
});

test("live status refreshes its heartbeat within fifteen seconds without writing on every poll", () => {
	const f = fixture();
	try {
		const status = autoRefillPlan(f.db, config, NOW).status;
		writeAutoRefillStatus(f.db, status);
		writeAutoRefillStatus(f.db, { ...status, updatedAt: new Date(NOW.getTime() + 1000).toISOString() });
		assert.equal(JSON.parse(getStat(f.db, AUTO_REFILL_STAT)).updatedAt, status.updatedAt);
		const later = new Date(NOW.getTime() + 15_000).toISOString();
		writeAutoRefillStatus(f.db, { ...status, updatedAt: later });
		assert.equal(JSON.parse(getStat(f.db, AUTO_REFILL_STAT)).updatedAt, later);
	} finally { f.close(); }
});

test("daily preparation requires both the desktop marker and RPC mode", () => {
	assert.equal(autoRefillStrategy("rpc", "desktop"), "daily");
	assert.equal(autoRefillStrategy("rpc", ""), "reserve");
	assert.equal(autoRefillStrategy("tui", "desktop"), "reserve");
	assert.equal(autoRefillStrategy(undefined, "desktop"), "reserve");
});

test("daily preparation continues above five stored cards and excludes replacement inventory", () => {
	const f = fixture();
	try {
		for (let i = 0; i < 5; i++) f.word();
		for (let i = 0; i < 4; i++) f.word(1, true);
		const replacement = f.word();
		f.db.prepare("UPDATE items SET introduction_kind='replacement' WHERE id=?").run(replacement);
		f.db.prepare("INSERT INTO custom_card_queue(created_at,prompt,fingerprint,payload) VALUES(?,'test','queued','{}')").run(NOW.toISOString());
		const daily = autoRefillPlan(f.db, config, NOW, "daily");
		assert.equal(daily.status.strategy, "daily");
		assert.equal(daily.status.inventory, 5);
		assert.equal(daily.status.queued, 1);
		assert.equal(daily.status.target, 14);
		assert.equal(daily.slots, 8);
		assert.equal(daily.shouldRefill, true);
		assert.equal(autoRefillPlan(f.db, config, NOW).shouldRefill, false);
		for (let i = 0; i < 8; i++) f.word();
		assert.equal(autoRefillPlan(f.db, config, NOW, "daily").shouldRefill, false);
	} finally { f.close(); }
});

test("daily unlimited preparation is finite and deducts cards already introduced today", () => {
	const f = fixture();
	try {
		const cfg = { ...config, dailyNewLimit: 0 };
		assert.equal(autoRefillPlan(f.db, cfg, NOW, "daily").status.target, 22);
		for (let i = 0; i < 20; i++) f.word(1, true);
		const remaining = autoRefillPlan(f.db, cfg, NOW, "daily");
		assert.equal(remaining.status.target, 2);
		assert.match(remaining.status.reason, /每日自动备课最多 22 张/);
		f.word(); f.word();
		assert.equal(autoRefillPlan(f.db, cfg, NOW, "daily").shouldRefill, false);
		f.db.prepare("UPDATE items SET shown=1,introduced_at=?").run(NOW.toISOString());
		assert.equal(autoRefillPlan(f.db, cfg, NOW, "daily").status.phase, "quota_reached");
	} finally { f.close(); }
});

test("daily preparation recomputes at midnight and still counts remaining stored stock", () => {
	const f = fixture();
	try {
		for (let i = 0; i < 16; i++) f.word(1, true);
		f.word(); f.word();
		assert.equal(autoRefillPlan(f.db, config, NOW, "daily").shouldRefill, false);
		const tomorrow = new Date(NOW.getTime() + 86_400_000);
		const next = autoRefillPlan(f.db, config, tomorrow, "daily");
		assert.equal(next.status.target, 18);
		assert.equal(next.slots, 16);
		assert.equal(next.batch.wordItems, 10);
		assert.equal(next.shouldRefill, true);
		assert.equal(autoRefillPlan(f.db, { ...config, intervalMinutes: 0 }, tomorrow, "daily").shouldRefill, false);
	} finally { f.close(); }
});

test("daily adaptive batches leave enough space to fulfill two grammar slots after five existing words", () => {
	const f = fixture();
	try {
		const cfg = { ...config, adaptiveNewCards: true };
		for (let i = 0; i < 5; i++) f.word();
		const first = autoRefillPlan(f.db, cfg, NOW, "daily");
		assert.equal(first.slots, 12);
		assert.deepEqual(first.batch, { wordItems: 9, clozeItems: 1 });
		for (let i = 0; i < 10; i++) {
			const id = f.word();
			if (i === 9) f.db.prepare("UPDATE items SET type='cloze' WHERE id=?").run(id);
		}
		assert.deepEqual(autoRefillPlan(f.db, cfg, NOW, "daily").batch, { wordItems: 1, clozeItems: 1 });
	} finally { f.close(); }
});

test("daily preparation counts legacy null-kind inventory that the study scheduler will introduce", () => {
	const f = fixture();
	try {
		const id = f.word();
		f.db.prepare("UPDATE items SET introduction_kind=NULL WHERE id=?").run(id);
		const daily = autoRefillPlan(f.db, config, NOW, "daily");
		assert.equal(daily.status.inventory, 1);
		assert.equal(daily.slots, 17);
	} finally { f.close(); }
});
