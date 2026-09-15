import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PetConfig } from "../config.ts";
import type { ItemRow } from "../db.ts";
import type { PiSdkLlmClient } from "../pi-sdk-llm.ts";
import { critiqueLesson, evaluateAttempt, generateCustomCards, generateLesson, generateReplacement } from "../llm.ts";
import { CHAT_SYSTEM_PROMPT } from "../chat.ts";

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
	await generateLesson(llm, ctx, resolved, "", [], config, [{ severity: "blocker", category: "sense", description: "同词性替换后仍可作答" }]);
	assert.equal(prompts.length, 6);
	for (const prompt of [...prompts, CHAT_SYSTEM_PROMPT]) {
		assert.match(prompt, /必须在作答前就给足线索/);
		assert.match(prompt, /每张 word\/phrase 的 meaning 都必须明确标注当前所考义项的中文词性/);
		assert.match(prompt, /词组标注动词短语、名词短语/);
		assert.match(prompt, /communicate 应写「交流（动词/);
		assert.match(prompt, /communication 应写「交流（名词/);
		assert.match(prompt, /词性只解决词类歧义，同词性的近义词仍须补必要的义项或搭配线索/);
		assert.match(prompt, /学生只看到 meaning，不能假设例句挖空已经显示/);
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
		assert.match(prompt, /逐张做同词性替换检验/);
		assert.match(prompt, /goal \/ target \/ aim/);
		assert.match(prompt, /释义复述.*不是区分同义词的证据/);
		assert.match(prompt, /必要部分必须前置到 meaning/);
		assert.match(prompt, /禁止用首字母、词长、字母数或按字符数挖空来替代语义消歧/);
		assert.match(prompt, /无法安全生成则解释原因/);
	}
});

test("known goal target aim paraphrases are rejected locally even if the model would approve", async () => {
	for (const target of ["goal", "target", "aim"]) {
		for (const context of ["指希望达到的结果", "指希望达成的结果", "指想要实现的事情", "指希望达到的具体结果", "常与 set 搭配", "强调长期目标", "本次是学生计划每天学习英语的目标"]) {
			const { llm, prompts } = capture({ pass: true, issues: [], summary: "approved" });
			const result = await critiqueLesson(llm, ctx, resolved, {
				topic: "学习计划", items: [{ type: "word", text: target, meaning: `目标（可数名词，${context}）`, example: `My ${target} is to study English every day.`, example_cn: "我的目标是每天学习英语。" }],
			}, [], config, undefined, null);
			assert.equal(result.pass, false, `${target}: ${context}`);
			assert.equal(prompts.length, 0, "the known counterexample is blocked before consulting the model");
			assert.ok(result.issues.some(issue => issue.category === "sense" && /释义复述/.test(issue.description)));
		}
	}
});

test("spelling hints are rejected even when accurate and accompanied by a maskable example", async () => {
	for (const [hint, example] of [
		["以 t 开头，共 4 个字母", "My goal is to study English every day."],
		["以 g 开头，共 6 个字母", "My goal is to study English every day."],
		["以 g 开头", "My goal is to study English every day."],
		["共 4 个字母", "My goal is to study English every day."],
		["以 g 开头，共 4 个字母", "I study English every day."],
	]) {
		const { llm, prompts } = capture({ pass: true, issues: [], summary: "approved" });
		const result = await critiqueLesson(llm, ctx, resolved, { topic: "学习计划", items: [{ type: "word", text: "goal", meaning: `目标（可数名词，每天学习英语的计划；${hint}）`, example }] }, [], config, undefined, null);
		assert.equal(result.pass, false, hint + example);
		assert.equal(prompts.length, 0);
	}
	for (const [target, meaning, example] of [
		["goal", "目标（可数名词，每天学习英语的计划；以 g 开头，共 4 个字母）", "My goal is to study English every day."],
		["apple", "苹果（可数名词，一种水果；以 a 开头，共 5 个字母）", "I eat an apple every day."],
		["look after", "照顾（动词短语，照料小孩；首字母是 l，词长 9）", "I look after my sister."],
	]) {
		const { llm, prompts } = capture({ pass: true, issues: [], summary: "approved" });
		const result = await critiqueLesson(llm, ctx, resolved, { topic: "词汇", items: [{ type: target.includes(" ") ? "phrase" : "word", text: target, meaning, example }] }, [], config, undefined, null);
		assert.equal(result.pass, false, target);
		assert.equal(prompts.length, 0);
		assert.ok(result.issues.some(issue => /禁止用拼写提示/.test(issue.description)));
	}
});

