import type { DatabaseSync } from "node:sqlite";
import type { DailyLoadPlan } from "./adaptive-load.ts";
import { countTodayNew, customQueueCount, getStat, SCHEDULABLE, type ItemRow } from "./db.ts";

// -- Pet faces ------------------------------------------------------------

export const FACES = {
	teach: "(=^･ω･^=)",
	review: "(=^‥^=)",
	idle: "(=ΦωΦ=)",
	party: "(=^‥^=)ﾉ",
	error: "(=；ω；=)",
} as const;

// -- Widget rendering -----------------------------------------------------

export const TYPE_LABELS: Record<string, string> = {
	word: "单词",
	phrase: "词组",
	sentence: "句子",
	cloze: "语法填空",
};

function countTodayRemainingCards(db: DatabaseSync, now: Date, plan: DailyLoadPlan): { total: number; reviews: number; newCards: number } {
	const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
	// Due reviews (shown items due today or earlier).
	const reviews = Number((db.prepare(
		`SELECT COUNT(*) AS n FROM items WHERE shown = 1 AND due_at < ? ${SCHEDULABLE}`,
	).get(tomorrow) as { n: number }).n);
	// Queued replacements are quota-free; planned/custom cards consume the remaining daily quota.
	const queuedReplacement = Number((db.prepare(
		`SELECT COUNT(*) AS n FROM items WHERE shown = 0 AND status = 'learning' AND introduction_kind = 'replacement' AND due_at < ? ${SCHEDULABLE}`,
	).get(tomorrow) as { n: number }).n);
	const queuedPlanned = Number((db.prepare(
		`SELECT COUNT(*) AS n FROM items WHERE shown = 0 AND status = 'learning' AND (introduction_kind IN ('planned', 'custom') OR introduction_kind IS NULL) AND due_at < ? ${SCHEDULABLE}`,
	).get(tomorrow) as { n: number }).n);
	let remainingPlanned = 0;
	if (!plan.paused) {
		remainingPlanned = plan.limit === 0
			? queuedPlanned
			: Math.min(queuedPlanned, Math.max(0, plan.limit - countTodayNew(db, now)));
	}
	const newCards = queuedReplacement + remainingPlanned;
	return { total: reviews + newCards, reviews, newCards };
}

export function formatStatusLine(db: DatabaseSync, plan: DailyLoadPlan): string {
	const streak = Number(getStat(db, "streak_days") ?? 0);
	const remaining = countTodayRemainingCards(db, new Date(), plan);
	const queued = customQueueCount(db);
	if (remaining.total === 0 && queued === 0) return "";
	const parts: string[] = [];
	if (remaining.total > 0) {
		parts.push(`今日剩余卡片${remaining.newCards > 0
			? `（复习 ${remaining.reviews} · 新卡 ${remaining.newCards}）`
			: `（复习 ${remaining.reviews}）`}`);
	}
	if (queued > 0) parts.push(`排队 ${queued}`);
	return `🔥 连续学习 ${streak} 天 · ${parts.join(" · ")}`;
}

/** Parse a JSON column safely. */
export function parseJsonCol<T>(raw: string | null): T | undefined {
	if (!raw) return undefined;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return undefined;
	}
}

function wordEditDistance(left: string, right: string): number {
	const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
	for (let i = 1; i <= left.length; i++) {
		const current = [i];
		for (let j = 1; j <= right.length; j++) {
			current[j] = Math.min(
			current[j - 1] + 1,
			previous[j] + 1,
			previous[j - 1] + (left[i - 1].toLowerCase() === right[j - 1].toLowerCase() ? 0 : 1),
			);
		}
		previous.splice(0, previous.length, ...current);
	}
	return previous[right.length];
}

function highlightWordChange(before: string, after: string): string {
	let prefix = 0;
	while (prefix < before.length && prefix < after.length && before[prefix].toLowerCase() === after[prefix].toLowerCase()) prefix++;
	let suffix = 0;
	while (
		suffix < before.length - prefix && suffix < after.length - prefix &&
		before[before.length - 1 - suffix].toLowerCase() === after[after.length - 1 - suffix].toLowerCase()
	) suffix++;
	const mark = (word: string) => {
		const end = word.length - suffix;
		return `${word.slice(0, prefix)}[${word.slice(prefix, end) || "∅"}]${word.slice(end)}`;
	};
	return `${mark(before)} → ${mark(after)}`;
}

