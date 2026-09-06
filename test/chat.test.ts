import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "anki-chat-test-"));
const { openDb, insertItem } = await import("../db.ts");
const { runChat, parseChatRequest, allowedChatAction, createChatDispatcher } = await import("../chat.ts");
const db = openDb();
let seq = 0;
function fixture() {
 const id = insertItem(db, "word", `communicate${++seq}`, null, "交流（动词）", "We communicate daily.", "我们每天交流。", new Date());
 const request = { requestId: `req_${seq}`, message: "请修改这张卡的提示", itemId: id, history: [] };
 const deps = { db, valid: () => true, complete: async () => JSON.stringify({ reply: "建议更明确", action: { kind: "edit", fields: { meaning: "交流（动词，指与他人交换信息或想法）" } } }), critique: async () => true, add: async () => ({ success: false, reply: "未通过审查" }), refresh: () => {} };
 return { id, request, deps };
}
test("request contract rejects oversized or malformed inputs", () => {
 const { request } = fixture();
 assert.equal(parseChatRequest(JSON.stringify(request)).requestId, request.requestId);
 for (const change of [{ message: "x".repeat(4001) }, { history: Array(13).fill({ role: "user", content: "a" }) }, { requestId: "bad/id" }, { itemId: -1 }, { history: [{ role: "system", content: "hi" }] }]) assert.throws(() => parseChatRequest(JSON.stringify({ ...request, ...change })));
});
test("latest message alone gates actions; negation and questions do not authorize", () => {
 assert.equal(allowedChatAction("请修卡，补上词性"), "edit");
 assert.equal(allowedChatAction("请加 5 张卡"), "add");
 for (const message of ["解释这个词", "不要修改这张卡", "怎么修改卡片", "例如修改卡片", "是否能加卡", "请修改卡片并添加卡片"]) assert.equal(allowedChatAction(message), "none");
});
test("explanation leaves card, attempts, and scheduling intact", async () => {
 const { id, request, deps } = fixture(); request.message = "这个词是什么意思";
 const before = db.prepare("SELECT * FROM items WHERE id=?").get(id);
 const count = db.prepare("SELECT COUNT(*) AS n FROM attempts").get();
 deps.complete = async () => JSON.stringify({ reply: "这是动词，表示交流。", action: { kind: "none" } });
 const result = await runChat(request, deps);
 assert.equal(result.success, true); assert.equal(result.action, "none");
 assert.deepEqual(db.prepare("SELECT * FROM items WHERE id=?").get(id), before);
 assert.deepEqual(db.prepare("SELECT COUNT(*) AS n FROM attempts").get(), count);
});
test("successful edit preserves all scheduling fields and increments content version", async () => {
 const { id, request, deps } = fixture();
 const before = db.prepare("SELECT * FROM items WHERE id=?").get(id)!;
 db.prepare("UPDATE runtime_state SET active_item_id=?,active_assistance_level='none' WHERE id=1").run(id);
 const result = await runChat(request, deps);
 assert.equal(result.success, true); assert.equal(result.action, "edited");
 const after = db.prepare("SELECT * FROM items WHERE id=?").get(id)!;
 for (const key of ["fsrs_state", "due_at", "reviews", "shown", "learned_at", "text", "status"]) assert.equal(after[key], before[key]);
 assert.equal(after.content_version, Number(before.content_version) + 1);
 assert.equal(db.prepare("SELECT active_assistance_level FROM runtime_state WHERE id=1").get()!.active_assistance_level, "hint");
 assert.equal(db.prepare("SELECT meaning_zh FROM lexical_senses WHERE id=?").get(after.lexical_sense_id)!.meaning_zh, after.meaning);
});
test("stale edits are rejected after critic await", async () => {
 const { id, request, deps } = fixture();
 deps.critique = async () => { db.prepare("UPDATE items SET content_version=content_version+1 WHERE id=?").run(id); return true; };
 const result = await runChat(request, deps);
 assert.equal(result.success, false); assert.match(result.reply, /已被更新/);
 assert.equal(db.prepare("SELECT meaning FROM items WHERE id=?").get(id)!.meaning, "交流（动词）");
});
test("evaluating card rejects edits", async () => {
 const { id, request, deps } = fixture();
 db.prepare("INSERT INTO attempts(id,item_id,review_cycle_id,claim_key,question_version,evaluation_version,kind,assistance_level,status,started_at) VALUES(?,?,?, ?,1,1,'recall','none','evaluating',?)").run(`attempt${id}`, id, `cycle${id}`, `claim${id}`, new Date().toISOString());
 const result = await runChat(request, deps); assert.equal(result.success, false); assert.match(result.reply, /正在判题/);
});
test("missing POS and unavailable critic fail closed", async () => {
 const { request, deps } = fixture();
 deps.complete = async () => JSON.stringify({ reply: "修改", action: { kind: "edit", fields: { meaning: "交流" } } });
 assert.match((await runChat(request, deps)).reply, /词性/);
 const next = fixture(); next.deps.critique = async () => false;
 assert.match((await runChat(next.request, next.deps)).reply, /审查/);
});
test("historical authorization cannot mutate; add failure is truthfully returned", async () => {
 const { request, deps } = fixture();
 request.message = "说明一下";
 (request.history as any[]).push({ role: "user", content: "请修改卡片" });
 assert.equal((await runChat(request, deps)).success, false);
 request.message = "请添加 5 张卡片";
 deps.complete = async () => JSON.stringify({ reply: "做好了", action: { kind: "add" } });
 const failed = await runChat(request, deps); assert.equal(failed.success, false); assert.equal(failed.action, "none"); assert.equal(failed.reply, "未通过审查");
 deps.add = async () => ({ success: true, reply: "已做好 5 张卡并入队" });
 assert.equal((await runChat(request, deps)).action, "added");
});
test("expired session never applies a model mutation", async () => {
 const { request, deps } = fixture(); let valid = true;
 deps.valid = () => valid;
 const complete = deps.complete; deps.complete = async () => { valid = false; return complete(); };
 assert.match((await runChat(request, deps)).reply, /会话已失效/);
});
test("dispatch is asynchronous and requestId retries never duplicate work", async () => {
 const dispatch = createChatDispatcher(); const { request } = fixture(); let executions = 0;
 let release!: (value: any) => void;
 const waiting = new Promise<any>(resolve => release = resolve); const results: any[] = [];
 const execute = async () => { executions++; return waiting; };
 assert.equal(dispatch(request, execute, r => results.push(r)), undefined);
 dispatch(request, execute, r => results.push(r));
 await Promise.resolve(); assert.equal(executions, 1); assert.equal(results.length, 0);
 release({ requestId: request.requestId, success: true, reply: "完成", action: "none", itemId: request.itemId });
 await new Promise(resolve => setImmediate(resolve)); assert.equal(results.length, 2);
 dispatch(request, execute, r => results.push(r)); await new Promise(resolve => setImmediate(resolve)); assert.equal(executions, 1);
 dispatch({ ...request, message: "different" }, execute, r => results.push(r)); assert.equal(results.at(-1).success, false);
});
test("registered command returns acceptance before correlated asynchronous result", async () => {
 const { default: extension } = await import("../index.ts");
 const commands = new Map<string, any>();
 extension({ registerCommand: (name: string, command: any) => commands.set(name, command), on: () => {} } as any);
 const { request } = fixture();
 const notifications: string[] = [];
 const ctx = { hasUI: true, ui: { notify: (text: string) => notifications.push(text) } };
 const accepted = commands.get("anki:chat").handler(JSON.stringify(request), ctx);
 assert.equal(notifications.length, 0);
 await accepted;
 await new Promise(resolve => setImmediate(resolve));
 assert.equal(notifications.length, 1);
 const result = JSON.parse(notifications[0].slice("ANKI_CHAT_RESULT:".length));
 assert.equal(result.requestId, request.requestId);
 assert.equal(result.success, false);
 assert.match(result.reply, /数据库/);
});
test("edit migrates existing exercise meaning and sense links atomically", async () => {
 const { id, request, deps } = fixture();
 const item = db.prepare("SELECT * FROM items WHERE id=?").get(id)!;
 const exercise = db.prepare("INSERT INTO exercises(item_id,kind,schema_version,stage,content_fingerprint,prompt_json,answer_json,hints_json,rubric_json,quality_json,created_at) VALUES(?,'recall',1,'L1',?,?,'{}','[]','{}','{}',?)").run(id, `exercise-${id}`, JSON.stringify({ meaning: item.meaning }), new Date().toISOString());
 db.prepare("INSERT INTO exercise_senses(exercise_id,lexical_sense_id,role) VALUES(?,?,'target')").run(exercise.lastInsertRowid, item.lexical_sense_id);
 const result = await runChat(request, deps); assert.equal(result.success, true);
 const after = db.prepare("SELECT * FROM items WHERE id=?").get(id)!;
 assert.equal(JSON.parse(db.prepare("SELECT prompt_json FROM exercises WHERE id=?").get(exercise.lastInsertRowid)!.prompt_json as string).meaning, after.meaning);
 assert.equal(db.prepare("SELECT lexical_sense_id FROM exercise_senses WHERE exercise_id=?").get(exercise.lastInsertRowid)!.lexical_sense_id, after.lexical_sense_id);
});
test("explicit edits allow quoted payload and negative field constraints", () => {
 assert.equal(allowedChatAction('把提示改为“交流（动词）”'), "edit");
 assert.equal(allowedChatAction("修卡但不要改例句"), "edit");
 assert.equal(allowedChatAction("请不要修卡，只解释"), "none");
 assert.equal(allowedChatAction("如何修卡"), "none");
});
test("question about an evaluating active card cannot invalidate its grading", async () => {
 const { id, request, deps } = fixture(); request.message = "解释这张卡";
 db.prepare("UPDATE runtime_state SET active_item_id=?,active_assistance_level='none' WHERE id=1").run(id);
 db.prepare("INSERT INTO attempts(id,item_id,review_cycle_id,claim_key,question_version,evaluation_version,kind,assistance_level,status,started_at) VALUES(?,?,?, ?,1,1,'recall','none','evaluating',?)").run(`attempt${id}`, id, `cycle${id}`, `claim${id}`, new Date().toISOString());
 const before = db.prepare("SELECT * FROM runtime_state WHERE id=1").get();
 let called = false; deps.complete = async () => { called = true; return ""; };
 const result = await runChat(request, deps);
 assert.equal(result.success, false); assert.equal(called, false);
 assert.deepEqual(db.prepare("SELECT * FROM runtime_state WHERE id=1").get(), before);
});
test("example-only edit receipt lists actual change", async () => {
 const { request, deps } = fixture();
 deps.complete = async () => JSON.stringify({ reply: "修改", action: { kind: "edit", fields: { example: "We communicate with our neighbours." } } });
 const result = await runChat(request, deps);
 assert.equal(result.success, true); assert.match(result.reply, /例句：We communicate with our neighbours\./);
});
test("exercise identity and non-prompt fields remain stable during meaning edits", async () => {
 const { id, request, deps } = fixture();
 const item = db.prepare("SELECT * FROM items WHERE id=?").get(id)!;
 const exercise = db.prepare("INSERT INTO exercises(item_id,kind,schema_version,stage,content_fingerprint,prompt_json,answer_json,hints_json,rubric_json,quality_json,created_at) VALUES(?,'recall',1,'L1',?,?,?,?,?,'{}',?)").run(id, `recall:${id}`, JSON.stringify({ meaning: item.meaning, unrelated: item.meaning }), JSON.stringify({ answer: item.meaning }), JSON.stringify([item.meaning]), JSON.stringify({ note: item.meaning }), new Date().toISOString());
 db.prepare("INSERT INTO exercise_senses(exercise_id,lexical_sense_id,role) VALUES(?,?,'target'),(?,?,'contrast')").run(exercise.lastInsertRowid, item.lexical_sense_id, exercise.lastInsertRowid, item.lexical_sense_id);
 const before = db.prepare("SELECT * FROM exercises WHERE id=?").get(exercise.lastInsertRowid)!;
 assert.equal((await runChat(request, deps)).success, true);
 const after = db.prepare("SELECT * FROM exercises WHERE id=?").get(exercise.lastInsertRowid)!;
 for (const key of ["content_fingerprint", "answer_json", "hints_json", "rubric_json", "quality_json"]) assert.equal(after[key], before[key]);
 assert.equal(JSON.parse(after.prompt_json as string).unrelated, item.meaning);
 assert.equal(db.prepare("SELECT lexical_sense_id FROM exercise_senses WHERE exercise_id=? AND role='contrast'").get(exercise.lastInsertRowid)!.lexical_sense_id, item.lexical_sense_id);
});
test("decoded length allows valid heavily escaped request payloads", () => {
 const { request } = fixture();
 const valid = { ...request, message: "你好", history: Array.from({ length: 10 }, () => ({ role: "user", content: "\\".repeat(5900) })) };
 assert.ok(JSON.stringify(valid).length > 100000);
 assert.equal(parseChatRequest(JSON.stringify(valid)).history.length, 10);
});
test("invalid request with valid id returns correlated failure immediately", async () => {
 const { default: extension } = await import("../index.ts"); const commands = new Map<string, any>();
 extension({ registerCommand: (name: string, command: any) => commands.set(name, command), on: () => {} } as any);
 const notifications: string[] = []; const ctx = { hasUI: true, ui: { notify: (text: string) => notifications.push(text) } };
 await commands.get("anki:chat").handler(JSON.stringify({ requestId: "invalid_payload", message: "", itemId: null, history: [] }), ctx);
 const result = JSON.parse(notifications[0].slice("ANKI_CHAT_RESULT:".length));
 assert.equal(result.requestId, "invalid_payload"); assert.equal(result.success, false);
});
test("edit critic known section excludes current card by id, preserves other cards", async () => {
 const { chatEditReview } = await import("../chat.ts");
 const { critiqueLesson } = await import("../llm.ts");
 const { id } = fixture();
 db.prepare("UPDATE items SET shown=1 WHERE id=?").run(id);
 const other = fixture(); db.prepare("UPDATE items SET shown=1 WHERE id=?").run(other.id);
 const card = db.prepare("SELECT * FROM items WHERE id=?").get(id)!;
 const item = { type: "word" as const, text: String(card.text), meaning: "交流（动词，指交换信息或想法）", example: `We ${card.text} daily.`, example_cn: "我们每天交流。" };
 const review = chatEditReview(db, id, item);
 let prompt = "";
 const verdict = await critiqueLesson({ complete: async (_ctx: any, _resolved: any, request: any) => { prompt = request.prompt; return JSON.stringify({ pass: true, issues: [], summary: "通过" }); } } as any, {} as any, {} as any, review.lesson, review.known, {} as any, undefined, null);
 assert.equal(verdict.pass, true);
 const knownSection = prompt.split("\n").find(line => line.startsWith("- 不得与已学内容重复："))!;
 assert.ok(knownSection); assert.ok(!knownSection.includes(`${card.text}（`));
 assert.ok(knownSection.includes(`communicate${seq}（`));
 assert.ok(prompt.includes(`<lesson>${JSON.stringify(review.lesson)}</lesson>`));
 assert.match(review.lesson.topic, /替换当前卡内容，并非新增/);
});
test("adding cards does not mark unrelated active card as assisted", async () => {
 const { id, request, deps } = fixture();
 db.prepare("UPDATE runtime_state SET active_item_id=?,active_assistance_level='none' WHERE id=1").run(id);
 const before = db.prepare("SELECT * FROM runtime_state WHERE id=1").get();
 request.message = "请添加 5 张餐厅卡片";
 deps.complete = async () => JSON.stringify({ reply: "制作卡片", action: { kind: "add" } });
 deps.add = async () => ({ success: true, reply: "已做好 5 张卡并入队" });
 assert.equal((await runChat(request, deps)).success, true);
 assert.deepEqual(db.prepare("SELECT * FROM runtime_state WHERE id=1").get(), before);
});
