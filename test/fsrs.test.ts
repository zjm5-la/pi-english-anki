import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "anki-fsrs-test-"));
const { insertItem, migrateNightDueTimes, openDb } = await import("../db.ts");
const { MORNING_DUE_HOUR, NIGHT_DUE_END_HOUR, scheduleNext, shiftNightDue } = await import("../fsrs.ts");
const { Rating } = await import("fsrs.js");

test("shiftNightDue slides dead-of-night dues to the morning slot", () => {
	const night = new Date(2026, 9, 8, 0, 5, 30);
	const shifted = shiftNightDue(night);
	assert.equal(shifted.getHours(), MORNING_DUE_HOUR);
	assert.equal(shifted.getMinutes(), 0);
	assert.equal(shifted.getDate(), night.getDate(), "stays on the same calendar day");
	assert.equal(shiftNightDue(new Date(2026, 9, 8, 5, 59)).getHours(), MORNING_DUE_HOUR);
	const boundary = new Date(2026, 9, 8, NIGHT_DUE_END_HOUR, 0);
	assert.equal(shiftNightDue(boundary).getTime(), boundary.getTime(), "06:00 boundary stays unchanged");
	const evening = new Date(2026, 9, 8, 23, 30);
	assert.equal(shiftNightDue(evening).getTime(), evening.getTime(), "evening dues stay unchanged");
});

test("scheduleNext never leaves a due inside the night window", () => {
	for (const now of [new Date(2026, 9, 7, 23, 58, 30), new Date(2026, 9, 8, 0, 10), new Date(2026, 9, 8, 14, 0)]) {
		const result = scheduleNext(null, now, Rating.Good);
		assert.ok(!("corrupt" in result));
		const hour = new Date(result.due).getHours();
		assert.ok(hour >= NIGHT_DUE_END_HOUR, `due hour ${hour} from ${now.toISOString()}`);
	}
});

test("night migration shifts stored dues, keeps the direction MIN invariant, and is idempotent", () => {
	const db = openDb();
	const id = insertItem(db, "word", "midnightword", null, "半夜（名词）", "A midnight word.", "半夜的词。", new Date());
	const night = new Date(2026, 9, 9, 0, 5, 0);
	const morning = new Date(2026, 9, 9, 7, 0, 0);
	db.prepare("UPDATE items SET due_at = ? WHERE id = ?").run(night.toISOString(), id);
	db.prepare(
		"INSERT INTO direction_state (item_id, direction, fsrs_state, due_at, updated_at) VALUES (?, 'forward', '', ?, ?), (?, 'reverse', '', ?, ?)",
	).run(id, night.toISOString(), night.toISOString(), id, morning.toISOString(), night.toISOString());
	migrateNightDueTimes(db);
	const expectForward = new Date(2026, 9, 9, MORNING_DUE_HOUR, 0, 0).toISOString();
	const forward = db.prepare("SELECT due_at FROM direction_state WHERE item_id = ? AND direction = 'forward'").get(id)!;
	const reverse = db.prepare("SELECT due_at FROM direction_state WHERE item_id = ? AND direction = 'reverse'").get(id)!;
	const item = db.prepare("SELECT due_at FROM items WHERE id = ?").get(id)!;
	assert.equal((forward as { due_at: string }).due_at, expectForward);
	assert.equal((reverse as { due_at: string }).due_at, morning.toISOString(), "daytime dues stay unchanged");
	assert.equal((item as { due_at: string }).due_at, morning.toISOString(), "items.due_at recomputed as MIN over directions");
	migrateNightDueTimes(db);
	assert.deepEqual(db.prepare("SELECT due_at FROM items WHERE id = ?").get(id), item, "second run is a no-op");
});