export function spellingComparisonLines(answer: string | null, correctedAnswer: string | undefined, errorTags: string[]): string[] {
	if (!answer || !correctedAnswer || !errorTags.includes("spelling")) return [];
	const before = answer.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) ?? [];
	const after = correctedAnswer.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) ?? [];
	if (before.length !== after.length) return [];
	const changes = before.flatMap((word, index) => {
		const corrected = after[index];
		if (word.toLowerCase() === corrected.toLowerCase()) return [];
		return wordEditDistance(word, corrected) <= 2 ? [highlightWordChange(word, corrected)] : [];
	}).slice(0, 3);
	return changes.length ? [`🔎 拼写对比：${changes.join("；")}`] : [];
}

export interface SentenceExerciseView {
	level: number;
	kind: "sentence_cloze" | "sentence_production";
	chinese: string;
	reference: string;
	expected: string;
	focusExpression?: string;
	cloze?: string;
	hint: string;
}

const SENTENCE_STOP_WORDS = new Set([
	"a", "an", "and", "are", "as", "at", "be", "because", "been", "before", "but", "by", "for", "from",
	"has", "have", "he", "her", "his", "i", "in", "is", "it", "its", "of", "on", "or", "our", "she", "so",
	"that", "the", "their", "them", "they", "this", "to", "was", "we", "were", "will", "with", "you", "your",
]);

export function sentenceExercise(item: ItemRow, requestedLevel = item.progress): SentenceExerciseView | undefined {
	const levels = parseJsonCol<string[]>(item.levels);
	if (!levels?.length) return undefined;
	const level = Math.max(0, Math.min(requestedLevel, levels.length - 1));
	const reference = levels[level].trim();
	const levelsCn = parseJsonCol<string[]>(item.levels_cn);
	const chinese = levelsCn?.[level]?.trim() || item.meaning;
	const words = [...reference.matchAll(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g)];
	const keyWords = parseJsonCol<{ text: string; meaning: string }[]>(item.key_words) ?? [];
	let focusMatch = words.find((match) => keyWords.some((key) => {
		const word = match[0].toLowerCase();
		const keyWord = key.text.toLowerCase();
		return word === keyWord || word.startsWith(keyWord) || keyWord.startsWith(word);
	}));
	focusMatch ??= words
		.filter((match) => !SENTENCE_STOP_WORDS.has(match[0].toLowerCase()))
		.sort((a, b) => b[0].length - a[0].length)[0];
	const focusExpression = focusMatch?.[0];
	const firstLetterHint = (text: string) => text
		.split(/(\s+)/)
		.map((part) => /^[A-Za-z]/.test(part) ? part[0] + "_".repeat(Math.max(0, part.replace(/[^A-Za-z]/g, "").length - 1)) : part)
		.join("");
	if (level === 0 && focusMatch?.index != null) {
		const start = focusMatch.index;
		const cloze = reference.slice(0, start) + "____" + reference.slice(start + focusMatch[0].length);
		return {
			level,
			kind: "sentence_cloze",
			chinese,
			reference,
			expected: focusMatch[0],
			focusExpression,
			cloze,
			hint: firstLetterHint(focusMatch[0]),
		};
	}
	return {
		level,
		kind: "sentence_production",
		chinese,
		reference,
		expected: reference,
		focusExpression,
		hint: firstLetterHint(reference),
	};
}

/** Canonical recall question text — single source for card display and attempt logs. */
export function recallQuestionText(
	item: ItemRow,
	direction: "forward" | "reverse",
	cue?: ForwardCue,
): string {
	if (item.type === "cloze") return `语法填空：${item.text}`;
	const label = TYPE_LABELS[item.type] ?? item.type;
	if (direction === "reverse") {
		// A bare "give the Chinese meaning" prompt is ambiguous for polysemous
		// words (work → 工作/起作用). The card's example sentence pins the sense.
		const example = item.example?.trim();
		if (example) return `在例句「${example}」中，${label}「${item.text}」是什么意思？`;
		return `写出${label}「${item.text}」的中文释义`;
	}
	const lexical = lexicalMeaning(item.meaning);
	const safeCore = maskTarget(lexical.meaning, item.text) ?? "根据语境回忆目标词";
	const safeDetails = [lexical.partOfSpeech, maskTarget(lexical.clarification, item.text)].filter(Boolean).join("，");
	const meaning = cue ? maskTarget(item.meaning, item.text) ?? `${safeCore}${safeDetails ? `（${safeDetails}）` : ""}` : item.meaning;
	const base = `默写${label}「${meaning}」的英文`;
	return cue ? base + forwardCueSuffix(cue) : base;
}

