import type { DatabaseSync } from "node:sqlite";

export interface TeachRequest { requestId?: string; topic: string }
export type TeachPhase = "queued" | "generating" | "checking" | "revising" | "saving" | "succeeded" | "failed";
export interface TeachReceipt {
	requestId: string;
	phase: TeachPhase;
	itemsAdded: number;
	topic: string;
	updatedAt: string;
	errorCode?: string;
	itemIds?: number[];
	/** Internal ownership, ignored by the app's progress contract. */
	ownerId?: string;
}
const PREFIX = "teach_request:";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const terminal = (receipt: TeachReceipt) => receipt.phase === "succeeded" || receipt.phase === "failed";

export function parseTeachRequest(args: string): TeachRequest {
	const text = args.trim();
	if (!text) throw new Error("INVALID_TEACH_REQUEST");
	if (!text.startsWith("--request-id")) return { topic: text };
	const match = /^--request-id\s+(\S+)\s+([\s\S]+)$/.exec(text);
	if (!match || !UUID.test(match[1]) || !match[2].trim()) throw new Error("INVALID_TEACH_REQUEST");
	return { requestId: match[1], topic: match[2].trim() };
}

export function readTeachReceipt(db: DatabaseSync, requestId: string): TeachReceipt | undefined {
	const row = db.prepare("SELECT value FROM stats WHERE key = ?").get(PREFIX + requestId) as { value: string } | undefined;
	if (!row) return undefined;
	try {
		const receipt = JSON.parse(row.value) as TeachReceipt;
		return receipt.requestId === requestId ? receipt : undefined;
	} catch { return undefined; }
}

export function teachReceipts(db: DatabaseSync): TeachReceipt[] {
	return (db.prepare("SELECT value FROM stats WHERE key LIKE 'teach_request:%'").all() as { value: string }[])
		.flatMap(row => { try { return [JSON.parse(row.value) as TeachReceipt]; } catch { return []; } });
}

export function writeTeachReceipt(db: DatabaseSync, receipt: TeachReceipt): void {
	if (!UUID.test(receipt.requestId) || !Number.isInteger(receipt.itemsAdded) || receipt.itemsAdded < 0) throw new Error("INVALID_TEACH_RECEIPT");
	if (receipt.phase === "succeeded" && (receipt.itemsAdded < 1 || receipt.itemIds?.length !== receipt.itemsAdded || receipt.itemIds.some(id => !Number.isInteger(id) || id <= 0))) throw new Error("INVALID_TEACH_RECEIPT");
	if (receipt.phase === "failed" && !/^[A-Z][A-Z0-9_]{0,79}$/.test(receipt.errorCode ?? "")) throw new Error("INVALID_TEACH_RECEIPT");
	const current = readTeachReceipt(db, receipt.requestId);
	if (current && terminal(current)) return;
	db.prepare("INSERT INTO stats(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
		.run(PREFIX + receipt.requestId, JSON.stringify(receipt));
	// Pending work is never evicted; retain a bounded history for duplicate delivery.
	const old = teachReceipts(db).filter(terminal).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(100);
	for (const entry of old) db.prepare("DELETE FROM stats WHERE key = ?").run(PREFIX + entry.requestId);
}

export function interruptOrphanedTeachRequests(db: DatabaseSync, now = Date.now()): void {
	for (const receipt of teachReceipts(db)) {
		if (terminal(receipt) || !receipt.ownerId) continue;
		const owner = db.prepare("SELECT last_seen FROM runtime_clients WHERE client_id = ?").get(receipt.ownerId) as { last_seen: string } | undefined;
		if (owner && now - Date.parse(owner.last_seen) < 30_000) continue;
		writeTeachReceipt(db, { ...receipt, phase: "failed", itemsAdded: 0, errorCode: "REQUEST_INTERRUPTED", updatedAt: new Date(now).toISOString() });
	}
}
