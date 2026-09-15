import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getStat, setStat } from "./db.ts";

export type UndoKind = "good" | "again" | "skip";
export interface StudyUndo { actionId: string; itemId: number; kind: UndoKind; available: boolean }
type Row = Record<string, any>;
type Snapshot = Record<string, Row[]>;
interface Change { table: string; key: Row; before: Row | null; after: Row | null }
interface UndoRecord extends StudyUndo { changes: Change[]; expected: string; generationToken?: string; undone?: boolean }
export interface UndoDraft { before: Snapshot; record: UndoRecord }
export interface UndoResult { requestId: string; actionId: string; itemId: number | null; status: "succeeded" | "rejected"; errorCode?: string; updatedAt: string }
const STAT_KEYS = ["total_reviews", "total_skipped", "total_learned", "streak_days", "last_active_date", "pending_replacements"];
const RUNTIME_COLUMNS = ["id", "active_item_id", "active_kind", "active_direction", "active_version", "active_review_cycle_id", "active_exercise_id", "active_cycle_outcome", "active_retry_count", "active_assistance_level", "next_check_at"];
const TABLES: Record<string, string[]> = {
	items: ["id"], direction_state: ["item_id", "direction"], mastery_state: ["item_id"], attempts: ["id"],
	exercises: ["id"], exercise_senses: ["exercise_id", "lexical_sense_id", "role"],
	stats: ["key"], runtime_state: ["id"],
};
// These rows only guard against concurrent content work. Undo never restores them.
const GUARDS = ["lexical_senses", "lexical_surface_versions", "content_catalog_state", "custom_card_queue", "supporting_materials", "content_reports", "fsrs_corruptions"];
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function initializeStudyUndo(db: DatabaseSync): void {
	db.exec("CREATE TABLE IF NOT EXISTS study_undo_state (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL)");
}
function snapshot(db: DatabaseSync): Snapshot {
	const result: Snapshot = {};
	for (const table of [...Object.keys(TABLES), ...GUARDS]) {
		result[table] = table === "stats"
			? db.prepare(`SELECT key,value FROM stats WHERE key IN (${STAT_KEYS.map(() => "?").join(",")}) ORDER BY key`).all(...STAT_KEYS)
			: table === "runtime_state"
				? db.prepare(`SELECT ${RUNTIME_COLUMNS.join(",")} FROM runtime_state WHERE id=1`).all()
				: db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
	}
	return result;
}
function readRecord(db: DatabaseSync): UndoRecord | undefined {
	const raw = db.prepare("SELECT payload FROM study_undo_state WHERE id=1").get()?.payload;
	try { return raw ? JSON.parse(String(raw)) : undefined; } catch { return undefined; }
}
function save(db: DatabaseSync, record: UndoRecord): void {
	db.prepare("INSERT INTO study_undo_state(id,payload) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload").run(JSON.stringify(record));
	const visible: StudyUndo = { actionId: record.actionId, itemId: record.itemId, kind: record.kind, available: record.available };
	const raw = JSON.stringify(visible);
	if (getStat(db, "study_undo") !== raw) setStat(db, "study_undo", raw);
}
function changes(before: Snapshot, after: Snapshot): Change[] {
	const result: Change[] = [];
	for (const [table, keys] of Object.entries(TABLES)) {
		const key = (row: Row) => Object.fromEntries(keys.map(column => [column, row[column]]));
		const left = new Map(before[table].map(row => [JSON.stringify(key(row)), row]));
		const right = new Map(after[table].map(row => [JSON.stringify(key(row)), row]));
		for (const id of new Set([...left.keys(), ...right.keys()])) {
			const a = left.get(id) ?? null, b = right.get(id) ?? null;
			if (!same(a, b)) result.push({ table, key: JSON.parse(id), before: a, after: b });
		}
	}
	return result;
}

