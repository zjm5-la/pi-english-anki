import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, registerFauxProvider, streamSimple as streamModel } from "@earendil-works/pi-ai/compat";

const agentDir = mkdtempSync(join(tmpdir(), "kaomoji-sdk-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(agentDir, { recursive: true });
const { PiSdkLlmClient } = await import("../pi-sdk-llm.ts");
const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");

function testContext(registration: ReturnType<typeof registerFauxProvider>) {
	const model = registration.getModel();
	const modelRegistry = {
		getAvailable: () => [model],
		find: (provider: string, id: string) => provider === model.provider && id === model.id ? model : undefined,
		hasConfiguredAuth: () => true,
		getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: {} }),
	};
	return { cwd: agentDir, model, modelRegistry } as any;
}

function fauxRuntime(ctx: any) {
	return {
		getModel: (provider: string, modelId: string) => ctx.modelRegistry.find(provider, modelId),
		hasConfiguredAuth: () => true,
		setRuntimeApiKey: async () => {},
		streamSimple: async (model: any, context: any, options: any) => {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok || !auth.apiKey) throw new Error("NO_API_KEY");
			return streamModel(model, context, { ...options, apiKey: auth.apiKey, headers: auth.headers });
		},
	} as any;
}

test("rejected SDK runtime creation is evicted so the next call can recover", async () => {
	const registration = registerFauxProvider({ provider: "kaomoji-sdk-retry" });
	try {
		registration.setResponses([fauxAssistantMessage("recovered")]);
		const ctx = testContext(registration);
		let factoryCalls = 0;
		const client = new PiSdkLlmClient(async () => {
			factoryCalls++;
			if (factoryCalls === 1) throw new Error("transient runtime failure");
			return fauxRuntime(ctx);
		});
		const request = { systemPrompt: "Reply briefly.", prompt: "test" };
		const resolved = { provider: ctx.model.provider, model: ctx.model.id };
		await assert.rejects(client.complete(ctx, resolved, request), /transient runtime failure/);
		assert.equal(await client.complete(ctx, resolved, request), "recovered");
		assert.equal(factoryCalls, 2);
		await client.dispose();
	} finally {
		registration.unregister();
	}
});

test("native host providers are copied into the isolated runtime", async () => {
	const registration = registerFauxProvider({ provider: "kaomoji-sdk-native" });
	const originalCreate = ModelRuntime.create;
	try {
		registration.setResponses([fauxAssistantMessage("native-ok")]);
		const ctx = testContext(registration);
		const nativeProvider = { id: ctx.model.provider };
		ctx.modelRegistry.getRegisteredNativeProvider = (provider: string) => provider === ctx.model.provider ? nativeProvider : undefined;
		ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, headers: { "x-native-auth": "local" } });
		let copied: unknown;
		let streamedMaxTokens: number | undefined;
		const runtime = fauxRuntime(ctx) as any;
		runtime.registerNativeProvider = (provider: unknown) => { copied = provider; };
		runtime.streamSimple = async (model: any, context: any, options: any) => {
			streamedMaxTokens = model.maxTokens;
			return streamModel(model, context, { ...options, apiKey: "native-test-key" });
		};
		(ModelRuntime as any).create = async () => runtime;
		const client = new PiSdkLlmClient();
		assert.equal(
			await client.complete(ctx, { provider: ctx.model.provider, model: ctx.model.id }, { systemPrompt: "Reply briefly.", prompt: "test" }),
			"native-ok",
		);
		assert.equal(copied, nativeProvider);
		assert.equal(streamedMaxTokens, ctx.model.maxTokens, "the client must not narrow the model's output limit");
		await client.dispose();
	} finally {
		(ModelRuntime as any).create = originalCreate;
		registration.unregister();
	}
});

test("OAuth remains OAuth in isolated sessions instead of becoming an API key", async () => {
	const registration = registerFauxProvider({ provider: "kaomoji-sdk-oauth" });
	try {
		registration.setResponses([fauxAssistantMessage("oauth-ok")]);
		const ctx = testContext(registration);
		ctx.modelRegistry.isUsingOAuth = () => true;
		let apiKeyOverrides = 0;
		const runtime = fauxRuntime(ctx);
		runtime.setRuntimeApiKey = async () => { apiKeyOverrides++; };
		const client = new PiSdkLlmClient(async () => runtime);
		try {
			assert.equal(await client.complete(ctx, { provider: ctx.model.provider, model: ctx.model.id }, {
				systemPrompt: "Reply briefly.", prompt: "test",
			}), "oauth-ok");
			assert.equal(apiKeyOverrides, 0, "an OAuth token must never replace Pi OAuth credentials");
		} finally { await client.dispose(); }
	} finally { registration.unregister(); }
});

