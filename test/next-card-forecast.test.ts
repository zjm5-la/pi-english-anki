import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULTS } from "../config.ts";
import { getStat, openDb, setStat } from "../db.ts";
import { buildNextCardForecast, NEXT_CARD_FORECAST_STAT, writeNextCardForecast, type ForecastTiming } from "../next-card-forecast.ts";

const NOW = new Date("2026-09-09T04:00:00.000Z");
const iso = (ms = 0) => new Date(NOW.getTime() + ms).toISOString();
const config = { ...DEFAULTS, adaptiveNewCards: false, dailyNewLimit: 1 };
const timer: ForecastTiming = { workCheckAt: iso(6000), replacementCheckAt: null, localGenerationBusy: false };
function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "anki-forecast-test-"));
	process.env.PI_CODING_AGENT_DIR = dir;
	const db = openDb();
	let seq = 0;
	return {
		db,
		word(shown = 1, due = iso(-1000), kind: string | null = null) {
			return Number(db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown,introduction_kind) VALUES('word',?,'词（名词）',?,?,?,?)")
				.run(`word${++seq}`, iso(), due, shown, kind).lastInsertRowid);
		},
		forecast(timing = timer, cfg = config, now = NOW) { return buildNextCardForecast(db, cfg, timing, now); },
		close() { db.close(); rmSync(dir, { recursive: true, force: true }); },
	};
}
function databaseRows(db: ReturnType<typeof openDb>) {
	return db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(row => {
		const name = String(row.name);
		return { name, rows: db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all() };
	});
}
function queued(db: ReturnType<typeof openDb>, payload: string, fingerprint = "queued-fingerprint") {
	db.prepare("INSERT INTO custom_card_queue(created_at,prompt,fingerprint,payload) VALUES(?,'test',?,?)").run(iso(), fingerprint, payload);
}

test("current-card forecast excludes the whole active item and respects next-card quota", () => {
	const f = fixture();
	try {
		const active = f.word();
		f.db.prepare("UPDATE items SET introduction_kind='planned',introduced_at=? WHERE id=?").run(iso(), active);
		f.db.prepare("UPDATE runtime_state SET active_item_id=?,active_direction='reverse',next_check_at=?").run(active, iso(60000));
		assert.equal(f.forecast().hasReadyAfterCurrent, false, "the current card cannot count itself in either direction");
		const next = f.word(0);
		assert.equal(f.forecast().hasReadyAfterCurrent, false, "a quota-blocked stored card is not ready");
		f.db.prepare("UPDATE items SET introduction_kind='replacement' WHERE id=?").run(next);
		assert.deepEqual(f.forecast(), {
			version: 1, status: "current_card", activeItemId: active, hasReadyAfterCurrent: true, source: "replacement",
			availableAt: null, scheduledAt: null, checkAt: iso(6000), updatedAt: iso(),
		});
		f.db.prepare("UPDATE items SET due_at=? WHERE id=?").run(iso(1), next);
		assert.equal(f.forecast().hasReadyAfterCurrent, false, "rating must not advance a future card");
	} finally { f.close(); }
});

test("countdown requires the real timer and honors due time and pacing independently", () => {
	const f = fixture();
	try {
		const id = f.word(1, iso(3000));
		f.db.prepare("UPDATE runtime_state SET next_check_at=?").run(iso(6000));
		const next = f.forecast();
		assert.equal(next.availableAt, iso(6000));
		assert.equal(next.scheduledAt, iso(6000));
		assert.equal(next.checkAt, iso(6000));
		f.db.prepare("UPDATE items SET due_at=? WHERE id=?").run(iso(120000), id);
		const earlierCheck = f.forecast({ ...timer, workCheckAt: iso(30000) });
		assert.equal(earlierCheck.availableAt, iso(120000));
		assert.equal(earlierCheck.scheduledAt, null, "an earlier check cannot promise a later card's release");
		assert.equal(earlierCheck.checkAt, iso(30000));
		assert.equal(earlierCheck.status, "waiting_due");
		const noTimer = f.forecast({ ...timer, workCheckAt: null });
		assert.equal(noTimer.checkAt, null);
		assert.equal(noTimer.scheduledAt, null, "next_check_at alone is not a scheduled timer");
		const disabled = f.forecast(timer, { ...config, intervalMinutes: 0 });
		assert.equal(disabled.status, "disabled");
		assert.equal(disabled.scheduledAt, null);
		assert.equal(disabled.checkAt, null);
	} finally { f.close(); }
});

test("replacement generation never becomes a promise, but due reviews bypass it", () => {
	const f = fixture();
	try {
		f.word(0);
		setStat(f.db, "pending_replacements", '["word"]');
		const blocked = f.forecast();
		assert.equal(blocked.source, "stored_new");
		assert.equal(blocked.status, "generating");
		assert.equal(blocked.scheduledAt, null);
		assert.equal(f.forecast({ ...timer, localGenerationBusy: true }).scheduledAt, null, "the LLM could finish before the timer and restore replacement-first ordering");
		f.word(1);
		const review = f.forecast();
		assert.equal(review.source, "review");
		assert.equal(review.scheduledAt, iso(6000));
	} finally { f.close(); }
});