/** Extract only explicit grammatical labels; semantic parentheses stay intact. */
export function lexicalMeaning(raw: string): {
	meaning: string;
	partOfSpeech: string;
	clarification: string;
} {
	const pos = "不可数名词|可数名词|复数名词|单数名词|专有名词|集合名词|普通名词|及物动词|不及物动词|情态动词|助动词|动词过去分词|动词现在分词|动词短语|名词短语|形容词|副词|介词短语|介词|连词|代词|数词|冠词|感叹词|名词|动词";
	let meaning = raw.trim().replace(/([）)])[。．]+$/u, "$1");
	let partOfSpeech = "";
	let clarification = "";
	const prefix = new RegExp(`^【(${pos})】\\s*`).exec(meaning);
	if (prefix) {
		partOfSpeech = prefix[1];
		meaning = meaning.slice(prefix[0].length).trim();
	}
	const suffix = new RegExp(`^(.+?)[（(](${pos})(?:[，,；;]\\s*(.+))?[）)]$`).exec(meaning);
	if (suffix) {
		meaning = suffix[1].trim();
		partOfSpeech = suffix[2];
		clarification = suffix[3]?.trim() ?? "";
	}
	return { meaning, partOfSpeech, clarification };
}


/** Visible Chinese POS used by the critic and by the forward-cue gate. */
const CHINESE_POS =
	"(?:(?:不可数|可数|复数|单数|专有|集合|普通)?名词|(?:不及物|及物)?动词|形容词|副词|介词|代词|连词|数词|冠词|感叹词|助动词|情态动词)(?:短语|过去分词|现在分词)?";

export function meaningHasVisiblePos(meaning: string): boolean {
	return new RegExp(`[（(【]\\s*${CHINESE_POS}(?=[，,；;）)】\\s])`).test(meaning);
}

/**
 * Forward production needs more than a POS tag: a same-paren sense or
 * collocation clue so show cannot pass for performance. Bare「表演」or
 * 「表演（名词）」fail;「一场具体的演出（可数名词，常与 give 搭配）」passes.
 */
export function meaningHasForwardSenseClue(meaning: string): boolean {
	if (!meaningHasVisiblePos(meaning)) return false;
	if (new RegExp(`[（(]\\s*${CHINESE_POS}\\s*[，,；;][^）)]+[）)]`).test(meaning)) return true;
	return new RegExp(`【\\s*${CHINESE_POS}\\s*】[^（(]{0,40}[（(][^）)]+[）)]`).test(meaning);
}

/** Same conservative context as the desktop: grammatical labels alone do not
 * establish that a Chinese cue has exactly one English answer. */
export interface ForwardCue {
	initial: string;
	shape?: string;
	letterCount?: number;
	context?: string;
	chineseContext?: string;
}

const IRREGULAR_FORMS = [
	["be", "am", "is", "are", "was", "were", "been", "being"], ["go", "goes", "went", "gone", "going"],
	["have", "has", "had", "having"], ["do", "does", "did", "done", "doing"], ["take", "took", "taken", "taking"],
	["make", "made", "making"], ["give", "gave", "given", "giving"], ["get", "got", "gotten", "getting"],
	["see", "saw", "seen", "seeing"], ["write", "wrote", "written", "writing"], ["read", "reading"],
	["speak", "spoke", "spoken", "speaking"], ["come", "came", "coming"], ["run", "ran", "running"],
	["buy", "bought", "buying"], ["bring", "brought", "bringing"], ["think", "thought", "thinking"],
	["teach", "taught", "teaching"], ["learn", "learned", "learnt", "learning"], ["eat", "ate", "eaten", "eating"],
	["find", "found", "finding"], ["leave", "left", "leaving"], ["feel", "felt", "feeling"],
	["child", "children"], ["person", "people"], ["man", "men"], ["woman", "women"],
	["foot", "feet"], ["tooth", "teeth"], ["mouse", "mice"],
];

