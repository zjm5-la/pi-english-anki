import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PetConfig } from "../config.ts";
import type { ItemRow } from "../db.ts";
import type { PiSdkLlmClient } from "../pi-sdk-llm.ts";
import { critiqueLesson, evaluateAttempt, generateCustomCards, generateLesson, generateReplacement } from "../llm.ts";

const ctx = {} as ExtensionContext;
const config = { thinkingLevel: "off" } as PetConfig;
const resolved = { provider: "test", model: "test", fromSession: false } as const;
const skipped = { type: "word", text: "apple", meaning: "苹果" } as ItemRow;

function capture(response: unknown = { ready: false, reason: "test" }) {
	const prompts: string[] = [];
	const llm = { complete: async (_ctx: unknown, _resolved: unknown, request: { prompt: string }) => {
		prompts.push(request.prompt);
		return JSON.stringify(response);
	} } as unknown as PiSdkLlmClient;
	return { llm, prompts };
}

test("every vocabulary generation path disambiguates before answering, including both basic fallbacks", async () => {
	const { llm, prompts } = capture();
	await generateLesson(llm, ctx, resolved, "", [], config);
	await generateLesson(llm, ctx, resolved, "", [], config, undefined, undefined, undefined, undefined, true);
	await generateReplacement(llm, ctx, resolved, "", [], config, skipped);
	await generateReplacement(llm, ctx, resolved, "", [], config, skipped, undefined, undefined, true);
	await generateCustomCards(llm, ctx, resolved, "information", [], config);
	assert.equal(prompts.length, 5);
	for (const prompt of prompts) {
		assert.match(prompt, /必须在作答前就给足线索/);
		assert.match(prompt, /每张 word\/phrase 的 meaning 都必须明确标注当前所考义项的中文词性/);
		assert.match(prompt, /词组标注动词短语、名词短语/);
		assert.match(prompt, /communicate 应写「交流（动词/);
		assert.match(prompt, /communication 应写「交流（名词/);
		assert.match(prompt, /词性只解决词类歧义，同词性的近义词仍须补必要的义项或搭配线索/);
		assert.match(prompt, /学生只看到 meaning，不能假设例句挖空或首字母已经显示/);
		assert.match(prompt, /隐藏 text 和 example 后/);
		assert.match(prompt, /即使其它近义词未入库、中文写法不同/);
		assert.match(prompt, /词性、可数\/不可数、义项范围或自然搭配/);
		assert.match(prompt, /information 不可只提示「信息\/消息」/);
		assert.match(prompt, /信息（不可数名词，泛指事实或资料）/);
		assert.match(prompt, /performance 不可只提示「表演」/);
		assert.match(prompt, /一场具体的演出（可数名词，常与 give 搭配/);
		assert.match(prompt, /不能虚构近义词之间并不存在的区别/);
		assert.match(prompt, /仍有多个同样自然且满足线索的常见答案，必须将必要限定写进 meaning/);
		assert.doesNotMatch(prompt, /只写最小中文释义（直接翻译）/);
	}
});

test("both reverse rubrics accept core meanings without repeating disambiguation metadata", async () => {
	const { llm, prompts } = capture({ verdict: "correct", feedback: "正确" });
	const item = { type: "word", text: "information", meaning: "信息（不可数名词，泛指事实或资料）", example: "We need more information about the course." } as ItemRow;
	for (const question of [
		"写出单词「information」的中文释义",
		"在例句「We need more information about the course.」中，单词「information」是什么意思？",
	]) {
		const result = await evaluateAttempt(llm, ctx, item, "信息", resolved, "reverse", question);
		assert.equal(result.verdict, "correct");
	}
	assert.equal(prompts.length, 2);
	for (const prompt of prompts) {
		assert.match(prompt, /词性、可数性等出题提示不要求学生复述/);
		assert.match(prompt, /【动词】等前缀标签同样无需复述/);
		assert.match(prompt, /不得因省略这些提示判 partial 或 incorrect/);
		assert.match(prompt, /真正改变词义的语义差异仍按题面判断/);
	}
});

test("critic checks an isolated information card against out-of-inventory synonyms", async () => {
	const { llm, prompts } = capture({ pass: false, issues: [{ severity: "blocker", category: "sense", description: "message 也是信息，应补不可数与事实资料的限定" }], summary: "题面不明确" });
	const result = await critiqueLesson(llm, ctx, resolved, {
		topic: "词汇", items: [{ type: "word", text: "information", meaning: "信息（不可数名词，泛指内容）", example: "We need more information about the course.", example_cn: "我们需要更多有关这门课程的信息。" }],
	}, [], config, undefined, null);
	assert.equal(prompts.length, 1, "single-card semantic ambiguity reaches the model critic even with an empty inventory");
	assert.match(prompts[0], /不能因本批没有 message \/ show 就放行/);
	assert.match(prompts[0], /记 sense blocker/);
	assert.match(prompts[0], /不能把必需的消歧限定误判为冗余/);
	assert.equal(result.pass, false);
	assert.equal(result.issues[0].category, "sense");
});


