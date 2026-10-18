// card-image: youdao illustrated-dictionary lookup and DB backfill with a
// negative cache. Network is fully mocked — no test ever hits youdao.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "anki-card-image-"));

const { backfillCardImages, resolveCardImageUrl } = await import("../card-image.ts");
const { openDb } = await import("../db.ts");
type FetchLike = Parameters<typeof resolveCardImageUrl>[1];

function jsonResponse(body: unknown): { ok: boolean; status: number; text(): Promise<string> } {
	return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}

test("resolveCardImageUrl extracts a clean https URL from pic_dict", async () => {
	const fetchMock: FetchLike = async () =>
		jsonResponse({ pic_dict: { pic: [{ image: "https://cdn.example.net/kettle.png?" }] } });
	assert.equal(await resolveCardImageUrl("Kettle ", fetchMock), "https://cdn.example.net/kettle.png");
});

test("resolveCardImageUrl returns undefined without a picture or on network errors", async () => {
	const noPic: FetchLike = async () => jsonResponse({ ec: {} });
	assert.equal(await resolveCardImageUrl("surge", noPic), undefined);
	const httpError: FetchLike = async () => ({ ok: false, status: 503, text: async () => "" });
	assert.equal(await resolveCardImageUrl("kettle", httpError), undefined);
	const throws: FetchLike = async () => {
		throw new Error("offline");
	};
	assert.equal(await resolveCardImageUrl("kettle", throws), undefined);
	const httpUrl: FetchLike = async () =>
		jsonResponse({ pic_dict: { pic: [{ image: "http://insecure.example.net/a.png" }] } });
	assert.equal(await resolveCardImageUrl("kettle", httpUrl), undefined, "only https links are kept");
});

test("backfillCardImages fills URLs, caches no-image as empty string, and skips checked rows", async () => {
	const db = openDb();
	try {
		const now = new Date().toISOString();
		const add = (text: string) =>
			db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown) VALUES('word',?,?,?, ?,1)")
				.run(text, `${text} 释义`, now, now);
		add("kettle");
		add("surge");
		add("wardrobe");
		const pictures = new Map<string, string>([
			["kettle", "https://cdn.example.net/kettle.png"],
			["wardrobe", "https://cdn.example.net/wardrobe.png"],
		]);
		const fetchMock: FetchLike = async (url) => {
			const word = decodeURIComponent(url.split("q=")[1] ?? "");
			const image = pictures.get(word);
			return jsonResponse(image ? { pic_dict: { pic: [{ image }] } } : {});
		};
		const first = await backfillCardImages(db, { limit: 10, fetchImpl: fetchMock });
		assert.deepEqual(first, { checked: 3, resolved: 2, noImage: 1 });
		const urls = db.prepare("SELECT text, image_url FROM items ORDER BY id").all() as { text: string; image_url: string }[];
		assert.equal(urls[0].image_url, "https://cdn.example.net/kettle.png");
		assert.equal(urls[1].image_url, "", "no-picture rows are negatively cached");
		assert.equal(urls[2].image_url, "https://cdn.example.net/wardrobe.png");
		const again = await backfillCardImages(db, { limit: 10, fetchImpl: fetchMock });
		assert.deepEqual(again, { checked: 0, resolved: 0, noImage: 0 }, "checked rows are never re-queried");
	} finally {
		db.close();
	}
});

test("backfillCardImages respects the limit and only touches word/phrase rows", async () => {
	const db = openDb();
	try {
		const now = new Date().toISOString();
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown) VALUES('sentence','A full sentence.','整句',?, ?,1)")
			.run(now, now);
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown) VALUES('word','kettle','电热水壶',?, ?,1)")
			.run(now, now);
		db.prepare("INSERT INTO items(type,text,meaning,learned_at,due_at,shown) VALUES('word','wardrobe','衣柜',?, ?,1)")
			.run(now, now);
		let calls = 0;
		const fetchMock: FetchLike = async () => {
			calls += 1;
			return jsonResponse({});
		};
		assert.deepEqual(await backfillCardImages(db, { limit: 1, fetchImpl: fetchMock }), { checked: 1, resolved: 0, noImage: 1 });
		assert.equal(calls, 1);
		const left = db.prepare("SELECT COUNT(*) AS n FROM items WHERE image_url IS NULL").get() as { n: number };
		assert.equal(left.n, 2, "the sentence row keeps NULL forever");
	} finally {
		db.close();
	}
});
