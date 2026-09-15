import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { LESSON_CLOZE_ITEMS, LESSON_MAX_PHRASES, LESSON_WORD_ITEMS, MAX_CUSTOM_PER_ADD, type PetConfig } from "./config.ts";
import type { PiSdkLlmClient } from "./pi-sdk-llm.ts";
import { normalizeMeaning, type ItemRow } from "./db.ts";
import { forwardCue, meaningHasForwardSenseClue, meaningHasVisiblePos, questionHasForwardCue, questionHasReverseContext, type SentenceExerciseView } from "./render.ts";
import { coldStartProfile, deriveBudget, formatAdaptiveBlock, normalizeErrorTag, type AdaptiveContext } from "./learner-profile.ts";

// -- LLM lesson generation ------------------------------------------------

/** Shared by all generation paths and the critic, including basic fallbacks. */
export const FORWARD_PROMPT_QUALITY = [
	"- word/phrase 会用 meaning 作为中文到英文的题面：必须在作答前就给足线索，不得等判分反馈才解释目标词，也不得假设学习者能猜到隐藏的 text。",
	"- 每张 word/phrase 的 meaning 都必须明确标注当前所考义项的中文词性，不能仅在 example、隐藏字段或判分反馈里说明。单词标注名词、动词、形容词、副词、介词、代词、连词、数词、冠词或感叹词等；词组标注动词短语、名词短语等适用类别。不得因中文看起来简单而省略，也不得把同一个英文的多个词性一起罗列让学生猜本题考哪个。",
	"- 例如 communicate 应写「交流（动词，指与他人交换信息或想法）」，communication 应写「交流（名词，指交换信息或想法的过程）」；提示「交流」无法区分动词与名词。词性须与 text 在例句中的当前用法一致，不能只标笼统的「单词」或「词组」。词性只解决词类歧义，同词性的近义词仍须补必要的义项或搭配线索。",
	"- 消歧不限于批内或已学词的释义完全重复：即使其它近义词未入库、中文写法不同，也要检查常见合理答案。必要的词性、可数/不可数、义项范围或自然搭配属于题面线索，允许简短写在 meaning 的括号中，不属于应删去的用途/效果说明。",
	"- 例如 information 不可只提示「信息/消息」：可写「信息（不可数名词，泛指事实或资料）」；message 可写「消息（可数名词，指发送或收到的一条留言）」。这说明词义范围，不能虚构近义词之间并不存在的区别。",
	"- 例如 performance 不可只提示「表演」：show、act 同样自然。应写「一场具体的演出（可数名词，常与 give 搭配，强调演出本身或当场表现）」；只标「表演（名词）」也不够，必须补语境或搭配。",
	"- 为有近义词的目标选择能体现词义的自然例句/搭配，example 必须原样包含 text，example_cn 准确翻译；把目标挖空后仍应提供有用语境，不能只用 I like ... 等空泛句。",
	"- 逐张做同词性替换检验：先列出至少一个自然的常见候选（确无候选须说明），再把每个候选代入 meaning 的实际场景和遮住目标词的 example；候选不必已入库、也不必共享完全相同的中文释义。解释为什么替换不成立，不能只宣称「上下文明确」。",
	"- 括号里有说明不等于完成消歧：把「目标」改写成「希望达到/达成的结果」「想要实现的事情」，或写「强调结果、常与 set 搭配」，仍然同时容纳 goal / target / aim。释义复述、目标词的英文释义和空泛例句都不是区分同义词的证据；真实场景/搭配的必要部分必须前置到 meaning，而不是只存在于 example 或反馈。",
	"- goal / target / aim 的泛指目标义项不能靠虚构「goal 只能长期、target 只能具体、aim 只能主观」来强行区分；必须实际替换检验。若仍可互换，换词或换练习；需保留目标时，在 meaning 明确写本次学习目标的正确首字母和字母数（goal：以 g 开头，共 4 个字母；target：以 t 开头，共 6 个字母；aim：以 a 开头，共 3 个字母），并配真实场景与可遮目标的例句。这是指定拼写练习目标，不是证明这些词语义互斥。",
	"- 自检以实际默认题面为准：学生只看到 meaning，不能假设例句挖空或首字母已经显示，例句仅作辅助。隐藏 text 和 example 后，学生能否仅从 meaning 判断所考词？若仍有多个同样自然且满足线索的常见答案，必须将必要限定写进 meaning；仍可互换时加入真实正确的首字母/词长学习目标提示，或换学习项。用户指定必须保留的词不能靠不自然英文或直接泄露完整目标英文来强行唯一，也不能在后台假设非 App 客户端显示额外提示。",
].join("\n");

export interface GeneratedItem {
	type: "word" | "phrase" | "sentence" | "cloze";
	text: string;
	phonetic?: string;
	meaning: string;
	example?: string;
	example_cn?: string;
	/** Sentence only: 3 progressive levels (main clause -> full sentence). */
	levels?: string[];
	/** Sentence only: per-level Chinese translations, aligned with levels. */
	levels_cn?: string[];
	/** Sentence/cloze only: chunking of the full sentence for guided reading. */
	chunks?: string[];
	/** Sentence only: likely-new words inside the sentence, with meanings. */
	keyWords?: { text: string; phonetic?: string; meaning: string }[];
}

/** A narrow regression guard for a known interchangeable sense family.
 * This catches a reproducible counterexample; it does not prove arbitrary
 * vocabulary prompts semantically unique. All other cases still need review. */
function knownForwardAlternatives(item: GeneratedItem): string[] {
	const target = item.text.trim().toLowerCase();
	const singular = target.replace(/s$/, "");
	if (!["goal", "target", "aim"].includes(singular)) return [];
	const core = item.meaning.replace(/【[^】]*】/g, "").split(/[（(]/)[0];
	if (/球门|进球|靶子|靶心|靶标/.test(core)) return [];
	if (!/目标|目的|志向|意图|愿望|(?:希望|想要|期望|预期).*(?:达到|达成|实现|取得|结果)/.test(item.meaning)) return [];
	return ["goal", "target", "aim"].filter(word => word !== singular).map(word => target.endsWith("s") ? `${word}s` : word);
}

function hasMatchingSpellingTarget(item: GeneratedItem): boolean {
	const target = item.text.trim().toLowerCase();
	const initials = [...item.meaning.matchAll(/(?:以\s*([a-z])\s*开头|首字母\s*(?:为|是|[:：])?\s*([a-z]))/gi)];
	const lengths = [...item.meaning.matchAll(/(\d+)\s*(?:个)?\s*(?:英文)?字母/g)];
	const negated = /(?:不|非).{0,4}(?:以\s*[a-z]\s*开头|首字母|\d+\s*(?:个)?\s*(?:英文)?字母)/i.test(item.meaning);
	return !negated && initials.length > 0 && lengths.length > 0
		&& initials.every(match => (match[1] || match[2]).toLowerCase() === target[0])
		&& lengths.every(match => Number(match[1]) === target.replace(/[^a-z]/g, "").length);
}

function stringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry.trim())) return undefined;
	return value;
}

