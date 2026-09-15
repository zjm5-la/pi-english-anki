import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export interface SdkModelRef {
	provider: string;
	model: string;
}

export interface SdkCompletionRequest {
	systemPrompt: string;
	prompt: string;
	thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

export type PiSdkRuntimeFactory = (ctx: ExtensionContext, provider: string) => Promise<ModelRuntime>;

export interface PiSdkLlmClientOptions {
	completeTimeoutMs?: number;
	abortTimeoutMs?: number;
}

const DEFAULT_COMPLETE_TIMEOUT_MS = 120_000;
const DEFAULT_ABORT_TIMEOUT_MS = 5_000;

function clientClosedError(): Error {
	return new Error("SDK_LLM_CLIENT_CLOSED");
}

function completionTimeoutError(): Error {
	return new Error("SDK_LLM_TIMEOUT");
}

type SdkStream = Awaited<ReturnType<AgentSession["agent"]["streamFunction"]>>;
type SdkAssistantMessage = Awaited<ReturnType<SdkStream["result"]>>;

const HTML_ERROR_DOCUMENT = /<(?:!doctype\s+html|html|head|body)(?:\s|>)/i;
const TERMINAL_PROVIDER_LIMIT_CODE = /\b(?:GoUsageLimitError|FreeUsageLimitError|insufficient_quota|usage_limit_reached|usage_not_included)\b/i;
const TERMINAL_PROVIDER_LIMIT = /GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing|usage_limit_reached|usage_not_included|usage limit/i;

/** Keep HTTP identity before the SDK reduces provider failures to plain text.
 * Only failure messages are inspected: successful HTML output is untouched. */
function providerFailure(message: string, status?: number): { message: string; code?: string } {
	const httpStatus = status != null && Number.isInteger(status) && status >= 400 && status <= 599 ? status : undefined;
	const html = HTML_ERROR_DOCUMENT.test(message);
	// Quota failures need their own persisted code: callers display error.code
	// instead of the full message, and HTTP 429 alone would imply throttling.
	// Error pages often contain navigation links mentioning billing or usage
	// limits. Only explicit provider limit codes are conclusive within HTML.
	if ((html ? TERMINAL_PROVIDER_LIMIT_CODE : TERMINAL_PROVIDER_LIMIT).test(message)) {
		// AgentSession classifies text rather than error.code. Its explicit
		// terminal marker must win even if a reset time contains 500 or 429.
		return { code: "SDK_LLM_INSUFFICIENT_QUOTA", message: "quota exceeded（模型服务额度不足）" + (html ? "" : `：${message}`) };
	}
	if (!httpStatus && !html) return { message };
	const code = httpStatus ? `SDK_LLM_HTTP_${httpStatus}` : "SDK_LLM_INVALID_RESPONSE";
	const prefix = httpStatus ? `HTTP ${httpStatus}: ` : "";
	if (httpStatus === 408) return { code, message: prefix + "request timeout（模型服务请求超时）。" };
	// The session's retry matcher scans strings. A terminal HTTP response must
	// not become retryable because its body happens to mention 500 or timeout.
	if (httpStatus && httpStatus < 500 && httpStatus !== 429) {
		return { code, message: prefix + (httpStatus === 401 || httpStatus === 403
			? "模型服务身份验证或访问权限未通过。"
			: "模型服务拒绝了请求，请检查模型与请求设置。") };
	}
	if (html) {
		const summary = httpStatus === 401 || httpStatus === 403
			? "模型服务身份验证或访问权限未通过。"
			: httpStatus === 429 ? "模型服务请求过于频繁。"
				: "模型服务返回异常网页，未收到有效回答。";
		return { code, message: prefix + summary };
	}
	return { code, message: prefix + message };
}

function sdkFailure(message: string, code?: string): Error {
	const error = new Error(message);
	if (code) (error as Error & { code?: string }).code = code;
	return error;
}

/** Adapt one isolated session, never the shared runtime or global fetch.
 * The existing AgentSession retry policy sees sanitized terminal events and
 * remains the only retry owner. HTTP status is fresh for every stream attempt. */
function normalizeSessionFailures(session: AgentSession): () => string | undefined {
	const streamFunction = session.agent.streamFunction;
	let terminalCode: string | undefined;
	session.agent.streamFunction = async (model, context, options) => {
		let status: number | undefined;
		terminalCode = undefined;
		const normalize = (message: SdkAssistantMessage): SdkAssistantMessage => {
			if (message.stopReason !== "error") return message;
			const failure = providerFailure(message.errorMessage || "provider error", status);
			terminalCode = failure.code;
			return { ...message, errorMessage: failure.message };
		};
		let stream: SdkStream;
		try {
			stream = await streamFunction(model, context, {
				...options,
				onResponse: async (response, responseModel) => {
					status = response.status;
					await options?.onResponse?.(response, responseModel);
				},
			});
		} catch (error) {
			const failure = providerFailure((error as Error)?.message || String(error), status);
			terminalCode = failure.code;
			throw sdkFailure(failure.message, failure.code);
		}
		// Preserve the SDK's stream implementation and its private fields. Both
		// consumption APIs must return the same normalized terminal message.
		return new Proxy(stream, {
			get(target, property) {
				if (property === Symbol.asyncIterator) return async function* () {
					for await (const event of target) {
						yield event.type === "error" ? { ...event, error: normalize(event.error) } : event;
					}
				};
				if (property === "result") return async () => normalize(await target.result());
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
	};
	return () => terminalCode;
}

async function abortWithinDeadline(session: AgentSession, timeoutMs: number): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			session.abort(),
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/**
 * Isolated Pi SDK transport for every tutor LLM call.
 *
 * Each request gets an in-memory AgentSession with no discovered extensions,
 * skills, context files, prompts, themes, or tools. This prevents recursive
 * loading of the tutor extension and keeps the model limited to the supplied
 * teaching task. ModelRuntime instances are cached per provider so configured
 * auth and provider catalogs can be reused without sharing conversation state.
 */
export class PiSdkLlmClient {
	private readonly runtimes = new Map<string, Promise<ModelRuntime>>();
	private readonly runtimeApiKeys = new Map<string, string>();
	private readonly activeSessions = new Set<AgentSession>();
	private readonly runtimeFactory: PiSdkRuntimeFactory | undefined;
	private readonly completeTimeoutMs: number;
	private readonly abortTimeoutMs: number;
	private readonly lifecycle = new AbortController();
	private closed = false;

	constructor(runtimeFactory?: PiSdkRuntimeFactory, options: PiSdkLlmClientOptions = {}) {
		this.runtimeFactory = runtimeFactory;
		this.completeTimeoutMs = Math.max(1, options.completeTimeoutMs ?? DEFAULT_COMPLETE_TIMEOUT_MS);
		this.abortTimeoutMs = Math.max(1, options.abortTimeoutMs ?? DEFAULT_ABORT_TIMEOUT_MS);
	}

	async complete(
		ctx: ExtensionContext,
		resolved: SdkModelRef,
		request: SdkCompletionRequest,
	): Promise<string> {
		if (this.closed) throw clientClosedError();
		const deadline = Date.now() + this.completeTimeoutMs;

		const hostModel = ctx.modelRegistry.find(resolved.provider, resolved.model);
		if (!hostModel) {
			const err = new Error("MODEL_NOT_FOUND");
			(err as Error & { code?: string }).code = "MODEL_NOT_FOUND";
			throw err;
		}
		const auth = await this.waitFor(ctx.modelRegistry.getApiKeyAndHeaders(hostModel), deadline);
		if (!auth.ok) {
			const err = new Error("NO_API_KEY");
			(err as Error & { code?: string }).code = "NO_API_KEY";
			throw err;
		}

		const runtime = await this.waitFor(this.runtimeFor(ctx, resolved.provider), deadline);
		// OAuth access tokens are not API-key credentials. The isolated runtime
		// already loads Pi's auth store (including refresh/account metadata).
		// Overriding it with an api_key masks OAuth and breaks OAuth-only providers.
		const usesOAuth = ctx.modelRegistry.isUsingOAuth?.(hostModel) ?? false;
		if (!usesOAuth && auth.apiKey && this.runtimeApiKeys.get(resolved.provider) !== auth.apiKey) {
			await this.waitFor(runtime.setRuntimeApiKey(resolved.provider, auth.apiKey), deadline);
			this.runtimeApiKeys.set(resolved.provider, auth.apiKey);
		}

		const runtimeModel = runtime.getModel(resolved.provider, resolved.model);
		if (!runtimeModel) {
			const err = new Error("SDK_MODEL_NOT_FOUND");
			(err as Error & { code?: string }).code = "MODEL_NOT_FOUND";
			throw err;
		}
		const headers: Record<string, string> = { ...(runtimeModel.headers ?? {}) };
		for (const [name, value] of Object.entries(auth.headers ?? {})) {
			if (typeof value === "string") headers[name] = value;
		}
		// Preserve the model catalog's own capability metadata; the tutor imposes no
		// additional output-token ceiling.
		const model = { ...runtimeModel, headers };
		const settingsManager = SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: true, maxRetries: 2 },
		});
		const resourceLoader = new DefaultResourceLoader({
			cwd: ctx.cwd,
			agentDir: getAgentDir(),
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPromptOverride: () => request.systemPrompt,
			appendSystemPromptOverride: () => [],
		});
		await this.waitFor(resourceLoader.reload(), deadline);

		const sessionCreation = createAgentSession({
			cwd: ctx.cwd,
			agentDir: getAgentDir(),
			model,
			modelRuntime: runtime,
			thinkingLevel: request.thinkingLevel ?? "off",
			noTools: "all",
			resourceLoader,
			sessionManager: SessionManager.inMemory(ctx.cwd),
			settingsManager,
		});
		let session: AgentSession;
		try {
			({ session } = await this.waitFor(sessionCreation, deadline));
		} catch (err) {
			// A session created after timeout/dispose is an orphan. Keep a rejection
			// handler attached and dispose it as soon as creation eventually settles.
			void sessionCreation.then(async ({ session: orphan }) => {
				try { await abortWithinDeadline(orphan, this.abortTimeoutMs); } catch { /* already settled */ }
				orphan.dispose();
			}).catch(() => {});
			throw err;
		}
		if (this.closed) {
			session.dispose();
			throw clientClosedError();
		}
		const terminalErrorCode = normalizeSessionFailures(session);
		this.activeSessions.add(session);
		try {
			await this.waitFor(session.prompt(request.prompt, { expandPromptTemplates: false }), deadline);
			const error = session.agent.state.errorMessage;
			if (error) throw sdkFailure(error, terminalErrorCode());
			let last: { content?: Array<{ type?: string; text?: string }>; stopReason?: string; errorMessage?: string } | undefined;
			for (let index = session.messages.length - 1; index >= 0; index--) {
				const message = session.messages[index];
				if (message.role === "assistant") {
					last = message as typeof last;
					break;
				}
			}
			if (!last) throw new Error("EMPTY_RESPONSE");
			if (last.stopReason === "error") throw sdkFailure(last.errorMessage || "provider error", terminalErrorCode());
			const textParts: string[] = [];
			for (const part of last.content ?? []) {
				if (part.type === "text" && typeof part.text === "string") textParts.push(part.text);
			}
			const text = textParts.join(" ").trim();
			if (!text) throw new Error("EMPTY_RESPONSE");
			return text;
		} catch (err) {
			try { await abortWithinDeadline(session, this.abortTimeoutMs); } catch { /* already settled */ }
			throw err;
		} finally {
			if (this.activeSessions.delete(session)) session.dispose();
		}
	}

	async dispose(): Promise<void> {
		if (!this.closed) {
			this.closed = true;
			this.lifecycle.abort();
		}
		const sessions = [...this.activeSessions];
		await Promise.allSettled(sessions.map((session) => abortWithinDeadline(session, this.abortTimeoutMs)));
		for (const session of sessions) {
			if (this.activeSessions.delete(session)) session.dispose();
		}
	}

	private waitFor<T>(operation: Promise<T>, deadline: number): Promise<T> {
		if (this.closed || this.lifecycle.signal.aborted) return Promise.reject(clientClosedError());
		const remaining = deadline - Date.now();
		if (remaining <= 0) return Promise.reject(completionTimeoutError());
		return new Promise<T>((resolve, reject) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			let settled = false;
			const cleanup = () => {
				if (timer) clearTimeout(timer);
				this.lifecycle.signal.removeEventListener("abort", onAbort);
			};
			const finish = (callback: () => void) => {
				if (settled) return;
				settled = true;
				cleanup();
				callback();
			};
			const onAbort = () => finish(() => reject(clientClosedError()));
			this.lifecycle.signal.addEventListener("abort", onAbort, { once: true });
			timer = setTimeout(() => finish(() => reject(completionTimeoutError())), remaining);
			operation.then(
				(value) => finish(() => resolve(value)),
				(error) => finish(() => reject(error)),
			);
		});
	}

