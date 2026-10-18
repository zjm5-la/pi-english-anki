// card-image.ts — concept-gap image lookup for vocabulary cards.
//
// Concrete nouns whose L1 gloss does not convey the object (a British
// electric kettle is not the 烧水壶 you pictured) need a picture, not a
// longer definition. The youdao illustrated dictionary (pic_dict) covers
// such words well, its CDN is reachable from CN networks without a proxy,
// and abstract words simply return nothing. Only the URL is stored — no
// image bytes ever land locally.

import type { DatabaseSync } from "node:sqlite";

const YOUDAO_JSONAPI = "https://dict.youdao.com/jsonapi?q=";
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

export type FetchLike = (
	url: string,
	init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** Resolve an illustrated-dictionary image URL for one card text, if any. */
export async function resolveCardImageUrl(
	text: string,
	fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<string | undefined> {
	const word = text.trim().toLowerCase();
	if (!word) return undefined;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 8000);
	try {
		const response = await fetchImpl(`${YOUDAO_JSONAPI}${encodeURIComponent(word)}`, {
			headers: { "User-Agent": USER_AGENT },
			signal: controller.signal,
		});
		if (!response.ok) return undefined;
		const payload = JSON.parse(await response.text()) as {
			pic_dict?: { pic?: { image?: unknown }[] };
		};
		const first = payload.pic_dict?.pic?.[0]?.image;
		if (typeof first !== "string") return undefined;
		const url = first.split("?")[0];
		return url.startsWith("https://") ? url : undefined;
	} catch {
		return undefined; // offline or hiccup: stays NULL for a later retry
	} finally {
		clearTimeout(timer);
	}
}

export interface BackfillSummary {
	checked: number;
	resolved: number;
	noImage: number;
}

/** Fill items.image_url for word/phrase cards: NULL = unchecked, '' = checked
 * and the source has no picture (negative cache so idle ticks never
 * re-query), a URL = concept image. The guarded UPDATE keeps concurrent
 * sessions from racing one row. */
export async function backfillCardImages(
	db: DatabaseSync,
	options: { limit?: number; fetchImpl?: FetchLike; delayMs?: number } = {},
): Promise<BackfillSummary> {
	const limit = Math.max(0, Math.floor(options.limit ?? 50));
	const rows = limit > 0
		? db.prepare(
				`SELECT id, text FROM items
				 WHERE type IN ('word','phrase') AND image_url IS NULL AND legacy_duplicate_of IS NULL
				 ORDER BY id LIMIT ?`,
			).all(limit) as { id: number; text: string }[]
		: [];
	const update = db.prepare("UPDATE items SET image_url = ? WHERE id = ? AND image_url IS NULL");
	const summary = { checked: 0, resolved: 0, noImage: 0 };
	for (const row of rows) {
		const url = await resolveCardImageUrl(row.text, options.fetchImpl);
		update.run(url ?? "", row.id);
		summary.checked += 1;
		if (url) summary.resolved += 1;
		else summary.noImage += 1;
		if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
	}
	return summary;
}