test("critic deterministically rejects missing or vague part of speech even if the model would pass", async () => {
	for (const [type, meaning] of [["word", "交流"], ["word", "代名词解释"], ["word", "交流（单词）"], ["phrase", "交流（词组）"]] as const) {
		const { llm, prompts } = capture({ pass: true, issues: [], summary: "ok" });
		const result = await critiqueLesson(llm, ctx, resolved, {
			topic: "交流", items: [{ type, text: "communicate", meaning, example: "We communicate with each other every day.", example_cn: "我们每天都互相交流。" }],
		}, [], config, undefined, null);
		assert.equal(prompts.length, 0, "missing visible part of speech cannot be waived by the model");
		assert.equal(result.pass, false);
		assert.equal(result.issues[0].severity, "blocker");
		assert.equal(result.issues[0].category, "sense");
		assert.match(result.issues[0].description, /meaning 的括号中标注当前义项/);
	}
});

test("critic admits explicit word and phrase labels for semantic review", async () => {
	for (const pos of ["动词", "动词过去分词", "动词现在分词", "不可数名词", "可数名词", "复数名词", "单数名词", "专有名词", "集合名词", "普通名词", "不及物动词", "形容词", "副词", "介词", "代词", "连词", "数词", "冠词", "感叹词", "情态动词", "动词短语", "名词短语"]) {
		const { llm, prompts } = capture({ pass: true, issues: [], summary: "ok" });
		const result = await critiqueLesson(llm, ctx, resolved, {
			topic: "词性", items: [{ type: pos.endsWith("短语") ? "phrase" : "word", text: "sample", meaning: pos === "动词" ? "【动词】交流（指与他人交换信息或想法）" : `释义（${pos}，义项线索）` }],
		}, [], config, undefined, null);
		assert.equal(prompts.length, 1, pos);
		assert.equal(result.pass, true, pos);
		assert.match(prompts[0], /meaning 缺少明确中文词性、词性与当前义项或例句不符/);
		assert.match(prompts[0], /均记 sense blocker/);
		assert.match(prompts[0], /不能根据隐藏 text 或例句猜出词性后放行/);
	}
});


test("critic deterministically rejects a bare synonym gloss even with a POS tag", async () => {
	for (const meaning of ["表演", "表演（名词）", "【名词】表演"]) {
		const { llm, prompts } = capture({ pass: true, issues: [], summary: "ok" });
		const result = await critiqueLesson(llm, ctx, resolved, {
			topic: "舞台", items: [{ type: "word", text: "performance", meaning, example: "He gave a wonderful performance.", example_cn: "他做了一场精彩的演出。" }],
		}, [], config, undefined, null);
		assert.equal(prompts.length, 0, meaning);
		assert.equal(result.pass, false, meaning);
		assert.equal(result.issues[0].category, "sense", meaning);
		assert.match(result.issues[0].description, meaning === "表演" ? /缺少明确词性/ : /语境或搭配/);
	}
	const { llm, prompts } = capture({ pass: true, issues: [], summary: "ok" });
	const ok = await critiqueLesson(llm, ctx, resolved, {
		topic: "舞台", items: [{ type: "word", text: "performance", meaning: "一场具体的演出（可数名词，常与 give 搭配，强调演出本身或当场表现）", example: "He gave a wonderful performance.", example_cn: "他做了一场精彩的演出。" }],
	}, [], config, undefined, null);
	assert.equal(prompts.length, 1);
	assert.equal(ok.pass, true);
});

test("plural groceries label reaches the independent critic instead of a false missing-POS rejection", async () => {
	const { llm, prompts } = capture({ pass: false, issues: [{ severity: "blocker", category: "translation", description: "independent semantic review" }], summary: "reviewed" });
	const result = await critiqueLesson(llm, ctx, resolved, {
		topic: "日常购物", items: [{ type: "word", text: "groceries", meaning: "食品杂货（复数名词，指日常购买的食物和家用品）", example: "We buy groceries every week.", example_cn: "我们每周购买食品杂货。" }],
	}, [], config, undefined, null);
	assert.equal(prompts.length, 1, "a valid plural noun label must pass the local presence check");
	assert.equal(result.pass, false, "semantic quality still depends on the independent critic");
	assert.equal(result.issues[0].category, "translation");
});