function keyWordArray(value: unknown): GeneratedItem["keyWords"] | undefined {
	if (!Array.isArray(value)) return undefined;
	const result: NonNullable<GeneratedItem["keyWords"]> = [];
	for (const entry of value) {
		if (!entry || typeof entry !== "object") return undefined;
		const record = entry as Record<string, unknown>;
		if (typeof record.text !== "string" || !record.text.trim() || typeof record.meaning !== "string" || !record.meaning.trim()) {
			return undefined;
		}
		if (record.phonetic != null && typeof record.phonetic !== "string") return undefined;
		result.push({ text: record.text, meaning: record.meaning, phonetic: record.phonetic as string | undefined });
	}
	return result;
}

function clozeTextAppendsAnswer(text: string, answer: string): boolean {
	const suffix = text.match(/\s(?:=|→)\s*(.+?)\s*$/u)?.[1];
	if (!suffix) return false;
	const normalize = (value: string) => value.trim().replace(/[.!?。！？]+$/u, "").trim().toLowerCase().replace(/\s+/g, " ");
	return normalize(suffix) === normalize(answer);
}

/** Extract the first JSON object, tolerating an optional Markdown fence. */
function extractJsonObjectText(text: string): string | undefined {
	const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
	const start = cleaned.indexOf("{");
	const end = cleaned.lastIndexOf("}");
	return start >= 0 && end > start ? cleaned.slice(start, end + 1) : undefined;
}

/** Parse and structurally validate one generated item; undefined when malformed. */
export function parseGeneratedItem(raw: unknown, expectedType?: GeneratedItem["type"]): GeneratedItem | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const record = raw as Record<string, unknown>;
	const type = record.type;
	if (type !== "word" && type !== "phrase" && type !== "sentence" && type !== "cloze") return undefined;
	if (expectedType && type !== expectedType) return undefined;
	if (typeof record.text !== "string" || !record.text.trim() || typeof record.meaning !== "string" || !record.meaning.trim()) return undefined;
	// Cloze: exactly one blank, non-empty answer (meaning checked above), and
	// 2-6 meaning chunks covering the full sentence (answer-face reading aid).
	let clozeChunks: string[] | undefined;
	if (type === "cloze") {
		if (record.text.split("___").length !== 2 || clozeTextAppendsAnswer(record.text, record.meaning)) return undefined;
		const chunks = stringArray(record.chunks);
		if (!chunks || chunks.length < 2 || chunks.length > 6) return undefined;
		clozeChunks = chunks;
	}
	for (const key of ["phonetic", "example", "example_cn"] as const) {
		if (record[key] != null && typeof record[key] !== "string") return undefined;
	}
	const item: GeneratedItem = {
		type,
		text: record.text,
		meaning: record.meaning,
		phonetic: record.phonetic as string | undefined,
		example: record.example as string | undefined,
		example_cn: record.example_cn as string | undefined,
		...(clozeChunks ? { chunks: clozeChunks } : {}),
	};
	if (type === "sentence") {
		if (record.levels != null && !(item.levels = stringArray(record.levels))) return undefined;
		if (record.levels_cn != null && !(item.levels_cn = stringArray(record.levels_cn))) return undefined;
		if (record.chunks != null && !(item.chunks = stringArray(record.chunks))) return undefined;
		if (record.keyWords != null && !(item.keyWords = keyWordArray(record.keyWords))) return undefined;
	}
	return item;
}

function validClozeItem(item: GeneratedItem): boolean {
	return item.type === "cloze" && item.text.split("___").length === 2 && Boolean(item.meaning.trim())
		&& !clozeTextAppendsAnswer(item.text, item.meaning)
		&& Array.isArray(item.chunks) && item.chunks.length >= 2 && item.chunks.length <= 6;
}

interface ReadyLesson {
	ready: true;
	topic: string;
	items: GeneratedItem[];
}

interface WaitingLesson {
	ready: false;
	reason?: string;
}

export type LessonDecision = ReadyLesson | WaitingLesson;

interface ReadyReplacement {
	ready: true;
	item: GeneratedItem;
}

export type ReplacementDecision = ReadyReplacement | WaitingLesson;

interface ResolvedModel {
	provider: string;
	model: string;
	fromSession: boolean;
}

/** Max critic-driven revision rounds before a lesson is discarded. */
export const MAX_LESSON_REVISIONS = 2;
/** Regeneration attempts when the generated batch still duplicates existing cards. */
export const MAX_DUPLICATE_RETRIES = 1;

/** Same-model retries for transient replacement output-shape errors (BAD_JSON etc.). */
export const REPLACEMENT_SHAPE_RETRIES = 1;

/** Same-prompt retries when the model returns an unparseable or wrongly-shaped
 * lesson decision. Format errors never lower content difficulty: the identical
 * full-quality prompt is re-sent with the parse error attached. */
export const LESSON_FORMAT_RETRIES = 2;

/** Transient model-output shape errors worth an immediate blind retry. */
function isTransientShapeError(err: unknown): boolean {
	const code = String((err as Error & { code?: string })?.code || (err as Error)?.message || "");
	return code === "BAD_JSON" || code === "INVALID_READY" || code === "EMPTY_REPLACEMENT";
}

/** Format-only failures of the lesson decision (retryable at full quality). */
function isLessonFormatError(err: unknown): boolean {
	const code = String((err as Error)?.message || "");
	return ["BAD_JSON", "INVALID_READY", "INVALID_LESSON_SHAPE", "INVALID_LESSON_ITEM"].includes(code);
}

/** Explicit batch composition override (partial batches fill the day's remaining quota). */
export interface LessonBatch {
	wordItems: number;
	clozeItems: number;
}

const DEFAULT_LESSON_BATCH: LessonBatch = { wordItems: LESSON_WORD_ITEMS, clozeItems: LESSON_CLOZE_ITEMS };

/** Phrases may not exceed the words-majority cap nor the batch size itself. */
function phraseCapFor(wordItems: number): number {
	return Math.min(LESSON_MAX_PHRASES, wordItems);
}