test("ordinary API-key providers still inherit host runtime credentials", async () => {
	const registration = registerFauxProvider({ provider: "kaomoji-sdk-api-key" });
	try {
		registration.setResponses([fauxAssistantMessage("api-key-ok")]);
		const ctx = testContext(registration);
		ctx.modelRegistry.isUsingOAuth = () => false;
		let apiKeyOverrides = 0;
		const runtime = fauxRuntime(ctx);
		runtime.setRuntimeApiKey = async (provider: string, key: string) => {
			assert.equal(provider, ctx.model.provider);
			assert.equal(key, "test-key");
			apiKeyOverrides++;
		};
		const client = new PiSdkLlmClient(async () => runtime);
		try {
			assert.equal(await client.complete(ctx, { provider: ctx.model.provider, model: ctx.model.id }, {
				systemPrompt: "Reply briefly.", prompt: "test",
			}), "api-key-ok");
			assert.equal(apiKeyOverrides, 1);
		} finally { await client.dispose(); }
	} finally { registration.unregister(); }
});

test("the completion deadline covers auth before session creation", async () => {
	const registration = registerFauxProvider({ provider: "kaomoji-sdk-auth-timeout" });
	try {
		const model = registration.getModel();
		const never = new Promise<never>(() => {});
		const ctx = {
			cwd: agentDir,
			model,
			modelRegistry: {
				find: (provider: string, id: string) => provider === model.provider && id === model.id ? model : undefined,
				getApiKeyAndHeaders: () => never,
			},
		} as any;
		let factoryCalls = 0;
		const client = new PiSdkLlmClient(async () => { factoryCalls++; return fauxRuntime(ctx); }, { completeTimeoutMs: 20, abortTimeoutMs: 20 });
		await assert.rejects(
			client.complete(ctx, { provider: model.provider, model: model.id }, { systemPrompt: "test", prompt: "test" }),
			/SDK_LLM_TIMEOUT/,
		);
		assert.equal(factoryCalls, 0);
		await client.dispose();
	} finally {
		registration.unregister();
	}
});

test("dispose during pending auth prevents runtime and session creation", async () => {
	const registration = registerFauxProvider({ provider: "kaomoji-sdk-dispose" });
	try {
		const model = registration.getModel();
		let resolveAuth!: (value: { ok: true; apiKey: string; headers: {} }) => void;
		let authStarted!: () => void;
		const started = new Promise<void>((resolve) => { authStarted = resolve; });
		const auth = new Promise<{ ok: true; apiKey: string; headers: {} }>((resolve) => { resolveAuth = resolve; });
		const ctx = {
			cwd: agentDir,
			model,
			modelRegistry: {
				find: (provider: string, id: string) => provider === model.provider && id === model.id ? model : undefined,
				getApiKeyAndHeaders: () => { authStarted(); return auth; },
			},
		} as any;
		let factoryCalls = 0;
		const client = new PiSdkLlmClient(async () => { factoryCalls++; return fauxRuntime(ctx); });
		const completion = client.complete(ctx, { provider: model.provider, model: model.id }, { systemPrompt: "test", prompt: "test" });
		await started;
		await client.dispose();
		resolveAuth({ ok: true, apiKey: "test-key", headers: {} });
		await assert.rejects(completion, /SDK_LLM_CLIENT_CLOSED/);
		assert.equal(factoryCalls, 0, "dispose before auth completion must not create a runtime or session");
	} finally {
		registration.unregister();
	}
});


let transportFixtureId = 0;
const gatewayHtml = '<!DOCTYPE html><html><head><title>Upstream failure</title></head><body>Unexpected response</body></html>';

type TransportStep = { status?: number; error?: string; text?: string };

async function withTransportFixture(
	steps: TransportStep[],
	run: (fixture: { client: InstanceType<typeof PiSdkLlmClient>; complete: () => Promise<string>; calls: () => number }) => Promise<void>,
	options: { completeTimeoutMs?: number; abortTimeoutMs?: number } = {},
) {
	const registration = registerFauxProvider({ provider: `kaomoji-sdk-http-${++transportFixtureId}` });
	const ctx = testContext(registration);
	registration.setResponses(steps.map(step => fauxAssistantMessage(step.text ?? "", step.error == null
		? {} : { stopReason: "error", errorMessage: step.error })));
	let calls = 0;
	const runtime = fauxRuntime(ctx);
	const originalStream = runtime.streamSimple;
	runtime.streamSimple = async (model: any, context: any, streamOptions: any) => {
		const step = steps[calls++];
		assert.ok(step, "transport made more attempts than the existing retry budget allows");
		return originalStream(model, context, { ...streamOptions,
			// Faux normally announces HTTP 200; replace that announcement with
			// the fixture status instead of reporting a second response ourselves.
			onResponse: step.status == null ? undefined : async () => streamOptions?.onResponse?.({ status: step.status, headers: {} }, model),
		});
	};
	const client = new PiSdkLlmClient(async () => runtime, options);
	try {
		await run({ client, calls: () => calls, complete: () => client.complete(ctx,
			{ provider: ctx.model.provider, model: ctx.model.id },
			{ systemPrompt: "Reply briefly.", prompt: "test" }) });
	} finally {
		await client.dispose();
		registration.unregister();
	}
}