	private runtimeFor(ctx: ExtensionContext, provider: string): Promise<ModelRuntime> {
		let pending = this.runtimes.get(provider);
		if (!pending) {
			pending = this.createRuntime(ctx, provider);
			this.runtimes.set(provider, pending);
			pending.catch(() => {
				if (this.runtimes.get(provider) === pending) {
					this.runtimes.delete(provider);
					this.runtimeApiKeys.delete(provider);
				}
			});
		}
		return pending;
	}

	private async createRuntime(ctx: ExtensionContext, provider: string): Promise<ModelRuntime> {
		if (this.runtimeFactory) return this.runtimeFactory(ctx, provider);
		const runtime = await ModelRuntime.create();
		const getRegisteredNativeProvider = (ctx.modelRegistry as typeof ctx.modelRegistry & {
			getRegisteredNativeProvider?: (providerId: string) => unknown;
		}).getRegisteredNativeProvider;
		const nativeProvider = getRegisteredNativeProvider?.call(ctx.modelRegistry, provider);
		if (nativeProvider) {
			runtime.registerNativeProvider(
				nativeProvider as Parameters<ModelRuntime["registerNativeProvider"]>[0],
			);
		} else {
			const getRegisteredProviderConfig = (ctx.modelRegistry as typeof ctx.modelRegistry & {
				getRegisteredProviderConfig?: (providerId: string) => unknown;
			}).getRegisteredProviderConfig;
			const providerConfig = getRegisteredProviderConfig?.call(ctx.modelRegistry, provider);
			if (providerConfig) runtime.registerProvider(provider, providerConfig as never);
		}
		return runtime;
	}
}