function wordForms(word: string): string[] {
	const lower = word.toLowerCase();
	const bases = new Set([lower]);
	if (lower.length > 3) {
		if (/ies$/.test(lower)) bases.add(`${lower.slice(0, -3)}y`);
		if (/s$/.test(lower) && !/ss$/.test(lower)) bases.add(lower.slice(0, -1));
		if (/es$/.test(lower)) bases.add(lower.slice(0, -2));
		for (const ending of ["ed", "ing"]) if (lower.endsWith(ending)) {
			const stem = lower.slice(0, -ending.length);
			if (stem.length < 2) continue;
			bases.add(stem); bases.add(`${stem}e`);
			if (/(.)\1$/.test(stem)) bases.add(stem.slice(0, -1));
			if (ending === "ed" && stem.endsWith("i")) bases.add(`${stem.slice(0, -1)}y`);
		}
	}
	for (const family of IRREGULAR_FORMS) if (family.includes(lower)) for (const form of family) bases.add(form);
	const forms = new Set<string>();
	for (const base of bases) {
		for (const form of [base, `${base}s`, `${base}es`, `${base}ed`, `${base}ing`, `${base}ings`]) forms.add(form);
		if (base.endsWith("e")) { forms.add(`${base}d`); forms.add(`${base.slice(0, -1)}ing`); }
		if (/[bcdfghjklmnpqrstvwxyz]y$/.test(base)) { forms.add(`${base.slice(0, -1)}ies`); forms.add(`${base.slice(0, -1)}ied`); }
		if (/[aeiou][bcdfghjklmnpqrstvz]$/.test(base)) { forms.add(`${base}${base.at(-1)}ed`); forms.add(`${base}${base.at(-1)}ing`); }
	}
	return [...forms].sort((a, b) => b.length - a.length);
}

/** Mask every occurrence, including common inflections and possessives. The
 * English example must contain a recognized target; unfamiliar spellings or
 * residual target fragments make us withhold the example instead of leaking it. */
function maskTarget(raw: string | null, target: string, requireMatch = false): string | null {
	if (!requireMatch && raw?.trim() && !/[A-Za-z]/.test(raw)) return raw.trim();
	const normalized = target.trim();
	if (!raw?.trim() || !/^[A-Za-z]+(?:['’\-][A-Za-z]+)*(?:\s+[A-Za-z]+(?:['’\-][A-Za-z]+)*)*$/.test(normalized)) return null;
	const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const pattern = normalized.split(/\s+/).map(word => `(?:${wordForms(word).map(escape).join("|")})(?:['’]s|['’])?`).join("\\s+");
	const matcher = new RegExp(`(?<![A-Za-z])${pattern}(?![A-Za-z])`, "giu");
	let matched = false;
	const masked = raw.replace(matcher, match => { matched = true; return "_".repeat(match.length); });
	if (requireMatch && !matched) return null;
	const residual = normalized.split(/\s+/).map(escape).join("\\s+");
	if (new RegExp(residual, "iu").test(masked)) return null;
	return masked.trim();
}

export function forwardCue(item: ItemRow): ForwardCue | undefined {
	const initial = item.text.match(/[A-Za-z]/)?.[0]?.toLowerCase();
	if (!initial) return undefined;
	const words = item.text.trim().split(/\s+/);
	const lengths = words.map(word => (word.match(/[A-Za-z]/g) ?? []).length);
	const letterCount = lengths.reduce((sum, length) => sum + length, 0);
	const shape = words.length === 1 ? `${letterCount} 个字母` : `${words.length} 个词（${lengths.join(" + ")} 个字母）`;
	return { initial, shape, letterCount,
		context: maskTarget(item.example, item.text, true) ?? undefined,
		chineseContext: maskTarget(item.example_cn, item.text) ?? undefined };
}

export function forwardCueSuffix(cue: ForwardCue): string {
	return `（${[
		cue.letterCount === 1 ? "" : `以 ${cue.initial} 开头`, cue.shape,
		cue.context ? `例：${cue.context}` : "",
		cue.chineseContext ? `语境：${cue.chineseContext}` : "",
	].filter(Boolean).join("；")}）`;
}

export function questionHasForwardCue(questionText: string | null | undefined): boolean {
	return /（(?:以 [A-Za-z] 开头|1 个字母)/.test(questionText ?? "");
}

/** True when a reverse prompt carries the card's example sentence as sense context. */
export function questionHasReverseContext(questionText: string | null | undefined): boolean {
	return /^在例句「.+」中，.+「.+」是什么意思？/.test(questionText ?? "");
}

