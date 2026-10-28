// lexical-band: word-list lookup, lemma fallback, and stratified vocabulary
// estimation against fixture lists (no dependency on the real dictionaries/).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "anki-lexical-band-"));

const fixtureDir = mkdtempSync(join(tmpdir(), "anki-wordlists-"));
writeFileSync(join(fixtureDir, "oxford-cefr.tsv"), [
	"Word\tAnnotation\tSense\tPart of Speech\tLevel",
	"house\t\t\tn.\tA1",
	"departure\t\t\tn.\tA2",
	"specify\t\t\tv.\tB1",
	"interpretation\t\t\tn.\tB2",
	"feasible\t\t\tadj.\tC1",
	"water\t\t\tn., v. A1, B1\tA1, B1", // multi-level row: only studyOrder reads it
].join("\n"));
writeFileSync(join(fixtureDir, "oxford5000-cefr.tsv"), [
	"Word\tAnnotation\tSense\tPart of Speech\tLevel",
	"house\t\t\tn.\tA2", // higher file wins only when the level is higher
	"surge\t\t\tn.\tB2",
].join("\n"));
writeFileSync(join(fixtureDir, "coca20000.txt"), [
	"the", "be", "and", "house", "departure", "specify", "surge",
].join("\n"));
process.env.KAOMOJI_WORDLISTS_DIR = fixtureDir;

const {
	CEFR_BAND_FAMILIES,
	estimateFromBands,
	lookupBands,
	loadWordlists,
	screeningEase,
	studyOrder,
	vocabularyReport,
} = await import("../lexical-band.ts");
const { openDb } = await import("../db.ts");

// -- word-list loading and lookup ------------------------------------------

test("loads CEFR levels across files, keeping the highest level per word", () => {
	const lists = loadWordlists();
	assert.equal(lists.cefr.size, 6, "five unique words plus the house override");
	assert.equal(lists.cefr.get("house"), "A2", "later file may raise a word's level");
	assert.equal(lists.cocaRank.get("surge"), 7);
});

test("lookup labels words, phrases, and simple inflections", () => {
	assert.deepEqual(lookupBands("house"), { cefr: "A2", band: "1k" });
	assert.equal(lookupBands("Houses ").cefr, "A2", "case and padding normalize");
	assert.equal(lookupBands("specifying").cefr, "B1", "-ing falls back to the stem");
	assert.equal(lookupBands("departures").band, "1k", "plural falls back to the lemma");
	const phrase = lookupBands("run out of");
	assert.equal(phrase.cefr, undefined, "unlisted phrases stay untagged");
	assert.equal(phrase.band, undefined);
});

test("screening ease ranks common, low-level, short words first", () => {
	const order = ["interpretation", "run out of", "house", "surge", "specifying", "departure"]
		.sort((a, b) => screeningEase(b) - screeningEase(a));
	assert.deepEqual(order, ["house", "surge", "departure", "specifying", "run out of", "interpretation"]);
	assert.equal(screeningEase("Houses "), screeningEase("houses"), "case and padding normalize");
	assert.ok(screeningEase("specifying") > screeningEase("specifyingx"), "an inflection inherits its lemma's rank");
});

test("study order goes CEFR level first, then frequency; unlisted levels come from frequency", () => {
	const order = ["feasible", "zzz", "surge", "the", "water", "interpretation", "specify", "departure", "house"]
		.sort((a, b) => studyOrder(a) - studyOrder(b));
	// house takes its lowest level (A1, though another file lists A2); listed A1 words precede the
	// unlisted "the" (rank 1, inferred A1); a multi-level "A1, B1" row counts as A1; within B2,
	// surge (ranked) precedes interpretation (unranked); an unknown word goes last.
	assert.deepEqual(order, ["house", "water", "the", "departure", "specify", "surge", "interpretation", "feasible", "zzz"]);
	assert.equal(studyOrder("house surge"), studyOrder("house surge"), "deterministic");
	assert.equal(studyOrder("the zzz"), studyOrder("zzz"), "an unlisted phrase takes its hardest word's position");
});

test("missing word-list directory degrades to empty labels", () => {
	const empty = loadWordlists(join(tmpdir(), "anki-no-such-dir-"));
	assert.equal(empty.cefr.size, 0);
	assert.equal(empty.cocaRank.size, 0);
});

// -- stratified estimation ---------------------------------------------------