test("the narrow goal-family guard does not reject unrelated football or physical-target senses", async () => {
	for (const [target, meaning, example] of [
		["goal", "进球（可数名词，足球比赛中把球射入对方球门得分）", "He scored a goal in the final minute."],
		["target", "靶子（可数名词，射箭训练时用来瞄准的物体）", "The arrow hit the target in the middle."],
	]) {
		const { llm, prompts } = capture({ pass: false, issues: [{ severity: "blocker", category: "sense", description: "still needs independent semantic review" }], summary: "reviewed" });
		const result = await critiqueLesson(llm, ctx, resolved, { topic: "运动", items: [{ type: "word", text: target, meaning, example }] }, [], config, undefined, null);
		assert.equal(prompts.length, 1);
		assert.equal(result.pass, false, "passing the local counterexample guard never means automatic approval");
		const audit = JSON.parse(/<forward_audit>(.*?)<\/forward_audit>/s.exec(prompts[0])![1]);
		assert.equal(audit[0].explicitSpellingTarget, undefined);
		assert.match(audit[0].maskedExample, /____/);
		assert.doesNotMatch(audit[0].maskedExample, /_{5}/);
		assert.match(prompts[0], /空列表绝不表示没有近义词/);
		assert.match(prompts[0], /语境存在不是语义唯一证明/);
	}
});

test("the unconstrained Chinese prompt still accepts a natural alternative answer", async () => {
	const { llm, prompts } = capture({ verdict: "correct", feedback: "target 也符合题面" });
	const result = await evaluateAttempt(llm, ctx, { type: "word", text: "goal", meaning: "目标（可数名词，指希望达到的结果）" } as ItemRow, "target", resolved, "forward", "默写英文：目标（可数名词，指希望达到的结果）");
	assert.equal(result.verdict, "correct");
	assert.match(prompts[0], /任何一个自然且完全符合该中文提示的英文单词\/词组都算对/);
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


test("contradictory or negated target hints cannot be waived by the critic", async () => {
	for (const hint of ["以 g 开头，共 4 个字母；答案以 t 开头，共 6 个字母", "不是以 g 开头，共 4 个字母", "以 g 开头，但不是 4 个字母"]) {
		const { llm, prompts } = capture({ pass: true, issues: [], summary: "ok" });
		const result = await critiqueLesson(llm, ctx, resolved, { topic: "目标", items: [{ type: "word", text: "goal", meaning: `目标（可数名词，${hint}）`, example: "My goal is to learn fifty English words.", example_cn: "我的目标是学习五十个英语单词。" }] }, [], config, undefined, null);
		assert.equal(result.pass, false, hint);
		assert.equal(prompts.length, 0, hint);
	}
});


test("displayed context uses substitution grading for synonyms and real conflicts", async () => {
	for (const [answer, verdict] of [["target", "correct"], ["banana", "incorrect"]] as const) {
		const { llm, prompts } = capture({ verdict, feedback: "test" });
		const result = await evaluateAttempt(llm, ctx, { type: "word", text: "goal", meaning: "目标（可数名词，指希望达到的结果）" } as ItemRow, answer, resolved, "forward", "默写单词「目标」的英文（例：My ____ is to learn English.；语境：我的目标是学英语。）");
		assert.equal(result.verdict, verdict);
		assert.match(prompts[0], /语境存在不代表答案唯一/);
		assert.match(prompts[0], /即使与目标词不同.*也算 correct/);
		assert.match(prompts[0], /与题面实际语境或语法矛盾的答案不算 correct/);
		assert.doesNotMatch(prompts[0], /题面线索已唯一指向/);
	}
});
