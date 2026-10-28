// lexical-band.ts — read-only CEFR / frequency-band lookup and vocabulary-size
// stratification. Labels are computed at analysis time from local word lists
// (Oxford 3000/5000 CEFR TSVs + a COCA rank list under dictionaries/, override
// with KAOMOJI_WORDLISTS_DIR) instead of being stored per item: every card,
// old and new, is scored by the same deterministic function, and upgrading a
// list immediately re-scores the full learning history.
//
// Science notes: the per-band known-rate extrapolation follows the Vocabulary
// Levels Test tradition — treat each taught item as one sample from its band,
// estimate the band's known fraction, multiply by the band's word-family
// total. The taught sample is frontier-biased (the tutor picks words the
// learner does not yet know), so low bands underestimate and the frontier
// band is honest; report both the extrapolation and the demonstrated counts.

import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";

export type CefrLevel = "A1" | "A2" | "B1" | "B2" | "C1" | "C2";
export const CEFR_LEVELS: readonly CefrLevel[] = ["A1", "A2", "B1", "B2", "C1", "C2"];

/** Approximate receptive word-family totals per CEFR band (Cambridge English
 * Profile style anchors, cumulative ~700/1800/3000/4500/8000/13000). */
export const CEFR_BAND_FAMILIES: Record<CefrLevel, number> = {
	A1: 700, A2: 1100, B1: 1200, B2: 1500, C1: 3500, C2: 5000,
};

const OXFORD_FILES = ["oxford-cefr.tsv", "oxford5000-cefr.tsv"];
const COCA_FILE = "coca20000.txt";

export interface Wordlists {
	/** normalized word → CEFR level (highest level wins across files). */
	cefr: Map<string, CefrLevel>;
	/** normalized word → its lowest CEFR level across files, multi-level rows ("A1, B2") and
	 * "a, an" headwords included: when the word's first sense is taught. */
	cefrLowest: Map<string, CefrLevel>;
	/** normalized word → COCA rank (1-based, first occurrence wins). */
	cocaRank: Map<string, number>;
}

let cache: { dir: string; lists: Wordlists } | undefined;

export function wordlistDir(): string {
	return process.env.KAOMOJI_WORDLISTS_DIR
		?? join(dirname(fileURLToPath(import.meta.url)), "dictionaries");
}

