import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { interruptOrphanedTeachRequests, parseTeachRequest, readTeachReceipt, teachReceipts, writeTeachReceipt, type TeachReceipt } from "../teach-request.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const receipt = (n: number): TeachReceipt => ({ requestId: id(n), phase: "queued", itemsAdded: 0, topic: "日常交流", updatedAt: new Date(n * 1000).toISOString(), ownerId: "owner" });
function database() {
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE stats(key TEXT PRIMARY KEY, value TEXT); CREATE TABLE runtime_clients(client_id TEXT PRIMARY KEY,last_seen TEXT)");
	return db;
}

test("teach request preserves full topic and supports legacy command", () => {
	assert.deepEqual(parseTeachRequest(`--request-id ${id(1)} 雅思基础  日常\n交流`), { requestId: id(1), topic: "雅思基础  日常\n交流" });
	assert.deepEqual(parseTeachRequest(" 普通备课话题 "), { topic: "普通备课话题" });
	for (const text of ["", "--request-id", "--request-id not-a-uuid 话题", `--request-id ${id(1)}`]) assert.throws(() => parseTeachRequest(text), /INVALID_TEACH_REQUEST/);
});

test("teach receipts validate exact success and participate in insertion rollback", () => {
	const db = database();
	try {
		writeTeachReceipt(db, receipt(1));
		assert.throws(() => writeTeachReceipt(db, { ...receipt(1), phase: "succeeded" }), /INVALID_TEACH_RECEIPT/);
		assert.throws(() => writeTeachReceipt(db, { ...receipt(1), phase: "succeeded", itemsAdded: 2, itemIds: [1] }), /INVALID_TEACH_RECEIPT/);
		db.exec("CREATE TABLE cards(id INTEGER PRIMARY KEY); BEGIN IMMEDIATE; INSERT INTO cards(id) VALUES(1)");
		writeTeachReceipt(db, { ...receipt(1), phase: "succeeded", itemsAdded: 1, itemIds: [1] });
		db.exec("ROLLBACK");
		assert.equal(readTeachReceipt(db, id(1))?.phase, "queued");
		assert.equal(db.prepare("SELECT COUNT(*) AS n FROM cards").get()?.n, 0);
		writeTeachReceipt(db, { ...receipt(1), phase: "failed", errorCode: "REQUEST_INTERRUPTED" });
		writeTeachReceipt(db, { ...receipt(1), phase: "generating" });
		assert.equal(readTeachReceipt(db, id(1))?.phase, "failed", "terminal receipt cannot become pending again");
	} finally { db.close(); }
});

test("teach receipt retention preserves pending requests and interrupts only stale owners", () => {
	const db = database();
	try {
		writeTeachReceipt(db, receipt(1));
		for (let n = 2; n <= 103; n++) writeTeachReceipt(db, { ...receipt(n), phase: "failed", errorCode: "TEACH_GENERATION_FAILED" });
		assert.equal(teachReceipts(db).length, 101);
		assert.equal(readTeachReceipt(db, id(1))?.phase, "queued");
		assert.equal(readTeachReceipt(db, id(2)), undefined);
		db.prepare("INSERT INTO runtime_clients VALUES('owner',?)").run(new Date(100_000).toISOString());
		interruptOrphanedTeachRequests(db, 120_000);
		assert.equal(readTeachReceipt(db, id(1))?.phase, "queued");
		interruptOrphanedTeachRequests(db, 131_000);
		assert.equal(readTeachReceipt(db, id(1))?.errorCode, "REQUEST_INTERRUPTED");
	} finally { db.close(); }
});