test("per-band extrapolation inherits lower-band rates and caps at band size", () => {
	const estimate = estimateFromBands(
		[
			{ key: "1k", taught: 10, known: 10, solid: 9 },
			{ key: "2k", taught: 4, known: 3, solid: 3 },  // below minSample: inherits 1k rate
			{ key: "3k", taught: 20, known: 10, solid: 8 }, // 50% frontier band
		],
		(key) => (/^[0-9]+k$/.test(key) ? 1000 : 0),
	);
	assert.equal(estimate.sampled, 2);
	assert.equal(estimate.families, 1000 + 1000 + 500, "full band + inherited full band + half of the frontier");
	// Wilson low on 10/10 is below 1, so the low bound must dip accordingly.
	assert.ok(estimate.low < 2500 && estimate.high <= 3000);
});

test("bands beyond the frontier contribute demonstrated counts only", () => {
	const estimate = estimateFromBands(
		[
			{ key: "1k", taught: 10, known: 9, solid: 9 },
			{ key: "2k", taught: 4, known: 4, solid: 4 }, // inherits 1k rate inside the frontier
			{ key: "3k", taught: 30, known: 27, solid: 20 }, // beyond frontier: demonstrated only
		],
		(key) => (/^[0-9]+k$/.test(key) ? 1000 : 0),
		{ frontier: 1 },
	);
	assert.equal(estimate.families, 900 + 900 + 27, "no 1000 × rate beyond the frontier");
});

test("CEFR axis uses the documented family anchors", () => {
	const estimate = estimateFromBands(
		[
			{ key: "A1", taught: 10, known: 10, solid: 10 },
			{ key: "B2", taught: 10, known: 5, solid: 4 },
		],
		(key) => CEFR_BAND_FAMILIES[key as keyof typeof CEFR_BAND_FAMILIES] ?? 0,
	);
	assert.equal(estimate.families, 700 + 750);
});

test("no samples yields an explicit empty estimate", () => {
	const estimate = estimateFromBands([], () => 1000);
	assert.equal(estimate.sampled, 0);
	assert.equal(estimate.families, 0);
});

// -- database report ---------------------------------------------------------

test("vocabularyReport stratifies taught items by looked-up bands", () => {
	const db = openDb();
	try {
		const now = new Date().toISOString();
		const add = (text: string) => db.prepare(
			"INSERT INTO items(type,text,meaning,learned_at,due_at,shown) VALUES('word',?,?,?, ?,1)",
		).run(text, `${text} 释义`, now, now);
		const attempt = (text: string, verdict: string, assistance: string) => {
			const id = (db.prepare("SELECT id FROM items WHERE text = ?").get(text) as { id: number }).id;
			db.prepare(
				`INSERT INTO attempts(id,item_id,review_cycle_id,claim_key,question_version,evaluation_version,kind,assistance_level,status,verdict,started_at,rated_at)
				 VALUES(?,?,?,?,1,1,'recall',?,'evaluated',?,?,?)`,
			).run(`${text}-${assistance}-${verdict}`, id, "rc", `ck-${text}-${assistance}-${verdict}`, assistance, verdict, now, now);
		};
		const mastery = (text: string, good: number) => {
			const id = (db.prepare("SELECT id FROM items WHERE text = ?").get(text) as { id: number }).id;
			db.prepare("INSERT INTO mastery_state(item_id,stage,unassisted_good,updated_at) VALUES(?,'transfer',?,?)").run(id, good, now);
		};
		add("house"); add("house"); // duplicate texts are distinct items; both A1/1k
		add("specify");
		add("mysteryword"); // untagged
		attempt("house", "correct", "none");
		attempt("specify", "partial", "none");
		mastery("house", 2);
		const report = vocabularyReport(db);
		assert.equal(report.taught, 4);
		assert.equal(report.knownFloor, 1, "only house has an unassisted correct");
		assert.equal(report.solid, 1);
		assert.equal(report.untagged, 1);
		const a2 = report.cefr.bands.find((b) => b.key === "A2");
		assert.equal(a2?.taught, 2);
		assert.equal(a2?.known, 1);
		const k1 = report.coca.bands.find((b) => b.key === "1k");
		assert.equal(k1?.taught, 3, "house×2 + specify all sit in the 1k band");
		// Default frontier B1: A2/1k extrapolate; B1 samples land inside the
		// frontier too, so they also extrapolate at their own small-sample rate.
		assert.ok(report.cefr.families > 0 && report.coca.families > 0);
		assert.ok(report.cefr.families < 700 + 1100 + 1200, "stays within the anchored band totals");
		assert.ok(report.coca.families <= 1000, "single COCA band cannot exceed its size");
		assert.ok(report.listsAvailable.cefr && report.listsAvailable.coca);
	} finally {
		db.close();
	}
});