/** Call inside the same write transaction as the manual action. */
export function beginStudyUndo(db: DatabaseSync, itemId: number, kind: UndoKind): UndoDraft {
	return { before: snapshot(db), record: { actionId: randomUUID(), itemId, kind, available: true, expected: "", changes: [] } };
}
export function finishStudyUndo(db: DatabaseSync, draft: UndoDraft): void {
	const after = snapshot(db);
	draft.record.changes = changes(draft.before, after);
	draft.record.expected = digest(after);
	save(db, draft.record);
	setStat(db, `study_undo_action:${draft.record.actionId}`, JSON.stringify({ itemId: draft.record.itemId, kind: draft.record.kind }));
	db.prepare("DELETE FROM stats WHERE key LIKE 'study_undo_action:%' AND key NOT IN (SELECT key FROM stats WHERE key LIKE 'study_undo_action:%' ORDER BY rowid DESC LIMIT 100)").run();
}
export function invalidateStudyUndo(db: DatabaseSync): void {
	const own = !db.isTransaction;
	if (own) db.exec("BEGIN IMMEDIATE");
	try {
		const record = readRecord(db);
		if (record?.available) { record.available = false; save(db, record); }
		if (own) db.exec("COMMIT");
	} catch (error) { if (own) db.exec("ROLLBACK"); throw error; }
}
export function readStudyUndo(db: DatabaseSync): StudyUndo | undefined {
	const record = readRecord(db);
	return record && { actionId: record.actionId, itemId: record.itemId, kind: record.kind, available: record.available };
}
/** Only the untouched automatic claim/render following an action may extend its patch. */
export function beginUndoContinuation(db: DatabaseSync): UndoDraft | undefined {
	const record = readRecord(db);
	if (!record?.available) return;
	const before = snapshot(db);
	if (digest(before) !== record.expected) { record.available = false; save(db, record); return; }
	return { before, record };
}
export function finishUndoContinuation(db: DatabaseSync, draft: UndoDraft | undefined): void {
	if (!draft) return;
	const after = snapshot(db);
	for (const change of changes(draft.before, after)) {
		const existing = draft.record.changes.find(entry => entry.table === change.table && same(entry.key, change.key));
		if (existing) existing.after = change.after;
		else draft.record.changes.push(change);
	}
	draft.record.expected = digest(after);
	save(db, draft.record);
}
export function withUndoContinuation<T>(db: DatabaseSync, work: () => T): T {
	const ownTransaction = !db.isTransaction;
	if (ownTransaction) db.exec("BEGIN IMMEDIATE");
	try {
		const draft = beginUndoContinuation(db);
		const result = work();
		finishUndoContinuation(db, draft);
		if (ownTransaction) db.exec("COMMIT");
		return result;
	} catch (error) { if (ownTransaction) db.exec("ROLLBACK"); throw error; }
}
/** An old asynchronous skip cannot adjust the newer action's pacing or undo patch. */
export function continueStudyUndoAction(db: DatabaseSync, actionId: string, work: () => void): boolean {
	db.exec("BEGIN IMMEDIATE");
	try {
		const draft = beginUndoContinuation(db);
		if (!draft || draft.record.actionId !== actionId) { db.exec("COMMIT"); return false; }
		work(); finishUndoContinuation(db, draft);
		db.exec("COMMIT");
		return true;
	} catch (error) { db.exec("ROLLBACK"); throw error; }
}
export function refreshStudyUndo(db: DatabaseSync): void {
	if (db.isTransaction) return;
	db.exec("BEGIN IMMEDIATE");
	try { beginUndoContinuation(db); db.exec("COMMIT"); }
	catch (error) { db.exec("ROLLBACK"); throw error; }
}
/** Bind only refill work caused by this skip, never an older queued replacement. */
export function bindUndoReplacement(db: DatabaseSync, sourceItemId: number, token: string): void {
	db.exec("BEGIN IMMEDIATE");
	try {
		const draft = beginUndoContinuation(db);
		const record = draft?.record;
		const queue = record?.changes.find(change => change.table === "stats" && change.key.key === "pending_replacements");
		if (record?.kind === "skip" && record.itemId === sourceItemId && queue && (!queue.before || queue.before.value === "[]")) {
			record.generationToken = token;
			save(db, record);
		}
		db.exec("COMMIT");
	} catch (error) { db.exec("ROLLBACK"); throw error; }
}
export function wasStudyUndone(db: DatabaseSync, actionId: string | undefined): boolean {
	const record = readRecord(db);
	if (!actionId) return false;
	const action = getStat(db, `study_undo_action:${actionId}`);
	return Boolean(record?.actionId === actionId && record.undone || action && JSON.parse(action).undone);
}
function restore(db: DatabaseSync, change: Change, activeVersion: number): void {
	const keys = TABLES[change.table];
	if (!keys || !same(Object.keys(change.key), keys)) throw new Error("UNDO_INVALID_STATE");
	const where = keys.map(key => `${key}=?`).join(" AND ");
	const args = keys.map(key => change.key[key]);
	if (!change.before) { db.prepare(`DELETE FROM ${change.table} WHERE ${where}`).run(...args); return; }
	const allowed = new Set(db.prepare(`PRAGMA table_info(${change.table})`).all().map(row => String(row.name)));
	const columns = Object.keys(change.before);
	if (columns.some(column => !allowed.has(column))) throw new Error("UNDO_INVALID_STATE");
	const row = { ...change.before };
	if (change.table === "runtime_state") row.active_version = activeVersion + 1;
	if (change.after) db.prepare(`UPDATE ${change.table} SET ${columns.map(column => `${column}=?`).join(",")} WHERE ${where}`).run(...columns.map(column => row[column]), ...args);
	else db.prepare(`INSERT INTO ${change.table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`).run(...columns.map(column => row[column]));
}
/** Result receipt and row-level restoration commit together. No whole-deck rollback. */
export function undoStudyAction(db: DatabaseSync, actionId: string, requestId: string): UndoResult & { applied: boolean } {
	const resultKey = `study_undo_result:${requestId}`;
	db.exec("BEGIN IMMEDIATE");
	try {
		const existing = getStat(db, resultKey);
		if (existing) {
			const prior: UndoResult = JSON.parse(existing);
			db.exec("ROLLBACK");
			return prior.actionId === actionId ? { ...prior, applied: false } : { requestId, actionId, itemId: null, status: "rejected", errorCode: "UNDO_REQUEST_CONFLICT", updatedAt: new Date().toISOString(), applied: false };
		}
		const record = readRecord(db);
		const action = getStat(db, `study_undo_action:${actionId}`);
		const itemId = action ? JSON.parse(action).itemId : record?.actionId === actionId ? record.itemId : null;
		const result: UndoResult = { requestId, actionId, itemId, status: "rejected", errorCode: "UNDO_UNAVAILABLE", updatedAt: new Date().toISOString() };
		if (record?.available && record.actionId === actionId && digest(snapshot(db)) === record.expected) {
			const version = Number(db.prepare("SELECT active_version FROM runtime_state WHERE id=1").get()?.active_version ?? 0);
			for (const change of [...record.changes].reverse()) restore(db, change, version);
			if (record.generationToken) db.prepare("UPDATE runtime_state SET generation_token=NULL,generation_until=NULL WHERE id=1 AND generation_token=?").run(record.generationToken);
			record.available = false; record.undone = true; save(db, record);
			setStat(db, `study_undo_action:${actionId}`, JSON.stringify({ itemId: record.itemId, kind: record.kind, undone: true }));
			result.status = "succeeded"; delete result.errorCode;
		} else if (record?.available && record.actionId === actionId) { record.available = false; save(db, record); }
		setStat(db, resultKey, JSON.stringify(result));
		db.prepare("DELETE FROM stats WHERE key LIKE 'study_undo_result:%' AND key NOT IN (SELECT key FROM stats WHERE key LIKE 'study_undo_result:%' ORDER BY rowid DESC LIMIT 50)").run();
		db.exec("COMMIT");
		return { ...result, applied: result.status === "succeeded" };
	} catch (error) { db.exec("ROLLBACK"); throw error; }
}
