import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "anki-fsrs-test-"));
const { insertItem, migrateNightDueTimes, openDb } = await import("../db.ts");
const { MORNING_DUE_HOUR, EVENING_CUTOFF_HOUR, scheduleNext, shiftNightDue } = await import("../fsrs.ts");
const { Rating } = await import("fsrs.js");

test("shiftNightDue keeps dues inside the 05:00–22:00 study-day window", () => {
	const night = new Date(2026, 9, 8, 0, 5, 30);
	const shifted = shiftNightDue(night);
	assert.equal(shifted.getHours(), MORNING_DUE_HOUR);
	assert.equal(shifted.getMinutes(), 0);
	assert.equal(shifted.getDate(), night.getDate(), "pre-dawn stays on the same calendar day");
	assert.equal(shiftNightDue(new Date(2026, 9, 8, 4, 59)).getHours(), MORNING_DUE_HOUR);
	const openBoundary = new Date(2026, 9, 8, MORNING_DUE_HOUR, 0);
	assert.equal(shiftNightDue(openBoundary).getTime(), openBoundary.getTime(), "05:00 boundary stays unchanged");
	const lastSlot = new Date(2026, 9, 8, EVENING_CUTOFF_HOUR - 1, 59);
	assert.equal(shiftNightDue(lastSlot).getTime(), lastSlot.getTime(), "21:59 stays unchanged");
	const lateEvening = new Date(2026, 9, 8, 23, 30);
	const nextMorning = shiftNightDue(lateEvening);
	assert.equal(nextMorning.getHours(), MORNING_DUE_HOUR);
	assert.equal(nextMorning.getDate(), lateEvening.getDate() + 1, "post-cutoff dues belong to tomorrow");
	const cutoff = new Date(2026, 9, 8, EVENING_CUTOFF_HOUR, 0);
	const afterCutoff = shiftNightDue(cutoff);
	assert.equal(afterCutoff.getDate(), cutoff.getDate() + 1, "the 22:00 cutoff itself rolls to tomorrow");
});

test("scheduleNext never leaves a due outside the study-day window", () => {
	for (const now of [new Date(2026, 9, 7, 23, 58, 30), new Date(2026, 9, 8, 0, 10), new Date(2026, 9, 8, 14, 0)]) {
		const result = scheduleNext(null, now, Rating.Good);
		assert.ok(!("corrupt" in result));
		const hour = new Date(result.due).getHours();
		assert.ok(hour >= MORNING_DUE_HOUR && hour < EVENING_CUTOFF_HOUR, `due hour ${hour} from ${now.toISOString()}`);
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
	assert.equal((item as { due_at: string }).due_at, expectForward, "items.due_at recomputed as MIN over directions");
	migrateNightDueTimes(db);
	assert.deepEqual(db.prepare("SELECT due_at FROM items WHERE id = ?").get(id), item, "second run is a no-op");
});