export async function generateLesson(
	llm: PiSdkLlmClient,
	ctx: ExtensionContext,
	resolved: ResolvedModel,
	conversation: string,
	known: string[],
	config: PetConfig,
	feedback?: CritiqueIssue[],
	adaptive?: AdaptiveContext,
	recentLog?: string,
	batch?: LessonBatch,
	// basicFallback: last-resort batch of the easiest everyday words after the
	// critic keeps rejecting; already-known words are fine (the user can skip).
	basicFallback = false,
	forceGeneration = false,
): Promise<LessonDecision> {
	const ctxAdaptive = adaptive ?? { profile: coldStartProfile(), budget: deriveBudget(coldStartProfile()) };
	const budget = ctxAdaptive.budget;
	const { wordItems, clozeItems } = batch ?? DEFAULT_LESSON_BATCH;
	const prompt = [
		`你是「英语小宠物」的备课大脑。学习者正在备考雅思，每天需要一整天的课量：共 ${wordItems + clozeItems} 个学习项，其中 ${wordItems} 个单词或词组（以单词为主，词组不超过 ${phraseCapFor(wordItems)} 个）${clozeItems > 0 ? (clozeItems > 1 ? `，${clozeItems} 个语法填空` : "，1 个语法填空") : ""}。`,
		"",
		...(basicFallback
			? [
				"词汇来源（基础兜底模式）：",
				"- 全部学习项都使用英语初学者最基础的高频日常词汇（CEFR A1-A2 必会词，如日常动作、时间、家庭、食物、天气等），越常见越好",
				"- 不要求与会话内容相关，也不受雅思线与画像难度约束；学习者很可能已经会其中一些——这没关系，会了可以跳过",
				"- topic 填「基础词汇」；只有会话内容完全无法解读时才输出：{\"ready\":false,\"reason\":\"简短原因\"}",
			]
			: [
				"词汇来源（两条线，缺一不可）：",
				`- 会话线：从下面会话中提取真实、常用的英语表达，${wordItems} 个单词/词组中至少 3 个来自会话；会话可提取的有效表达不足 3 个时全部提取，剩余名额用雅思词汇补足`,
				"- 雅思线：学习者是低水平初学者，其余学习项从雅思入门/基础段（约 4.0-5.5 分，A2-B1）的高频常用核心词汇中选取（听说读写都常见的日常与基础词汇）；严格遵循下方画像的「词汇层次」，画像词汇档低于 B2 时禁止生僻学术词、低频难词；例句用日常简单句",
				"- 难度限制只约束雅思线的选词；会话线的词不受词汇层次限制——工作场景立即能用、马上就能理解的词（哪怕偏难）优先级高于难度预算，照常提取",
				"",
				"备课条件：",
				"- 技术开发、工具使用、报错排查、代码评审都是有效话题，提取其中值得当前学习者掌握的英语",
				"- 即使会话缺乏可提取的英语内容（纯寒暄、单字命令、环境通知），也用雅思词汇出满一批，topic 填「雅思词汇」，不要拒绝备课",
				"- 只有会话内容完全无法解读时才输出：{\"ready\":false,\"reason\":\"简短原因\"}",
			]),
		"",
		...(forceGeneration ? ["用户已明确要求现在备课：必须生成 ready:true 的完整新批次，不要再判断是否值得备课；主题线索不足时使用雅思基础高频词补足。"] : []),
		"学习项要求：",
		...(basicFallback
			? ["- 内容要真实常用：选自基础高频词表，例句短小自然"]
			: ["- 内容要真实常用：会话来源的贴近会话语境，雅思来源的选自雅思高频词表；难度都须贴合下面的画像与预算"]),
		"- word 和 phrase 的例句短小自然，贴近主题的实际使用场景",
		"- word 和 phrase 的 example 必须原样包含所教的 text（大小写不限），例句要真正用到这个词",
		...(clozeItems > 0
			? ["- 教学项围绕同一主题组织（会话主题或雅思主题）：cloze 的句子可以自然复用本批次中 1-2 个刚教的单词或词组，形成一个统一的教学单元",
				`- 每个学习项必须互不重复；${wordItems} 个单词/词组项彼此独立，各自配一个小巧自然的例句`,
				"- cloze 是语法填空：一句英文恰好挖一个空（用 ___ 表示），空格后用括号给出所填词的原形提示，如 The fix that ___ (commit) this morning won't take effect.",
				"- cloze 的考点必须是明确的语法点（时态、语态、主谓一致、单复数、介词、冠词、非谓语、词形变化等），答案唯一且为最小形式",
				"- cloze 的句子必须在语法上锁死唯一答案：若同一个空存在多种语法正确的填法（如 isn't called 与 won't be called 都成立），必须加时间/语境锚点（如 once the migration finishes）排除歧义，否则换考点或改写句子",
				"- cloze 的 meaning 填正确答案（如 was committed）；text 只放挖空句，严禁在句尾附加 = was committed、→ was committed 等答案；example 填把答案代入后的完整正确句子；example_cn 填整句中文翻译，可附一句考点说明",
				`- cloze 的句子词数必须在 ${budget.wordRange[0]}-${budget.wordRange[1]} 之间，句法结构遵循预算的句法约束（见下方 difficulty_budget），句子必须真实自然`]
			: ["- 教学项围绕同一主题组织（会话主题或雅思主题），形成一个统一的教学单元",
				`- 每个学习项必须互不重复；${wordItems} 个单词/词组项彼此独立，各自配一个小巧自然的例句`]),
		"- word/phrase 的 meaning 写一个首选中文义项，并在同一题面用括号标出当前词性和能排除常见近义词的最小语境或搭配（格式如「一场具体的演出（可数名词，常与 give 搭配）」）；用途、效果、操作后果写进 example/example_cn，不得写进 meaning（反例：「重新加载，使新改动生效」应拆为 meaning「重新加载（动词，把最新内容再载入一次）」，作用说明放例句）；释义只给一个首选说法，不并列近义改写（应写「生效」而非「生效，起作用」），确有多个义项才用「；」并列",
		FORWARD_PROMPT_QUALITY,
		"- 若某个常用英文词/词组与本项 text 会对应同一个中文释义（如 book 与 reserve 都表示「预订」），meaning 必须补上可区分的义项或场景，不得与其它学习项或已学内容的中文释义完全相同",
		'- 只输出 JSON，不要任何其他文字：',
		`{"ready":true,"topic":"主题名","items":[${Array.from({ length: wordItems }, () => '{"type":"word|phrase","text":"单词或词组","phonetic":"/音标/","meaning":"中文释义（当前义项的中文词性，必要的消歧线索）","example":"英文例句","example_cn":"例句中文翻译"}').join(",")}${Array.from({ length: clozeItems }, () => ',{"type":"cloze","text":"含一个 ___ 的英文句子（空后括号给原形提示）","phonetic":"","meaning":"正确答案","example":"代入答案后的完整句子","example_cn":"整句中文翻译（可附考点说明）","chunks":["意群1","意群2","意群3"]}').join("")}]}`,
		...(clozeItems > 0 ? ["- cloze 必须带 chunks（2-6 个意群，按顺序拼接后覆盖代入答案后的完整句子）"] : []),
		"- 不要与已学内容重复（已学清单含释义；中文释义与已学词完全相同的也算重复），也要避开相同句型：" + (known.length ? known.join("、") : "（暂无已学内容）"),
		...(feedback && feedback.length
			? ["", "上一次备课被审查拒绝，请针对以下问题改进（不要原样重复被拒内容）：",
				...feedback.map((i) => `- [${i.severity}] ${i.category}: ${i.description}`)]
			: []),
		...(recentLog
			? ["", "最近出题与作答记录（新→旧，含题目快照与判定反馈）：", recentLog,
				"参考记录：学生近期答错的内容可换角度复现巩固；若反馈指向出题方式本身（如释义混入补充说明），避免同类出题。"]
			: []),
		"",
		formatAdaptiveBlock(ctxAdaptive.profile, budget),
		"",
		"<conversation>",
		conversation,
		"</conversation>",
	].join("\n");

	// Format errors (bad JSON / wrong shape) retry the SAME full-quality prompt
	// with the parse error attached; content difficulty and budget never change.
	const parseDecision = (text: string): LessonDecision => {
		const json = extractJsonObjectText(text);
		if (!json) throw new Error("BAD_JSON");
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(json);
		} catch {
			throw new Error("BAD_JSON");
		}
		if (parsed.ready === false) {
			if (forceGeneration) throw new Error("INVALID_READY");
			return {
				ready: false,
				reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
			};
		}
		if (parsed.ready !== true) throw new Error("INVALID_READY");
		if (!Array.isArray(parsed.items) || parsed.items.length !== wordItems + clozeItems) throw new Error("INVALID_LESSON_SHAPE");
		const parsedItems = parsed.items.map((item) => parseGeneratedItem(item));
		if (parsedItems.some((item) => item == null)) throw new Error("INVALID_LESSON_ITEM");
		const items = parsedItems as GeneratedItem[];
		// The word/phrase slots are homogeneous now: at least one word, phrases capped
		// (never above the batch size), sentence cards are legacy review-only.
		const wordCount = items.filter((item) => item.type === "word").length;
		const phraseCount = items.filter((item) => item.type === "phrase").length;
		const clozeCount = items.filter((item) => item.type === "cloze").length;
		if (wordCount + phraseCount !== wordItems || phraseCount > phraseCapFor(wordItems) || wordCount < 1) throw new Error("INVALID_LESSON_SHAPE");
		if (clozeCount !== clozeItems) throw new Error("INVALID_LESSON_SHAPE");
		// Grammar clozes are the dedicated slots now; sentences are legacy review-only.
		if (items.some((item) => item.type === "sentence")) throw new Error("INVALID_LESSON_SHAPE");
		if (items.filter((item) => item.type === "cloze").some((item) => !validClozeItem(item))) throw new Error("INVALID_LESSON_ITEM");
		// Reject in-batch duplicates early; the fingerprint unique index would
		// otherwise sink the whole commit at insertion time.
		const batchTexts = new Set(items.map((item) => item.text.trim().toLowerCase()));
		if (batchTexts.size !== items.length) throw new Error("INVALID_LESSON_ITEM");
		return { ready: true, topic: String(parsed.topic ?? ""), items };
	};

	let lastFormatError: unknown;
	for (let attempt = 0; attempt <= LESSON_FORMAT_RETRIES; attempt++) {
		const retryNote = attempt === 0 ? ""
			: `\n\n⚠ 上一次输出无法解析（${String((lastFormatError as Error)?.message ?? "")}）。请重新输出完整批次：只输出一个合法 JSON 对象（以 {"ready":true 开头且完整闭合），不要任何解释、markdown 代码围栏或多余文字，字符串正确转义。内容要求与难度预算保持不变。`;
		const text = await llm.complete(ctx, resolved, {
			systemPrompt: forceGeneration
				? "你是英语小宠物的备课助手，立即生成指定数量的新卡，只输出 JSON；主题信息不足时用基础词汇补足。"
				: "你是英语小宠物的备课助手，只输出 JSON；信息不足时宁可等待。",
			prompt: prompt + retryNote,
			thinkingLevel: config.thinkingLevel,
		});
		try {
			return parseDecision(text);
		} catch (err) {
			if (!isLessonFormatError(err)) throw err;
			lastFormatError = err;
		}
	}
	throw lastFormatError;
}