test("full quota excludes planned inventory but not reviews or saved replacement cards", () => {
	const f = fixture();
	try {
		const learned = f.word(1, iso(86400000), "planned");
		f.db.prepare("UPDATE items SET introduced_at=?,content_status='quarantined' WHERE id=?").run(iso(), learned);
		const next = f.word(0);
		assert.equal(f.forecast().status, "quota_reached");
		assert.equal(f.forecast().availableAt, null);
		assert.equal(f.forecast().scheduledAt, null);
		f.db.prepare("UPDATE items SET introduction_kind='replacement' WHERE id=?").run(next);
		assert.equal(f.forecast().source, "replacement");
		assert.equal(f.forecast().scheduledAt, iso(6000));
		f.db.prepare("UPDATE items SET shown=1 WHERE id=?").run(next);
		assert.equal(f.forecast().source, "review");
		assert.equal(f.forecast().scheduledAt, iso(6000));
	} finally { f.close(); }
});

test("custom queue can announce a check, never a guaranteed release before its transaction", () => {
	const f = fixture();
	try {
		for (const payload of ['{"type":"word","text":"queue","meaning":"队列（可数名词）"}', 'not-json', '{"type":"word","text":"word1","meaning":"词（名词）"}']) {
			f.db.exec("DELETE FROM custom_card_queue");
			queued(f.db, payload, "deliberately-mismatched-fingerprint");
			const next = f.forecast();
			assert.equal(next.source, "custom_queue");
			assert.equal(next.status, "waiting_check");
			assert.equal(next.availableAt, null);
			assert.equal(next.scheduledAt, null);
			assert.equal(next.checkAt, iso(6000));
		}
	} finally { f.close(); }
});

test("generation and automatic-off empty states have no invented completion times", () => {
	const f = fixture();
	try {
		assert.equal(f.forecast({ ...timer, workCheckAt: null }).status, "empty");
		assert.equal(f.forecast(timer, { ...config, intervalMinutes: 0 }).status, "disabled");
		f.db.prepare("UPDATE runtime_state SET generation_token='test',generation_until=?").run(iso(60000));
		const generating = f.forecast({ ...timer, workCheckAt: null, replacementCheckAt: iso(10000) });
		assert.equal(generating.status, "generating");
		assert.equal(generating.availableAt, null);
		assert.equal(generating.scheduledAt, null);
		assert.equal(generating.checkAt, iso(10000));
	} finally { f.close(); }
});

test("future-day new-card quotas cannot support a guaranteed release", () => {
	const f = fixture();
	try {
		f.word(0);
		const tomorrow = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + 1, 1).toISOString();
		const next = f.forecast({ ...timer, workCheckAt: tomorrow });
		assert.equal(next.source, "stored_new");
		assert.equal(next.scheduledAt, null);
		assert.equal(next.checkAt, tomorrow);
	} finally { f.close(); }
});

test("forecast construction is read-only even when adaptive plan and start date are missing", () => {
	const f = fixture();
	try {
		f.word(0);
		const before = databaseRows(f.db);
		f.forecast(timer, { ...DEFAULTS, adaptiveNewCards: true });
		assert.deepEqual(databaseRows(f.db), before, "no quota plan, adaptive start, learner state, or scheduling row may change");
		f.db.exec("DELETE FROM runtime_state");
		const missing = databaseRows(f.db);
		assert.equal(f.forecast().status, "empty");
		assert.deepEqual(databaseRows(f.db), missing, "a projection must not recreate missing state");
	} finally { f.close(); }
});

test("unchanged forecast polls retain updatedAt and do not write SQLite", () => {
	const f = fixture();
	try {
		f.word(1, iso(3000));
		assert.equal(writeNextCardForecast(f.db, f.forecast()), true);
		const published = getStat(f.db, NEXT_CARD_FORECAST_STAT);
		const changes = f.db.prepare("SELECT total_changes() AS n").get()?.n;
		assert.equal(writeNextCardForecast(f.db, f.forecast(timer, config, new Date(NOW.getTime() + 1000))), false);
		assert.equal(getStat(f.db, NEXT_CARD_FORECAST_STAT), published);
		assert.equal(f.db.prepare("SELECT total_changes() AS n").get()?.n, changes);
		assert.equal(writeNextCardForecast(f.db, f.forecast(timer, config, new Date(NOW.getTime() + 4000))), true, "becoming due is a semantic change");
		assert.equal(JSON.parse(getStat(f.db, NEXT_CARD_FORECAST_STAT)!).status, "ready");
	} finally { f.close(); }
});