test("HTTP HTML failure reaches the existing session retry and then recovers", async () => {
	await withTransportFixture([{ status: 503, error: gatewayHtml }, { status: 200, text: "recovered" }], async fixture => {
		assert.equal(await fixture.complete(), "recovered");
		assert.equal(fixture.calls(), 2);
	});
});

test("HTTP 408 request timeouts retain the existing retry path", async () => {
	for (const error of ["The request timed out", gatewayHtml]) {
		await withTransportFixture([{ status: 408, error }, { status: 200, text: "recovered" }], async fixture => {
			assert.equal(await fixture.complete(), "recovered");
			assert.equal(fixture.calls(), 2);
		});
	}
});

test("HTML billing footer text does not turn a server failure into exhausted quota", async () => {
	const html = gatewayHtml.replace('Unexpected response', '<footer><a>Billing</a> Learn about usage limits</footer>');
	await withTransportFixture([{ status: 503, error: html }, { status: 200, text: "recovered" }], async fixture => {
		assert.equal(await fixture.complete(), "recovered");
		assert.equal(fixture.calls(), 2);
	});
	await withTransportFixture([{ error: html }], async fixture => {
		await assert.rejects(fixture.complete(), (error: any) => error.code === "SDK_LLM_INVALID_RESPONSE");
		assert.equal(fixture.calls(), 1, "unidentified error page must not guess quota or HTTP status");
	});
});

test("exhausted HTTP failures retain status without HTML and remain limited to three attempts", async () => {
	await withTransportFixture(Array.from({ length: 3 }, () => ({ status: 503, error: gatewayHtml })), async fixture => {
		await assert.rejects(fixture.complete(), (error: any) => {
			assert.equal(error.code, "SDK_LLM_HTTP_503");
			assert.match(error.message, /HTTP 503/);
			assert.doesNotMatch(error.message, /<!doctype|<html|<head|<body/i);
			assert.ok(error.message.length < 150);
			return true;
		});
		assert.equal(fixture.calls(), 3, "two retries must not gain another retry layer");
	});
});

test("HTML auth failures do not retry incidental server-error text in the page", async () => {
	for (const status of [401, 403]) {
		await withTransportFixture([{ status, error: gatewayHtml.replace('Unexpected response', '500 502 service unavailable rate limit') }], async fixture => {
			await assert.rejects(fixture.complete(), (error: any) => {
				assert.equal(error.code, `SDK_LLM_HTTP_${status}`);
				assert.match(error.message, new RegExp(`HTTP ${status}`));
				assert.doesNotMatch(error.message, /500|502|rate limit|<html/);
				return true;
			});
			assert.equal(fixture.calls(), 1);
		});
	}
});

test("non-HTML terminal HTTP bodies cannot manufacture a transient failure", async () => {
	for (const status of [400, 401, 403, 404, 422]) {
		await withTransportFixture([{ status, error: '{"error":{"message":"Invalid request 500 502 timeout"}}' }], async fixture => {
			await assert.rejects(fixture.complete(), (error: any) => {
				assert.equal(error.code, `SDK_LLM_HTTP_${status}`);
				assert.doesNotMatch(error.message, /500|502|timeout/);
				return true;
			});
			assert.equal(fixture.calls(), 1);
		});
	}
});

test("quota errors without response metadata still retain their independent code", async () => {
	await withTransportFixture([{ error: 'You have hit your ChatGPT usage limit. Try again in ~500 min.' }], async fixture => {
		await assert.rejects(fixture.complete(), (error: any) => error.code === "SDK_LLM_INSUFFICIENT_QUOTA");
		assert.equal(fixture.calls(), 1);
	});
});

test("unknown-status HTML error becomes an invalid-response code without guessing a status", async () => {
	await withTransportFixture([{ error: gatewayHtml }], async fixture => {
		await assert.rejects(fixture.complete(), (error: any) => {
			assert.equal(error.code, "SDK_LLM_INVALID_RESPONSE");
			assert.doesNotMatch(error.message, /HTTP|<html|<!doctype/i);
			return true;
		});
		assert.equal(fixture.calls(), 1);
	});
});