export interface CritiqueIssue {
	severity: "blocker" | "minor";
	category: string;
	description: string;
}

interface CritiqueVerdict {
	available: boolean;
	pass: boolean;
	issues: CritiqueIssue[];
	summary: string;
}

/**
 * Independent quality gate. Fail-closed on model/auth/runtime/bad-JSON errors
 * so a broken critic defers insertion rather than approving unreviewed content.
 */
export async function critiqueLesson(
	llm: PiSdkLlmClient,
	ctx: ExtensionContext,
	resolved: ResolvedModel,
	lesson: { topic: string; items: GeneratedItem[] },
	known: string[],
	config: PetConfig,
	adaptive?: AdaptiveContext,
	composition?: LessonBatch | null,
): Promise<CritiqueVerdict> {
	const failClosed = (summary: string): CritiqueVerdict => ({ available: false, pass: false, issues: [], summary });
	const ctxAdaptive = adaptive ?? { profile: coldStartProfile(), budget: deriveBudget(coldStartProfile()) };
	const budget = ctxAdaptive.budget;

	// Deterministic objective gate: cloze structure and sentence word count must
	// respect the budget, and the batch must stay words-majority. This fails before
	// any LLM call so an out-of-budget or malformed item can never be approved,
	// regardless of the model critic's verdict.
	const budgetBlockers: CritiqueIssue[] = [];
	const phraseCount = lesson.items.filter((item) => item.type === "phrase").length;
	// composition === null marks a user-customized batch: no fixed composition to
	// enforce, per-item quality checks below still apply in full.
	const compositionBatch = composition ?? DEFAULT_LESSON_BATCH;
	if (composition !== null &&
		lesson.items.length === compositionBatch.wordItems + compositionBatch.clozeItems &&
		phraseCount > phraseCapFor(compositionBatch.wordItems)) {
		budgetBlockers.push({
			severity: "blocker",
			category: "composition",
			description: `词组数量 ${phraseCount} 超过单词为主的批次上限 ${phraseCapFor(compositionBatch.wordItems)}，请减词组换单词`,
		});
	}
	for (const item of lesson.items) {
		if (item.type === "cloze") {
			if (!validClozeItem(item)) {
				budgetBlockers.push({
					severity: "blocker",
					category: "structure",
					description: "语法填空必须恰好包含一个 ___ 且答案（meaning）非空",
				});
				continue;
			}
			const base = (item.example || item.text).replace(/___/g, " x ").replace(/\s*\([^)]*\)/g, "");
			const words = base.trim().split(/\s+/).filter(Boolean).length;
			const [clozeMin, clozeMax] = budget.wordRange;
			if (words < clozeMin || words > clozeMax) {
				budgetBlockers.push({
					severity: "blocker",
					category: "budget",
					description: `语法填空句词数 ${words} 不在预算区间 [${clozeMin}, ${clozeMax}] 内`,
				});
			}
		}
		if (item.type !== "sentence") continue;
		const words = item.text.trim().split(/\s+/).filter(Boolean).length;
		const [minWords, maxWords] = budget.wordRange;
		if (words < minWords || words > maxWords) {
			budgetBlockers.push({
				severity: "blocker",
				category: "budget",
				description: `句子词数 ${words} 不在预算区间 [${minWords}, ${maxWords}] 内`,
			});
		}
		if (item.keyWords && item.keyWords.length > budget.maxKeyWords) {
			budgetBlockers.push({
				severity: "blocker",
				category: "budget",
				description: `生词数 ${item.keyWords.length} 超过预算上限 ${budget.maxKeyWords}`,
			});
		}
	}
	// Two word/phrase items with the same Chinese meaning create an
	// underdetermined forward prompt, so reject before consulting the critic.
	const seenMeanings = new Map<string, string>();
	for (const item of lesson.items) {
		if (item.type !== "word" && item.type !== "phrase") continue;
		// Require a visible Chinese part-of-speech label independently of the model.
		// Keep the general parser compatible with existing stored cards.
		if (!meaningHasVisiblePos(item.meaning)) {
			budgetBlockers.push({
				severity: "blocker",
				category: "sense",
				description: `「${item.text}」的中文题面缺少明确词性，请在 meaning 的括号中标注当前义项的名词、动词、形容词或动词短语等中文词性，并保留必要消歧线索；不能仅在例句或判分反馈中解释`,
			});
		} else if (!meaningHasForwardSenseClue(item.meaning)) {
			budgetBlockers.push({
				severity: "blocker",
				category: "sense",
				description: `「${item.text}」的中文题面只有词性、缺少能排除近义词的语境或搭配，请写成「义项（词性，语境或搭配）」；不能只写「表演」或「表演（名词）」，也不能把语境留到例句或判分反馈`,
			});
		}
		const alternatives = knownForwardAlternatives(item);
		if (alternatives.length && (!hasMatchingSpellingTarget(item) || !forwardCue(item as ItemRow)?.context)) {
			budgetBlockers.push({
				severity: "blocker",
				category: "sense",
				description: `「${item.text}」的泛指目标题面仍可回答 ${alternatives.join(" / ")}；「希望达到/达成的结果」「想要实现的事情」只是释义复述，不能当消歧证据。请换学习项，或在 meaning 明确写与目标匹配的首字母和字母数，并补真实场景及能遮住目标的例句；不得编造这些词不能互换的区别`,
			});
		}
		const key = normalizeMeaning(item.meaning);
		const firstText = seenMeanings.get(key);
		if (firstText != null) {
			budgetBlockers.push({
				severity: "blocker",
				category: "dup",
				description: `「${firstText}」与「${item.text}」的中文释义完全相同（${item.meaning.trim()}），请给出可区分的义项或场景限定`,
			});
		} else {
			seenMeanings.set(key, item.text);
		}
	}
	if (budgetBlockers.length) {
		return {
			available: true,
			pass: false,
			issues: budgetBlockers,
			summary: "确定性质量检查未通过（难度预算、批次重复或题面消歧）",
		};
	}

	// Pass the complete bounded lesson structure (not just an outline) so the critic
	// can judge examples, levels, chunks, and keywords.
	const lessonJson = JSON.stringify(lesson);
	const forwardAudit = lesson.items.filter(item => item.type === "word" || item.type === "phrase").map(item => ({
		target: item.text,
		visibleMeaning: item.meaning,
		maskedExample: forwardCue(item as ItemRow)?.context ?? null,
		knownAlternatives: knownForwardAlternatives(item),
		explicitSpellingTarget: hasMatchingSpellingTarget(item),
	}));

	const prompt = [
		"你是「英语小宠物」的内容审查员。审查下面备课是否适合当前学习者水平，只输出 JSON。",
		'{"pass": true/false, "issues": [{"severity":"blocker|minor","category":"fact|sense|dup|translation|natural|progression|budget","description":"..."}], "summary":"一句话"}',
		"审查标准：",
		"- 英语单词/词组/句子必须正确、自然",
		"- 词汇难度须符合画像「词汇层次」：雅思来源的词必须是入门/基础段常用核心词，生僻学术词、低频难词记 blocker；但会话来源的词（工作场景立即能用/能理解的）不受词汇层次限制，不得因偏难而拒收",
		...(composition === null
			? ["- 批次组成：用户定制批次，类型限 word/phrase/cloze，数量按用户提示词；同批学习项之间不得重复或近乎重复；违反记 blocker"]
			: [`- 批次组成：${compositionBatch.wordItems} 个单词/词组项以单词为主（词组不超过 ${phraseCapFor(compositionBatch.wordItems)} 个）${compositionBatch.clozeItems > 0 ? ` 加 ${compositionBatch.clozeItems > 1 ? compositionBatch.clozeItems + " 个语法填空" : "1 个语法填空"}` : ""}；同批学习项之间不得重复或近乎重复；违反记 blocker`]),
		"- cloze 语法填空：___ 空格恰好一个且挖在真正的语法点上；括号原形提示与考点一致；meaning 答案唯一且为最小形式，代入后句子语法正确；若同一空存在其他语法正确的填法（时态/语态歧义）记 blocker；example 必须是代入答案后的完整句子；chunks 必须是 2-6 个意群且拼接覆盖完整句子；违反记 blocker",
		"- 中文释义准确，不得机翻味",
		"- word/phrase 的 meaning 写一个首选中文义项，并在同一题面用括号标出当前词性和能排除常见近义词的最小语境或搭配；不得把目的/效果写进 meaning（反例：「重新加载，使新改动生效」应写成「重新加载（动词，把最新内容再载入一次）」并把作用放例句），也不得并列近义改写（「生效，起作用」应只写「生效」）；违反记 blocker",
		"- 每张 word/phrase 的 meaning 缺少明确中文词性、词性与当前义项或例句不符，或只写「词组」等无法区分词类的标签，均记 sense blocker；不能根据隐藏 text 或例句猜出词性后放行。communicate / communication 仅提示「交流」必须拦截，并要求补动词 / 名词；名词、动词等词性线索属于必要题面，不属于冗余说明。",
		"- word/phrase 的 example 必须原样包含所教 text（大小写不限）；违反记 blocker",
		"- word/phrase 的中文释义与批内其它学习项或已学内容完全相同时（如 book 与 reserve 都是「预订」），必须给出可区分的义项或场景限定，否则记 blocker",
		FORWARD_PROMPT_QUALITY,
		"- 逐项模拟只看题面作答，主动寻找其它合理近义答案（包括未入库的词）：information 只给「信息/消息」、performance 只给「表演」，或仅有词性没有语境/搭配，记 sense blocker。不能因本批没有 message / show 就放行；不能把必需的消歧限定误判为冗余。问题说明须写出具体替代答案和应补充的线索。",
		"- 不得与已学内容重复：" + (known.length ? known.join("、") : "（暂无）"),
		`- cloze 句子须符合预算（词数 ${budget.wordRange[0]}-${budget.wordRange[1]}，句法结构遵循 difficulty_budget）；cloze 句子可以自然复用批次中 1-2 个单词或词组`,
		"- 不得为凑结构硬造不自然句子",
		"- 对 forward_audit 每一项执行同词性替换检验：列出常见候选，逐个代入 visibleMeaning 和 maskedExample。knownAlternatives 仅给已知反例，空列表绝不表示没有近义词；必须独立寻找候选。不能因为词性齐全、括号更长或另一候选未入库就 pass。若例句仍可替换，要求真实前置语境并明确首字母/词长学习目标，或换词/练习；不得伪造语义互斥。",
		"- maskedExample 为 null 表示未能安全遮住实际目标，不能声称已有挖空语境。例句和中文翻译须真实相符且提供实际场景；即使 explicitSpellingTarget 为 true，也必须继续审查事实、搭配自然性及题面是否说明真实场景，这个布尔值不是语义唯一证明。",
		"- 只有明确问题才标 blocker；小瑕疵标 minor",
		"",
		formatAdaptiveBlock(ctxAdaptive.profile, budget),
		"",
		`<lesson>${lessonJson}</lesson>`,
		`<forward_audit>${JSON.stringify(forwardAudit)}</forward_audit>`,
	].join("\n");

	let text: string;
	try {
		text = await llm.complete(ctx, resolved, {
			systemPrompt: "你是英语教学内容审查员，只输出 JSON。",
			prompt,
			thinkingLevel: config.thinkingLevel,
		});
	} catch {
		return failClosed("critic call failed");
	}

	const json = extractJsonObjectText(text);
	if (!json) return failClosed("critic bad json");
	try {
		const parsed = JSON.parse(json) as { pass?: unknown; issues?: unknown; summary?: unknown };
		return {
			available: true,
			pass: parsed.pass === true,
			issues: Array.isArray(parsed.issues) ? (parsed.issues as CritiqueIssue[]).slice(0, 20) : [],
			summary: typeof parsed.summary === "string" ? parsed.summary : "",
		};
	} catch {
		return failClosed("critic unparseable");
	}
}