export function normalizeWord(text: string): string {
	return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Load (and memoize per directory) the word lists; missing files degrade to
 * empty maps so analysis stays available, just unannotated. */
export function loadWordlists(dir = wordlistDir()): Wordlists {
	if (cache?.dir === dir) return cache.lists;
	const cefr = new Map<string, CefrLevel>();
	const cefrLowest = new Map<string, CefrLevel>();
	for (const file of OXFORD_FILES) {
		const path = join(dir, file);
		if (!existsSync(path)) continue;
		const lines = readFileSync(path, "utf-8").split(/\r?\n/);
		for (const line of lines.slice(1)) {
			const cells = line.split("\t");
			const levels = ((cells[4] ?? "").match(/\b[ABC][12]\b/g) ?? []) as CefrLevel[];
			const lowest = levels.sort((a, b) => CEFR_LEVELS.indexOf(a) - CEFR_LEVELS.indexOf(b))[0];
			for (const headword of (cells[0] ?? "").split(",")) {
				const key = normalizeWord(headword);
				const previous = cefrLowest.get(key);
				if (key && lowest && (!previous || CEFR_LEVELS.indexOf(lowest) < CEFR_LEVELS.indexOf(previous))) cefrLowest.set(key, lowest);
			}
			const word = normalizeWord(cells[0] ?? "");
			const level = (cells[4] ?? "").trim() as CefrLevel;
			if (!word || !CEFR_LEVELS.includes(level)) continue;
			const previous = cefr.get(word);
			if (!previous || CEFR_LEVELS.indexOf(level) > CEFR_LEVELS.indexOf(previous)) cefr.set(word, level);
		}
	}
	const cocaRank = new Map<string, number>();
	const cocaPath = join(dir, COCA_FILE);
	if (existsSync(cocaPath)) {
		let rank = 0;
		for (const line of readFileSync(cocaPath, "utf-8").split(/\r?\n/)) {
			const word = normalizeWord(line);
			if (!word) continue;
			rank += 1;
			if (!cocaRank.has(word)) cocaRank.set(word, rank);
		}
	}
	cache = { dir, lists: { cefr, cefrLowest, cocaRank } };
	return cache.lists;
}

/** Crude inflection stripping for single-token misses; taught cards are mostly
 * base lemmas, so this only needs to catch occasional surface forms. */
function lemmaVariants(word: string): string[] {
	const out: string[] = [];
	const push = (variant: string) => {
		if (variant.length >= 2 && variant !== word && !out.includes(variant)) out.push(variant);
	};
	if (word.endsWith("ies") && word.length > 4) push(`${word.slice(0, -3)}y`);
	if (word.endsWith("es") && word.length > 3) push(word.slice(0, -2));
	if (word.endsWith("s") && !word.endsWith("ss") && word.length > 3) push(word.slice(0, -1));
	for (const suffix of ["ing", "ed"]) {
		if (!word.endsWith(suffix) || word.length <= suffix.length + 2) continue;
		const stem = word.slice(0, -suffix.length);
		push(stem);
		push(`${stem}e`);
		if (/(.)\1$/.test(stem)) push(stem.slice(0, -1));
	}
	return out;
}

export interface WordBands {
	cefr?: CefrLevel;
	/** COCA band bucket, e.g. "1k" for ranks 1–1000. */
	band?: string;
}

/** Deterministic label for one card's text (word, phrase, or inflected form). */
export function lookupBands(text: string, lists: Wordlists = loadWordlists()): WordBands {
	const word = normalizeWord(text);
	if (!word) return {};
	const viaVariants = (table: Map<string, unknown>): unknown | undefined => {
		if (word.includes(" ")) return undefined;
		for (const variant of lemmaVariants(word)) {
			const hit = table.get(variant);
			if (hit !== undefined) return hit;
		}
		return undefined;
	};
	const cefr = lists.cefr.get(word) ?? viaVariants(lists.cefr) as CefrLevel | undefined;
	const rank = lists.cocaRank.get(word) ?? viaVariants(lists.cocaRank) as number | undefined;
	return { cefr, band: rank ? `${Math.ceil(rank / 1000)}k` : undefined };
}

/**
 * Screening order: log-odds that the learner already spells this card from its
 * Chinese cue. Logistic fit on 1,038 random-order screening verdicts
 * (2026-10, 10-fold CV AUC 0.82 vs 0.75–0.77 for any single feature): common,
 * low-CEFR, short single words pass most. Unlisted words fall back to a
 * mid-band CEFR guess and rank 15000.
 */
export function screeningEase(text: string, lists: Wordlists = loadWordlists()): number {
	const word = normalizeWord(text);
	const { cefr } = lookupBands(word, lists);
	const rank = cocaRankOf(word, lists);
	const level = cefr ? CEFR_LEVELS.indexOf(cefr) : 2.5;
	return 3.611 - 0.227 * Math.log(rank ?? 15000) - 0.503 * level + (cefr ? 0 : 0.694)
		- 0.306 * word.length - (word.includes(" ") ? 0.513 : 0);
}

function cocaRankOf(word: string, lists: Wordlists): number | undefined {
	return lists.cocaRank.get(word)
		?? (word.includes(" ") ? undefined : lemmaVariants(word).map((v) => lists.cocaRank.get(v)).find((r) => r !== undefined));
}

/** COCA rank ceilings that stand in for a CEFR level when a word is unlisted (A1…B2; beyond = C1). */
const RANK_LEVEL_CEILINGS = [1000, 2000, 3500, 6000];
const UNRANKED = 49_999;

/**
 * New-card study order, ascending: CEFR level first (A1 → C1), then COCA
 * frequency within the level; Oxford-listed words precede unlisted words
 * whose level is inferred from frequency. An unlisted phrase takes its
 * hardest word's position.
 */
export function studyOrder(text: string, lists: Wordlists = loadWordlists()): number {
	const word = normalizeWord(text);
	const cefr = lists.cefrLowest.get(word)
		?? (word.includes(" ") ? undefined : lemmaVariants(word).map((v) => lists.cefrLowest.get(v)).find((l) => l !== undefined));
	const rank = cocaRankOf(word, lists);
	if (!cefr && rank === undefined && word.includes(" ")) {
		return Math.max(...word.split(" ").map((part) => studyOrder(part, lists)));
	}
	const level = cefr
		? CEFR_LEVELS.indexOf(cefr)
		: rank === undefined ? RANK_LEVEL_CEILINGS.length : RANK_LEVEL_CEILINGS.filter((ceiling) => rank >= ceiling).length;
	return level * 100_000 + (cefr ? 0 : 50_000) + Math.min(rank ?? UNRANKED, UNRANKED);
}

// -- Stratified estimation --------------------------------------------------

export interface BandSample {
	key: string;
	taught: number;
	known: number;
	solid: number;
}

export interface AxisEstimate {
	/** Bands in report order; only bands with at least one taught card. */
	bands: BandSample[];
	/** Extrapolated receptive word families (point estimate). */
	families: number;
	low: number;
	high: number;
	/** Bands that actually contributed samples. */
	sampled: number;
}

export function cocaBandSize(key: string): number {
	return /^([0-9]+)k$/.test(key) ? 1000 : 0;
}

/** Wilson 95% interval; degenerates to [0,1] without samples. */
function wilson(known: number, taught: number): { low: number; high: number } {
	if (taught === 0) return { low: 0, high: 1 };
	const z = 1.96;
	const p = known / taught;
	const denom = 1 + (z * z) / taught;
	const center = (p + (z * z) / (2 * taught)) / denom;
	const half = (z * Math.sqrt((p * (1 - p)) / taught + (z * z) / (4 * taught * taught))) / denom;
	return { low: Math.max(0, center - half), high: Math.min(1, center + half) };
}

/**
 * Per-band extrapolation with a frontier cut-off. Bands at or below the
 * frontier index use the classic VLT rate estimate (inherit the nearest
 * lower adequately-sampled band; nothing is assumed above the highest
 * sampled band within the frontier). Bands beyond the frontier are
 * frontier-biased samples — the tutor picks words the learner does not yet
 * know and then teaches them to mastery — so they contribute their
 * demonstrated-known count only, never 1000 × rate.
 */
export function estimateFromBands(
	samples: BandSample[],
	bandSize: (key: string) => number,
	options: { frontier?: number; minSample?: number } = {},
): AxisEstimate {
	const minSample = options.minSample ?? 5;
	const withSize = samples.filter((s) => bandSize(s.key) > 0 && s.taught > 0);
	if (withSize.length === 0) return { bands: samples, families: 0, low: 0, high: 0, sampled: 0 };
	let families = 0;
	let low = 0;
	let high = 0;
	let sampled = 0;
	let inherited: { known: number; taught: number } | undefined;
	withSize.forEach((s, index) => {
		const size = bandSize(s.key);
		if (index > (options.frontier ?? withSize.length - 1)) {
			// Beyond the frontier: demonstrated counts only, no interval.
			families += s.known;
			low += s.known;
			high += s.known;
			return;
		}
		if (s.taught >= minSample) {
			inherited = { known: s.known, taught: s.taught };
			sampled += 1;
		}
		const rate = inherited ? inherited.known / inherited.taught : s.known / s.taught;
		const bounds = wilson(inherited?.known ?? s.known, inherited?.taught ?? s.taught);
		families += size * Math.min(1, rate);
		low += size * Math.min(1, bounds.low);
		high += size * Math.min(1, bounds.high);
	});
	return { bands: samples, families, low, high, sampled };
}

// -- Database report --------------------------------------------------------

export interface VocabReport {
	cefr: AxisEstimate;
	coca: AxisEstimate;
	taught: number;
	/** Demonstrated-known floor: distinct items with ≥1 unassisted correct. */
	knownFloor: number;
	solid: number;
	untagged: number;
	listsAvailable: { cefr: boolean; coca: boolean };
}

export function vocabularyReport(db: DatabaseSync, profileBand?: string): VocabReport {
	const rows = db.prepare(`
		SELECT i.text,
			EXISTS(SELECT 1 FROM attempts a
				WHERE a.item_id = i.id
					AND ((a.status = 'evaluated' AND a.verdict = 'correct' AND a.assistance_level = 'none')
						OR (a.status = 'self_report' AND a.explicit_rating IN ('good', 'easy')))) AS known,
			COALESCE(m.unassisted_good, 0) >= 2 AS solid
		FROM items i LEFT JOIN mastery_state m ON m.item_id = i.id
		WHERE i.type IN ('word', 'phrase') AND i.shown = 1 AND i.legacy_duplicate_of IS NULL
	`).all() as { text: string; known: number; solid: number }[];
	const lists = loadWordlists();
	const buckets = new Map<string, BandSample>();
	const note = (axis: "cefr" | "coca", key: string, row: { known: number; solid: number }) => {
		const bucketKey = `${axis}:${key}`;
		const entry = buckets.get(bucketKey) ?? { key, taught: 0, known: 0, solid: 0 };
		entry.taught += 1;
		entry.known += row.known;
		entry.solid += row.solid;
		buckets.set(bucketKey, entry);
	};
	let untagged = 0;
	let knownFloor = 0;
	let solid = 0;
	for (const row of rows) {
		const bands = lookupBands(row.text, lists);
		if (bands.cefr) note("cefr", bands.cefr, row);
		if (bands.band) note("coca", bands.band, row);
		if (!bands.cefr && !bands.band) untagged += 1;
		knownFloor += row.known;
		solid += row.solid;
	}
	const byAxis = (axis: string) =>
		[...buckets.entries()].filter(([bucket]) => bucket.startsWith(`${axis}:`)).map(([, sample]) => sample);
	const cefrBands = byAxis("cefr").sort(
		(a, b) => CEFR_LEVELS.indexOf(a.key as CefrLevel) - CEFR_LEVELS.indexOf(b.key as CefrLevel),
	);
	const cocaBands = byAxis("coca").sort((a, b) => Number(a.key.slice(0, -1)) - Number(b.key.slice(0, -1)));
	// The learner-profile vocabulary band is the difficulty frontier: rate
	// extrapolation stops there; higher bands are frontier-biased samples.
	const band = CEFR_LEVELS.includes(profileBand as CefrLevel) ? (profileBand as CefrLevel) : "B1";
	const COCA_FRONTIER: Record<CefrLevel, string> = { A1: "1k", A2: "2k", B1: "3k", B2: "5k", C1: "8k", C2: "12k" };
	const orderCefr = (key: string) => CEFR_LEVELS.indexOf(key as CefrLevel);
	const cocaNum = (key: string) => Number(key.slice(0, -1));
	const frontierIndex = (samples: BandSample[], at: (key: string) => number, frontier: number) =>
		samples.reduce((last, s, i) => (at(s.key) <= frontier ? i : last), -1);
	return {
		cefr: estimateFromBands(cefrBands, (key) => CEFR_BAND_FAMILIES[key as CefrLevel] ?? 0, {
			frontier: frontierIndex(cefrBands, orderCefr, orderCefr(band)),
		}),
		coca: estimateFromBands(cocaBands, (key) => cocaBandSize(key), {
			frontier: frontierIndex(cocaBands, cocaNum, cocaNum(COCA_FRONTIER[band])),
		}),
		taught: rows.length,
		knownFloor,
		solid,
		untagged,
		listsAvailable: { cefr: lists.cefr.size > 0, coca: lists.cocaRank.size > 0 },
	};
}

function pct(sample: BandSample): string {
	return `${sample.key} ${Math.round((sample.known / sample.taught) * 100)}%(${sample.taught})`;
}

/** Human-readable summary lines for the /anki:vocab command. */
export function formatVocabReport(report: VocabReport): string[] {
	const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
	const axis = (e: AxisEstimate) =>
		e.sampled === 0 ? "样本不足" : `${fmt(e.families)}（95% 区间 ${fmt(e.low)}–${fmt(e.high)}）`;
	const lines = [
		`词汇量估计（词族·接受性口径）：COCA 外推 ${axis(report.coca)} · CEFR 外推 ${axis(report.cefr)}`,
	];
	const bandLine = (e: AxisEstimate) => e.bands.map(pct).join(" · ");
	if (report.coca.bands.length) lines.push(`COCA 频段掌握率：${bandLine(report.coca)}`);
	if (report.cefr.bands.length) lines.push(`CEFR 掌握率：${bandLine(report.cefr)}`);
	const lists = [
		report.listsAvailable.cefr ? "Oxford3000/5000" : null,
		report.listsAvailable.coca ? "COCA20k" : null,
	].filter(Boolean).join("+") || "无（dictionaries/ 缺词表文件）";
	lines.push(`已验证掌握 ${report.knownFloor}/${report.taught} · 扎实(连对≥2) ${report.solid} · 未标注 ${report.untagged} · 词表：${lists}`);
	lines.push("口径：词族；样本为已教卡的频段抽样，低频段偏保守、前沿频段较准；方法详见 lexical-band.ts");
	return lines;
}