/** Canonical sentence-level question text for attempt logs. */
export function sentenceQuestionText(exercise: SentenceExerciseView): string {
	return exercise.kind === "sentence_cloze"
		? `L${exercise.level + 1} 填空：${exercise.cloze}`
		: `L${exercise.level + 1} 中文：${exercise.chinese}`;
}

/** Render a teach/review card as widget lines (front = question, back = answer). */
export function renderCard(item: ItemRow, isReview: boolean, face: string, showAnswer = false, direction: "forward" | "reverse" = "forward", cue?: ForwardCue): string[] {
	const label = TYPE_LABELS[item.type] ?? item.type;
	const lines: string[] = [];

	// Sentence cards use progressive written production rather than self-reported reading.
	const levels = parseJsonCol<string[]>(item.levels);
	if (item.type === "sentence" && levels && levels.length > 1) {
		const exercise = sentenceExercise(item);
		if (!exercise) return lines;
		const chunks = parseJsonCol<string[]>(item.chunks);
		lines.push(`${face} 句子输出（L${exercise.level + 1}/${levels.length}）：`);
		lines.push(`  中文：${exercise.chinese}`);
		if (exercise.kind === "sentence_cloze") {
			lines.push(`  填空：${exercise.cloze}`);
			lines.push("  只需写出缺失的英文词，也可以写完整句子。");
		} else {
			lines.push("  请写出自然英文，不要求与参考句逐字一致。");
			if (exercise.focusExpression) lines.push(`  尽量使用：${exercise.focusExpression}`);
		}
		if (showAnswer) {
			lines.push(`  参考：${exercise.reference}`);
			if (exercise.level === levels.length - 1 && chunks?.length) lines.push(`  意群：${chunks.join(" / ")}`);
		}
		lines.push("💬 /anki:answer <英文> · /anki:hint · /anki:flip · /anki:again");
		return lines;
	}

	// Cloze cards test one grammar point: fill the single blank in the sentence.
	if (item.type === "cloze") {
		if (isReview) {
			if (showAnswer) {
				lines.push(`${face} 语法填空：${item.example || item.text.replace("___", item.meaning)}`);
				lines.push(`  答案：${item.meaning}`);
				const chunks = parseJsonCol<string[]>(item.chunks);
				if (chunks?.length) lines.push(`  意群：${chunks.join(" / ")}`);
				lines.push(`  第 ${item.reviews + 1} 次复习`);
				if (item.example_cn) lines.push(`  ${item.example_cn}`);
			} else {
				lines.push(`${face} 语法填空：${item.text}`);
				// No Chinese gloss here: any translation or grammar note hints the
				// answer form. example_cn is shown on the answer face instead.
			}
			lines.push("💬 /anki:answer <答案> · /anki:hint 提示 · /anki:flip 翻面 · /anki:again 忘了");
		} else {
			lines.push(`${face} ${label}：${item.example || item.text.replace("___", item.meaning)}`);
			lines.push(`  答案：${item.text} → ${item.meaning}`);
			if (item.example_cn) lines.push(`  ${item.example_cn}`);
			lines.push("💬 /anki:flip 翻面 · /anki:skip 已会");
		}
		return lines;
	}

	if (isReview) {
		if (showAnswer) {
			lines.push(`${face} 复习：${item.text}${item.phonetic ? " " + item.phonetic : ""} — ${item.meaning}`);
			lines.push(`  第 ${item.reviews + 1} 次复习`);
		} else {
			lines.push(`${face} 复习时间到：✍️ ${recallQuestionText(item, direction, cue)}`);
		}
		if (item.example && showAnswer) {
			lines.push(`  例：${item.example}${item.example_cn ? `（${item.example_cn}）` : ""}`);
		}
		lines.push(`💬 /anki:answer 默写 · /anki:hint 提示 · /anki:flip 翻面 · /anki:good 记得 · /anki:again 忘了`);
	} else {
		lines.push(`${face} ${label}：${item.text}${item.phonetic ? " " + item.phonetic : ""}`);
		if (showAnswer) {
			lines.push(`  释义：${item.meaning}`);
			if (item.example) {
				lines.push(`  例：${item.example}${item.example_cn ? `（${item.example_cn}）` : ""}`);
			}
		}
		lines.push(`💬 /anki:flip 翻面 · /anki:skip 已会`);
	}
	return lines;
}