export interface AnswerEvaluation {
	available: boolean;
	verdict: "correct" | "partial" | "incorrect";
	feedback: string;
}

/**
 * LLM evaluation for a near-miss answer. `questionText` is the prompt the
 * learner actually saw, so a bare Chinese cue accepts valid synonyms while a
 * target-specific cue remains strict.
 */
export async function evaluateAttempt(
	llm: PiSdkLlmClient,
	ctx: ExtensionContext,
	item: ItemRow,
	answer: string,
	resolved: { provider: string; model: string } | undefined,
	direction: "forward" | "reverse" = "forward",
	questionText?: string,
): Promise<AnswerEvaluation> {
	const unavailable = (): AnswerEvaluation => ({ available: false, verdict: "incorrect", feedback: "" });
	if (!resolved) return unavailable();
	const isCloze = item.type === "cloze";
	const isReverse = direction === "reverse";
	// A reverse prompt that carries the card's example sentence pins the target
	// sense; the bare legacy prompt cannot, so it must accept any common sense.
	const reverseContextual = isReverse && questionHasReverseContext(questionText);
	const target = isCloze ? item.meaning : isReverse ? item.meaning : item.text;
	const answerLang = isReverse ? "中文" : "英文";
	const shownQuestion = !isCloze && (!isReverse || reverseContextual) ? questionText : undefined;
	const cuePresent = questionHasForwardCue(shownQuestion);
	const rubric = isCloze
		? [
			"- correct: 与目标答案完全一致，或仅大小写差异",
			"- partial: 语法形式接近但有错误（如漏助动词、时态/单复数/拼写错），如目标 was committed 写成 was commit",
			"- incorrect: 不同的词、空白或语言错误；语义相同但语法形式不同的答案不算对",
		]
		: isReverse
		? reverseContextual
			? [
				"- correct: 中文意思与目标释义一致即可；同义表达、简写/全称、语体差异（如“已”与“已经”）都算对，措辞不必逐字相同",
				"- meaning 括号中的词性、可数性等出题提示不要求学生复述；【动词】等前缀标签同样无需复述；只答出符合题面语境的核心中文意思即可，不得因省略这些提示判 partial 或 incorrect（如 information 答「信息」）。真正改变词义的语义差异仍按题面判断。",
				"- 目标释义并列的多个说法若互为近义（如「生效，起作用」），答出任一近义说法即为 correct",
				"- 题面例句已经限定目标义项：答案必须是这个词在题面例句语境中的意思；不符合本句的其它常见义项，应判 incorrect（如 work 在「The settings work」中答「工作」）",
				"- partial: 意思基本正确，但有明显遗漏或偏差",
				"- incorrect: 意思错误、空白、语言错误、无法识别，或答的是题面例句之外的义项",
			]
			: [
				"- 题面没有提供义项语境，无法唯一确定目标义项：任一常见且成立的中文义项都算 correct，不得因与目标释义不同而判错",
				"- correct: 中文意思与该词任一常见义项一致即可；同义表达、简写/全称、语体差异都算对",
				"- meaning 括号中的词性、可数性等出题提示不要求学生复述；【动词】等前缀标签同样无需复述；只答出符合题面语境的核心中文意思即可，不得因省略这些提示判 partial 或 incorrect（如 information 答「信息」）。真正改变词义的语义差异仍按题面判断。",
				"- 目标释义并列的多个说法若互为近义（如「生效，起作用」），答出任一近义说法即为 correct",
				"- partial: 意思基本正确，但有明显遗漏或偏差；遗漏仅指漏掉并列的不同义项（如「银行」与「河岸」只答出其一）",
				"- incorrect: 意思错误、空白、语言错误或无法识别",
			]
		: cuePresent
		? [
			"- correct: 英文与目标完全一致，或仅大小写/标点/多余空格差异，且满足题面的首字母/语境线索",
			`- 题面线索已唯一指向目标「${target}」：不满足线索的答案（如首字母不符、与语境例句矛盾）即使中文意思相同也不是 correct`,
			"- partial: 英文有小错（拼写/字形），但明显是想写这个目标词",
			"- incorrect: 完全不同的意思、空白、语言错误或无法识别",
		]
		: [
			"- correct: 英文与目标一致；如果题面只有中文、没有唯一指定英文词，任何一个自然且完全符合该中文提示的英文单词/词组都算对（如 book 与 reserve 都可表示「预订」）",
			`- 同义答案判 correct 时，反馈须点明本题目标是「${target}」并简要区分常见说法`,
			"- partial: 英文有小错（拼写/字形），但明显是想写这个目标词",
			"- incorrect: 完全不同的意思、空白、语言错误或无法识别",
		];
	const prompt = [
		isCloze
			? "你是英语导师。学生要做语法填空，写出空格处正确的语法形式。"
			: `你是英语导师。学生看到${isReverse ? "英文" : "中文"}要写出对应的${answerLang}。`,
		...(isCloze ? [`填空句：${item.text}`] : []),
		...(shownQuestion ? [`题面（按题面判分）：${shownQuestion}`] : []),
		`目标：${target}`,
		`学生写了：${answer}`,
		"判断学生的答案，只输出 JSON：",
		'{"verdict":"correct|partial|incorrect","feedback":"简短中文反馈，指出最小问题"}',
		`- 学生必须用${answerLang}作答；写错语言一律 incorrect`,
		...rubric,
	].join("\n");
	let text: string;
	try {
		text = await llm.complete(ctx, resolved, {
			systemPrompt: "你是英语拼写/词义评价员，只输出 JSON。",
			prompt,
		});
	} catch {
		return unavailable();
	}
	const json = extractJsonObjectText(text);
	if (!json) return unavailable();
	try {
		const parsed = JSON.parse(json) as { verdict?: unknown; feedback?: unknown };
		const verdict = parsed.verdict === "correct" ? "correct" : parsed.verdict === "partial" ? "partial" : "incorrect";
		return { available: true, verdict, feedback: typeof parsed.feedback === "string" ? parsed.feedback : "" };
	} catch {
		return unavailable();
	}
}