test("quota and billing errors retain terminal semantics even with HTTP 429", async () => {
	for (const error of [
		'{"error":{"type":"insufficient_quota","message":"quota exceeded"}}',
		'{"error":{"code":"usage_limit_reached","message":"Please check billing"}}',
		'You have hit your ChatGPT usage limit. Try again in ~60 min.',
		'You have hit your ChatGPT usage limit. Try again in ~500 min.',
		'{"error":{"code":"usage_limit_reached","message":"HTTP 429, try later"}}',
		gatewayHtml.replace('Unexpected response', 'insufficient_quota'),
	]) {
		await withTransportFixture([{ status: 429, error }], async fixture => {
			await assert.rejects(fixture.complete(), (result: any) => {
				assert.equal(result.code, "SDK_LLM_INSUFFICIENT_QUOTA");
				assert.doesNotMatch(result.message, /<html|<!doctype/i);
				assert.match(result.message, /^quota exceeded/);
				if (!error.startsWith('<')) assert.ok(result.message.includes(error));
				return true;
			});
			assert.equal(fixture.calls(), 1, "subscription/account limits must not be retried");
		});
	}
});

test("successful HTML text is returned verbatim and is never treated as a transport failure", async () => {
	await withTransportFixture([{ status: 200, text: gatewayHtml }], async fixture => {
		assert.equal(await fixture.complete(), gatewayHtml);
		assert.equal(fixture.calls(), 1);
	});
});

test("a new attempt does not inherit the previous attempt's HTTP status", async () => {
	await withTransportFixture([{ status: 503, error: gatewayHtml }, { error: "Permanent configuration failure" }], async fixture => {
		await assert.rejects(fixture.complete(), (error: any) => {
			assert.equal(error.code, undefined);
			assert.equal(error.message, "Permanent configuration failure");
			return true;
		});
		assert.equal(fixture.calls(), 2);
	});
});

test("simultaneous sessions sharing one runtime keep HTTP status isolated", async () => {
	const registration = registerFauxProvider({ provider: "kaomoji-sdk-http-concurrent" });
	const ctx = testContext(registration);
	const counts = new Map<string, number>();
	const keyFor = (context: any) => {
		const content = context.messages[context.messages.length - 1].content;
		return typeof content === 'string' ? content : content.map((part: any) => part.text ?? '').join('');
	};
	registration.setResponses(Array.from({ length: 3 }, () => (context: any) => {
		const key = keyFor(context);
		return key === 'denied' || counts.get(key) === 1
			? fauxAssistantMessage('', { stopReason: 'error', errorMessage: gatewayHtml })
			: fauxAssistantMessage('recovered');
	}));
	const runtime = fauxRuntime(ctx);
	const originalStream = runtime.streamSimple;
	runtime.streamSimple = async (model: any, context: any, options: any) => {
		const key = keyFor(context);
		counts.set(key, (counts.get(key) ?? 0) + 1);
		const status = key === 'denied' ? 403 : counts.get(key) === 1 ? 503 : 200;
		await new Promise(resolve => setTimeout(resolve, key === 'denied' ? 8 : 1));
		return originalStream(model, context, { ...options,
			onResponse: async () => options?.onResponse?.({ status, headers: {} }, model),
		});
	};
	const client = new PiSdkLlmClient(async () => runtime);
	try {
		const complete = (prompt: string) => client.complete(ctx, { provider: ctx.model.provider, model: ctx.model.id }, { systemPrompt: 'test', prompt });
		const [denied, recovered] = await Promise.allSettled([complete('denied'), complete('recover')]);
		assert.equal(denied.status, 'rejected');
		if (denied.status === 'rejected') assert.equal(denied.reason.code, 'SDK_LLM_HTTP_403');
		assert.deepEqual(recovered, { status: 'fulfilled', value: 'recovered' });
		assert.equal(counts.get('denied'), 1);
		assert.equal(counts.get('recover'), 2);
	} finally {
		await client.dispose();
		registration.unregister();
	}
});

test("the existing completion deadline also bounds HTTP retry backoff", async () => {
	await withTransportFixture([{ status: 503, error: gatewayHtml }], async fixture => {
		const started = Date.now();
		await assert.rejects(fixture.complete(), /SDK_LLM_TIMEOUT/);
		assert.ok(Date.now() - started < 1000, "retry backoff must not escape the completion deadline");
		assert.equal(fixture.calls(), 1);
	}, { completeTimeoutMs: 40, abortTimeoutMs: 20 });
});

test.after(() => rmSync(agentDir, { recursive: true, force: true }));