export interface SentenceEvaluation extends AnswerEvaluation {
	available: boolean;
	errorTags: string[];
	correctedAnswer: string;
}

/** Semantic sentence-output evaluation. Provider failures leave the card pending with zero writes. */
export async function evaluateSentenceAttempt(
	llm: PiSdkLlmClient,
	ctx: ExtensionContext,
	exercise: SentenceExerciseView,
	answer: string,
	resolved: { provider: string; model: string } | undefined,
): Promise<SentenceEvaluation> {
	const unavailable = (): SentenceEvaluation => ({
		available: false,
		verdict: "incorrect",
		feedback: "",
		errorTags: [],
		correctedAnswer: "",
	});
	const normalize = (value: string) => value
		.toLowerCase()
		.replace(/[’]/g, "'")
		.replace(/[^a-z0-9']+/g, " ")
		.trim()
		.replace(/\s+/g, " ");
	const normalizedAnswer = normalize(answer);
	if (
		normalizedAnswer === normalize(exercise.expected) ||
		(exercise.kind === "sentence_cloze" && normalizedAnswer === normalize(exercise.reference))
	) {
		return { available: true, verdict: "correct", feedback: "", errorTags: [], correctedAnswer: exercise.reference };
	}
	if (!resolved) return unavailable();
	const task = exercise.kind === "sentence_cloze"
		? [
			"这是单词填空。学生可以只写缺失词，也可以写完整句子。",
			`缺失词：${exercise.expected}`,
			`填空句：${exercise.cloze}`,
		]
		: [
			"这是开放式中文到英文产出。不要要求与参考句逐字相同。",
			`中文意图：${exercise.chinese}`,
			`参考表达：${exercise.reference}`,
			...(exercise.focusExpression ? [`建议目标表达：${exercise.focusExpression}`] : []),
		];
	const prompt = [
		"你是严格但鼓励性的英语写作导师。评价学生英文，只输出 JSON。",
		...task,
		`学生答案：${answer}`,
		'输出：{"verdict":"correct|partial|incorrect","feedback":"一个最小中文修正","errorTags":["grammar|collocation|meaning|missing_target|word_order|spelling|preposition|tense|article|word_choice"],"correctedAnswer":"自然修正版"}',
		"errorTags 只能从上面列表中选择，拿不准就用 other。",
		"correct：语义满足中文意图且英文自然；自然变体应接受。",
		"partial：意图基本正确，仅有一个或少量可修正问题。",
		"incorrect：核心意思错误、无法理解、写成中文，或填空目标明显错误。",
		"feedback 只指出当前最关键的一个问题，不要长篇讲解。",
	].join("\n");
	let text: string;
	try {
		text = await llm.complete(ctx, resolved, {
			systemPrompt: "你是英语输出评价员，只输出严格 JSON。",
			prompt,
		});
	} catch {
		return unavailable();
	}
	const json = extractJsonObjectText(text);
	if (!json) return unavailable();
	try {
		const parsed = JSON.parse(json) as Record<string, unknown>;
		const verdict = parsed.verdict === "correct" ? "correct" : parsed.verdict === "partial" ? "partial" : "incorrect";
		const errorTags = Array.isArray(parsed.errorTags)
			? [...new Set(parsed.errorTags.filter((tag): tag is string => typeof tag === "string").map((tag) => normalizeErrorTag(tag)))].slice(0, 5)
			: [];
		return {
			available: true,
			verdict,
			feedback: typeof parsed.feedback === "string" ? parsed.feedback : "",
			errorTags,
			correctedAnswer: typeof parsed.correctedAnswer === "string" ? parsed.correctedAnswer : exercise.reference,
		};
	} catch {
		return unavailable();
	}
}

export async function generateReplacement(
	llm: PiSdkLlmClient,
	ctx: ExtensionContext,
	resolved: ResolvedModel,
	conversation: string,
	known: string[],
	config: PetConfig,
	skipped: ItemRow,
	adaptive?: AdaptiveContext,
	recentLog?: string,
	// basicFallback: last-resort easiest-word replacement after critic rejection.
	basicFallback = false,
): Promise<ReplacementDecision> {
	const ctxAdaptive = adaptive ?? { profile: coldStartProfile(), budget: deriveBudget(coldStartProfile()) };
	const budget = ctxAdaptive.budget;
	const isCloze = skipped.type === "cloze";
	const itemSchema = isCloze
		? '{"type":"cloze","text":"含一个 ___ 的英文句子（空后括号给原形提示）","phonetic":"","meaning":"正确答案","example":"代入答案后的完整句子","example_cn":"整句中文翻译（可附考点说明）","chunks":["意群1","意群2","意群3"]}'
		: `{"type":"${skipped.type}","text":"${skipped.type === "word" ? "单词" : "词组"}","phonetic":"/音标/","meaning":"中文释义（当前义项的中文词性，必要的消歧线索）","example":"英文例句","example_cn":"例句翻译"}`;
	const prompt = [
		`用户刚把 ${skipped.type} 卡片「${skipped.text} = ${skipped.meaning}」标记为已经很熟，且用户正在备考雅思。`,
		`请补充 1 张新的 ${skipped.type} 卡片，不能与已有内容重复。`,
		basicFallback
			? "本次为基础兜底补卡：直接选择英语初学者最基础的高频日常词汇（CEFR A1-A2 必会词），不要求与会话相关，也不受雅思线与画像难度约束；学习者很可能已经会——没关系，会了可以跳过。"
			: "优先从下面会话中提取真实表达（会话来源的词不受词汇层次限制，工作场景立即能用、马上能理解的词照常提取）；会话没有合适内容时，从雅思入门/基础段（约 4.0-5.5 分，A2-B1）的高频常用核心词汇中选择同类型卡片，学习者是初学者，雅思来源禁止生僻学术词、低频难词，不要因为会话缺乏英语内容而拒绝。",
		"只有完全无法生成时才输出：{\"ready\":false,\"reason\":\"简短原因\"}。",
		"信息充分时只输出：",
		`{"ready":true,"item":${itemSchema}}`,
		isCloze
			? `语法填空要求：恰好一个 ___、空后括号给原形提示、考点是明确的语法点且答案唯一；meaning 填正确答案的最小形式，text 只放挖空句且句尾不得附加 = 答案或 → 答案，example 是代入答案后的完整句子，chunks 是覆盖完整句子的 2-6 个意群，句子词数在 ${budget.wordRange[0]}-${budget.wordRange[1]} 之间且自然真实。`
			: "内容要真实常用：会话来源的贴近当前会话语境，雅思来源的选自雅思高频词表，难度贴合下面的画像与预算；meaning 写一个首选中文义项，并在同一题面用括号标出当前词性和能排除常见近义词的最小语境或搭配，只给一个首选说法、不并列近义改写，用途/效果说明放 example/example_cn；example 必须原样包含所教 text（大小写不限）；若某个常用英文词/词组与本项共用同一中文释义（如 book 与 reserve 都表示「预订」，performance 与 show 都表示「表演」），meaning 必须补上可区分的义项或场景。",
		...(isCloze ? [] : [FORWARD_PROMPT_QUALITY]),
		"已有内容：" + (known.length ? known.join("；") : "（无）"),
		...(recentLog
			? ["", "最近出题与作答记录（新→旧）：", recentLog, "避免重复近期刚练过的内容；若反馈指向出题缺陷，避免同类出题。"]
			: []),
		"",
		formatAdaptiveBlock(ctxAdaptive.profile, budget),
		"",
		"<conversation>",
		conversation,
		"</conversation>",
	].join("\n");
	// Same-model retry loop: transient output-shape errors (mostly truncated or
	// unparseable JSON) get an immediate retry before the caller's model fallback.
	for (let attempt = 0; ; attempt++) {
		const text = await llm.complete(ctx, resolved, {
			systemPrompt: "你是英语学习卡生成器，只输出 JSON；信息不足时宁可等待。",
			prompt,
			thinkingLevel: config.thinkingLevel,
		});
		try {
			return parseReplacementDecision(text, skipped.type);
		} catch (err) {
			if (attempt >= REPLACEMENT_SHAPE_RETRIES || !isTransientShapeError(err)) throw err;
		}
	}
}

function parseReplacementDecision(text: string, expectedType: GeneratedItem["type"]): ReplacementDecision {
	const json = extractJsonObjectText(text);
	if (!json) throw new Error("BAD_JSON");
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(json);
	} catch {
		throw new Error("BAD_JSON");
	}
	if (parsed.ready === false) {
		return { ready: false, reason: typeof parsed.reason === "string" ? parsed.reason : undefined };
	}
	if (parsed.ready !== true) throw new Error("INVALID_READY");
	const item = parseGeneratedItem(parsed.item, expectedType);
	if (!item) throw new Error("EMPTY_REPLACEMENT");
	return { ready: true, item };
}

// -- /anki:add custom card generation ---------------------------------------

export type CustomCardsDecision =
	| { ready: true; items: GeneratedItem[] }
	| { ready: false; reason?: string };

/**
 * Make cards from a user-supplied prompt (types: word/phrase/cloze only).
 * Card count follows the prompt, defaulting to 5, clamped to MAX_CUSTOM_PER_ADD.
 */
export async function generateCustomCards(
	llm: PiSdkLlmClient,
	ctx: ExtensionContext,
	resolved: ResolvedModel,
	userPrompt: string,
	known: string[],
	config: PetConfig,
	adaptive?: AdaptiveContext,
	feedback?: CritiqueIssue[],
): Promise<CustomCardsDecision> {
	const ctxAdaptive = adaptive ?? { profile: coldStartProfile(), budget: deriveBudget(coldStartProfile()) };
	const budget = ctxAdaptive.budget;
	const prompt = [
		"用户想按下面的提示词定制学习卡。学习者正在备考雅思。",
		`卡片类型限 word（单词）、phrase（词组）、cloze（语法填空）；数量按提示词理解，未写明数量时做 5 张；单次最多 ${MAX_CUSTOM_PER_ADD} 张，提示词要求更多时只做最重要的前 ${MAX_CUSTOM_PER_ADD} 张。`,
		"提示词完全无法解读时才输出：{\"ready\":false,\"reason\":\"简短原因\"}",
		"信息充分时只输出 JSON，不要任何其他文字：",
		`{"ready":true,"items":[{"type":"word|phrase","text":"单词或词组","phonetic":"/音标/","meaning":"中文释义（当前义项的中文词性，必要的消歧线索）","example":"英文例句","example_cn":"例句中文翻译"},{"type":"cloze","text":"含一个 ___ 的英文句子（空后括号给原形提示）","phonetic":"","meaning":"正确答案","example":"代入答案后的完整句子","example_cn":"整句中文翻译（可附考点说明）","chunks":["意群1","意群2","意群3"]}]}`,
		"内容要求：",
		"- 内容要真实常用、贴合提示词的意图，难度贴合下面的画像与预算",
		"- word 和 phrase 的例句短小自然，贴近提示词的实际使用场景",
		"- cloze 是语法填空：一句英文恰好挖一个空（用 ___ 表示），空后括号给所填词的原形提示；考点必须是明确的语法点，答案唯一且为最小形式；meaning 填正确答案，text 只放挖空句，严禁句尾附加 = 答案；example 是代入答案后的完整句子，example_cn 填整句中文翻译；chunks 是 2-6 个按顺序拼接覆盖完整句子的意群",
		`- cloze 的句子词数必须在 ${budget.wordRange[0]}-${budget.wordRange[1]} 之间，句法结构遵循预算的句法约束（见下方 difficulty_budget），句子必须真实自然；提示词只要词汇时可不用 cloze`,
		"- word/phrase 的 meaning 写一个首选中文义项，并在同一题面用括号标出当前词性和能排除常见近义词的最小语境或搭配；用途、效果等补充说明写进 example/example_cn，不得混入 meaning；释义只给一个首选说法，不并列近义改写，确有多个义项才用「；」并列",
		"- word/phrase 的 example 必须原样包含所教的 text（大小写不限），例句要真正用到这个词",
		FORWARD_PROMPT_QUALITY,
		"- 若某个常用英文词/词组与本项 text 共用同一中文释义（如 book 与 reserve 都表示「预订」），meaning 必须补上可区分的义项或场景，不得与本批其它卡或已有内容的中文释义完全相同",
		"- 每张卡互不重复，也不得与已有内容重复：" + (known.length ? known.join("、") : "（暂无）"),
		...(feedback && feedback.length
			? ["", "上一次制卡被审查拒绝，请针对以下问题改进（不要原样重复被拒内容）：",
				...feedback.map((i) => `- [${i.severity}] ${i.category}: ${i.description}`)]
			: []),
		"",
		formatAdaptiveBlock(ctxAdaptive.profile, budget),
		"",
		"<user_request>",
		userPrompt,
		"</user_request>",
	].join("\n");

	const text = await llm.complete(ctx, resolved, {
		systemPrompt: "你是英语学习卡生成器，只输出 JSON；信息不足时宁可等待。",
		prompt,
		thinkingLevel: config.thinkingLevel,
	});

	const json = extractJsonObjectText(text);
	if (!json) throw new Error("BAD_JSON");
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(json);
	} catch {
		throw new Error("BAD_JSON");
	}
	if (parsed.ready === false) {
		return { ready: false, reason: typeof parsed.reason === "string" ? parsed.reason : undefined };
	}
	if (parsed.ready !== true) throw new Error("INVALID_READY");
	if (!Array.isArray(parsed.items) || parsed.items.length < 1) throw new Error("INVALID_CUSTOM_SHAPE");
	const items: GeneratedItem[] = [];
	for (const raw of parsed.items) {
		const item = parseGeneratedItem(raw);
		if (!item || item.type === "sentence") throw new Error("INVALID_CUSTOM_ITEM");
		if (item.type === "cloze" && !validClozeItem(item)) throw new Error("INVALID_CUSTOM_ITEM");
		items.push(item);
	}
	const texts = new Set(items.map((item) => item.text.trim().toLowerCase()));
	if (texts.size !== items.length) throw new Error("INVALID_CUSTOM_ITEM");
	return { ready: true, items: items.slice(0, MAX_CUSTOM_PER_ADD) };
}
