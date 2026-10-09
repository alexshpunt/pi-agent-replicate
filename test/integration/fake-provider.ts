import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { once } from "node:events";
import { existsSync } from "node:fs";
interface ChatMessage {
	role?: string;
	content?: unknown;
}

interface ChatRequest {
	model?: string;
	messages?: ChatMessage[];
	tools?: Array<{ function?: { name?: string } }>;
}

interface ToolCall {
	name: string;
	arguments: Record<string, unknown>;
}

interface ResponsePlan {
	text?: string;

	holdQuiet?: boolean;
	emptyCompletion?: boolean;
	toolCalls?: ToolCall[];
}

export const TEST_MODEL = "pi-integration/test";

export interface ProviderRequest {
	model?: string;
	status: number;
	messages: ChatMessage[];
	tools: string[];
	text: string;
	userText: string;
}

const providerRequests: ProviderRequest[] = [];

export function getProviderRequests(): readonly ProviderRequest[] {
	return providerRequests;
}

export function resetProviderRequests(): void {
	providerRequests.length = 0;
}

async function readJson(request: IncomingMessage): Promise<ChatRequest> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.from(chunk));
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as ChatRequest;
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(part): part is { type?: string; text?: string } =>
				typeof part === "object" && part !== null,
		)
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

function requestText(request: ChatRequest): string {
	return (request.messages ?? [])
		.map((message) => messageText(message.content))
		.join("\n");
}

function lastUserText(request: ChatRequest): string {
	const message = [...(request.messages ?? [])]
		.reverse()
		.find((entry) => entry.role === "user");
	return messageText(message?.content);
}

function toolNames(request: ChatRequest): Set<string> {
	return new Set(
		(request.tools ?? [])
			.map((tool) => tool.function?.name)
			.filter((name): name is string => typeof name === "string"),
	);
}

function providerRequest(request: ChatRequest, status: number): ProviderRequest {
	return {
		model: request.model,
		status,
		messages: request.messages ?? [],
		tools: [...toolNames(request)].sort(),
		text: requestText(request),
		userText: lastUserText(request),
	};
}

function quotedValue(source: string, key: string): string | undefined {
	const match = source.match(
		new RegExp(`\\b${key}:\\s*"((?:\\\\.|[^"\\\\])*)"`),
	);
	if (!match) return undefined;
	try {
		return JSON.parse(`"${match[1]}"`) as string;
	} catch {
		return match[1];
	}
}

function subagentCalls(source: string): ToolCall[] {
	const names = [...source.matchAll(/\bname:\s*"((?:\\.|[^"\\])*)"/g)];
	return names.flatMap((match, index) => {
		const section = source.slice(match.index, names[index + 1]?.index);
		const name = quotedValue(section, "name");
		const task = quotedValue(section, "task");
		if (!name || !task) return [];

		const agent = quotedValue(section, "agent");
		const model = quotedValue(section, "model");
		const cwd = quotedValue(section, "cwd");
		const systemPrompt = quotedValue(section, "systemPrompt");
		const interactive = section.match(/\binteractive:\s*(true|false)/)?.[1];
		const skills = quotedValue(section, "skills");
		const hasSkills = /\bskills:\s*"/.test(section);
		const branch = section.match(
			/\bworktree:\s*\{\s*branch:\s*"((?:\\.|[^"\\])*)"/,
		)?.[1];
		return [
			{
				name: "subagent",
				arguments: {
					name,
					...(agent ? { agent } : {}),
					...(model ? { model } : {}),
					...(cwd ? { cwd } : {}),
					...(systemPrompt ? { systemPrompt } : {}),
					...(interactive ? { interactive: interactive === "true" } : {}),
					...(hasSkills ? { skills: skills ?? "" } : {}),
					...(section.includes("autoExit: false") ? { autoExit: false } : {}),
					...(section.includes("fork: true") ? { fork: true } : {}),
					...(branch ? { worktree: { branch } } : {}),
					task,
				},
			},
		];
	});
}

function subagentResumeCall(source: string): ToolCall | null {
	const sessionPath = quotedValue(source, "sessionPath");
	if (!sessionPath) return null;
	const name = quotedValue(source, "name");
	const message = quotedValue(source, "message");
	return {
		name: "subagent_resume",
		arguments: {
			sessionPath,
			...(name ? { name } : {}),
			...(message ? { message } : {}),
			...(/\bautoExit:\s*false\b/.test(source) ? { autoExit: false } : {}),
		},
	};
}

function bashCommand(source: string): string | undefined {
	const commandStart = source.search(/\becho\s+['"]/);
	if (commandStart === -1) return undefined;
	const command = source
		.slice(commandStart)
		.split(/\n(?:After|Do not|Just|Use the|Then |You must|First,|Call )/)[0]
		.trim();
	// Lifecycle tests with observable START_/STATUS_ markers need the real delay;
	// other delays only slow the suite.
	return (
		(command.includes("STATUS_") || command.includes("START_")
			? command
			: command.replace(/\bsleep\s+\d+;?\s*/g, "")) || undefined
	);
}

function markerText(source: string): string | undefined {
	const matches = [...source.matchAll(/(?:Return|return) exactly ([A-Za-z0-9_-]+)/g)];
	return matches.at(-1)?.[1];
}

async function waitForIntegrationGate(source: string): Promise<void> {
	const path = source.match(/INTEGRATION_WAIT_FOR_FILE:\s*(\S+)/)?.[1];
	if (!path) return;
	const deadline = Date.now() + 30_000;
	while (!existsSync(path) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	if (!existsSync(path)) throw new Error(`Integration gate was not opened: ${path}`);
}


async function planResponse(request: ChatRequest): Promise<ResponsePlan> {
	const names = toolNames(request);
	const source = requestText(request);
	const user = lastUserText(request);
	const lastRole = request.messages?.at(-1)?.role;

	if (names.has("replicate") && lastRole !== "tool" && /Call the replicate tool/i.test(user)) {
		const task = quotedValue(user, "task");
		if (task) return { toolCalls: [{ name: "replicate", arguments: { task } }] };
	}

	if (names.has("replication_probe") && user.includes("Your assignment:") && /Use replication_probe/.test(user) && lastRole !== "tool") {
		return { toolCalls: [{ name: "replication_probe", arguments: {} }] };
	}
	const replicaOwner = (request.messages ?? []).some((message) => message.role === "user" && messageText(message.content).includes("Your assignment:\nREPLICATION_NESTED_OWNER"));
	if (replicaOwner && !/Call the teleport tool/i.test(user)) {
		if (user.includes("Your assignment:\nREPLICATION_NESTED_OWNER") && lastRole !== "tool") {
			const gate = user.match(/INTEGRATION_DESCENDANT_GATE:\s*(\S+)/)?.[1];
			if (gate) return { toolCalls: [{ name: "replicate", arguments: { task: `INTEGRATION_WAIT_FOR_FILE: ${gate} Return exactly REPLICATION_GRANDCHILD` } }] };
		}
		if (/Replica .* completed\./.test(user) && /REPLICATION_GRANDCHILD/.test(user)) return { text: "REPLICATION_NESTED_SUMMARY" };
		if (lastRole === "tool") return { text: "REPLICATION_OWNER_WAITING" };
	}
	if (user.includes("Your assignment:") && /REPLICATION_FAIL_WITH_HISTORY/.test(user)) {
		return { text: "REPLICA_FIRST_ANSWER", toolCalls: [{ name: "bash", arguments: { command: "echo TOOL_OUTPUT_NOT_AN_ANSWER" } }] };
	}
	if (names.has("teleport") && lastRole !== "tool" && /Call the teleport tool/i.test(user)) {
		const action = quotedValue(user, "action");
		const target = quotedValue(user, "target");
		if (action) return { toolCalls: [{ name: "teleport", arguments: { action, ...(target ? { target } : {}) } }] };
	}

	if (/previous process became (?:stale|unavailable)/i.test(user)) {
		if (/subagent-resume\/crash-/i.test(user)) return { text: "QUIET_RECOVERY_COMPLETE" };
		if (/subagent-resume\/stale-/i.test(user)) return { holdQuiet: true };
	}

	if (
		/Call the subagent tool/i.test(user) &&
		!/Sub-agent "[^"]+" launched and is now running in the background/.test(source) &&
		/INTEGRATION_(?:LARGE_RESULT|HOLD_QUIET_ONCE|ALWAYS_QUIET)/.test(user)
	) {
		const calls = subagentCalls(user);
		if (calls.length > 0) return { toolCalls: calls };
	}


	if (
		/INTEGRATION_ALWAYS_QUIET/.test(source) &&
		(!/Sub-agent "[^"]+" launched and is now running in the background/.test(source) ||
			/previous process became (?:stale|unavailable)/i.test(user))
	) return { holdQuiet: true };

	if (
		/INTEGRATION_LARGE_RESULT/.test(source) &&
		!/Sub-agent "[^"]+" launched and is now running in the background/.test(source)
	) {
		return { text: `LARGE_RESULT_BEGIN\n${"x".repeat(20_000)}\nLARGE_RESULT_END` };
	}
	if (/INTEGRATION_HOLD_QUIET_ONCE/.test(source)) {
		if (/previous process became (?:stale|unavailable)/i.test(user)) {
			return { text: "QUIET_RECOVERY_COMPLETE" };
		}
		if (!/Sub-agent "[^"]+" launched and is now running in the background/.test(source)) {
			return { holdQuiet: true };
		}
	}

	const resumed = !/Call the subagent_resume tool/i.test(user)
		? user.match(/RESUME_FOLLOWUP_INPUT:\s*([a-z0-9]+)/i)?.[1]
		: undefined;
	if (resumed) return { text: `RESUME_RESULT_${resumed}` };

	if (names.has("subagent_done") && /CLOSE_PERSISTENT_CHILD/.test(source)) {
		return {
			toolCalls: [
				{
					name: "subagent_done",
					arguments: { summary: "SETTLED_TWO" },
				},
			],
		};
	}

	// caller_ping is always allowlisted for public children; only use it when the
	// prompt actually asks for a help ping (test-ping), not for ordinary tasks.
	if (
		lastRole !== "tool" &&
		names.has("caller_ping") &&
		/caller_ping|ONLY call caller_ping|call the caller_ping tool/i.test(source)
	) {
		return {
			toolCalls: [
				{ name: "caller_ping", arguments: { message: "PING: integration" } },
			],
		};
	}

	if (
		names.has("consumer_tree_nested_launch") &&
		lastRole !== "tool" &&
		!source.includes("nested leaf launched")
	) {
		return { toolCalls: [{ name: "consumer_tree_nested_launch", arguments: {} }] };
	}

	const consumerProbe = [
		"consumer_tree_nested_probe",
		"consumer_tree_open_probe",
		"consumer_tree_transition_probe",
		"consumer_tree_metadata_probe",
		"consumer_tree_pending_callback_probe",
		"consumer_tree_root_failure_probe",
		"consumer_tree_interrupt_probe",
		"consumer_tree_worktree_probe",
		"consumer_tree_cancel_probe",
		"consumer_tree_cancel_unconfirmed_probe",
	].find((name) => names.has(name));
	if (consumerProbe && lastRole !== "tool") {
		return {
			toolCalls: [{ name: consumerProbe, arguments: {} }],
		};
	}


	await waitForIntegrationGate(user);

	const descendantOwner = source.includes("DESCENDANT_OWNER_FIXTURE");
	if (
		descendantOwner &&
		names.has("subagent_done") &&
		((lastRole !== "user" && source.includes("OWNER_FOUR")) || /Sub-agent "Nested-[^"]+" (?:completed|failed|needs help|settled)/i.test(source) || source.includes("GRANDCHILD_DONE"))
	) {
		return { toolCalls: [{ name: "subagent_done", arguments: { summary: "OWNER_FINAL" } }] };
	}

	if (lastRole === "tool") {
	if (
		descendantOwner &&
		source.includes("INTEGRATION_OWNER_AFTER_CHILD") &&
		lastRole === "tool" &&
		names.has("subagent")
	) {
		return { text: "OWNER_WAITING" };
	}

		return { text: markerText(source) ?? "completed" };
	}


	if (
		names.has("subagent_resume") &&
		!/Session "[^"]+" resumed\./.test(source)
	) {
		const resumeCall = subagentResumeCall(user);
		if (resumeCall) return { toolCalls: [resumeCall] };
	}
	if (
		descendantOwner &&
		names.has("subagent") &&
		!/Sub-agent "[^"]+" launched and is now running in the background/.test(source)
	) {
		const gate = source.match(/INTEGRATION_DESCENDANT_GATE:\s*(\S+)/)?.[1];
		if (gate) {
			const suffix = gate.replace(/[^A-Za-z0-9]/g, "").slice(-12);
			return {
				toolCalls: [
					{
						name: "subagent",
						arguments: {
							name: `Nested-${suffix}`,
							agent: "test-echo",
							task: `INTEGRATION_WAIT_FOR_FILE: ${gate} Return exactly GRANDCHILD_DONE`,
						},
					},
				],
			};
		}
	}

	if (names.has("subagent")) {
	if (
		descendantOwner &&
		source.includes("INTEGRATION_OWNER_AFTER_CHILD") &&
		/Sub-agent "[^"]+" launched and is now running in the background/.test(source)
	) {
		if (
			source.includes("INTEGRATION_DELAY_OWNER_AFTER_CHILD") &&
			source.includes("GRANDCHILD_DONE")
		) {
			await new Promise((resolve) => setTimeout(resolve, 2_500));
		}
		return {
			text: source.includes("GRANDCHILD_DONE")
				? "OWNER_AFTER_CHILD"
				: "OWNER_WAITING",
		};
	}

		if (/Sub-agent "[^"]+" launched and is now running in the background/.test(source)) {
			const continuation = source.match(
				/\b(?:say|respond with)\s+([A-Z][A-Za-z0-9_]*)/,
			)?.[1];
			return { text: markerText(user) ?? continuation ?? "completed" };
		}
		const calls = subagentCalls(source);
		if (calls.length > 0) {
			return {
				toolCalls: [
					...(names.has("subagents_list") && /subagents_list/i.test(source)
						? [{ name: "subagents_list", arguments: {} }]
						: []),
					...calls,
				],
			};
		}
		// If no subagent call was requested, let the provider handle other tools
		// (for example bash in a forked child that also auto-loaded this extension).
	}

	if (names.has("bash")) {
		const command = bashCommand(source);
		if (command)
			return { toolCalls: [{ name: "bash", arguments: { command } }] };
	}

	const marker = markerText(source);
	return marker === "EMPTY_COMPLETION"
		? { emptyCompletion: true }
		: { text: marker ?? "completed" };
}

function writeEvent(
	response: ServerResponse,
	request: ChatRequest,
	delta: Record<string, unknown>,
	finishReason: string | null,
): void {
	response.write(
		`data: ${JSON.stringify({
			id: `chatcmpl-${Date.now()}`,
			object: "chat.completion.chunk",
			created: Math.floor(Date.now() / 1000),
			model: request.model ?? TEST_MODEL,
			choices: [{ index: 0, delta, finish_reason: finishReason }],
		})}\n\n`,
	);
}

function writeResponse(
	response: ServerResponse,
	request: ChatRequest,
	plan: ResponsePlan,
): void {
	response.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache",
		connection: "keep-alive",
	});

	if (plan.toolCalls && plan.toolCalls.length > 0) {
		if (plan.text) writeEvent(response, request, { role: "assistant", content: plan.text }, null);
		writeEvent(
			response,
			request,
			{
				role: "assistant",
				tool_calls: plan.toolCalls.map((toolCall, index) => ({
					index,
					id: `call_${Date.now()}_${index}`,
					type: "function",
					function: {
						name: toolCall.name,
						arguments: JSON.stringify(toolCall.arguments),
					},
				})),
			},
			null,
		);
		writeEvent(response, request, {}, "tool_calls");
	} else {
		writeEvent(
			response,
			request,
			plan.emptyCompletion
				? { role: "assistant" }
				: { role: "assistant", content: plan.text ?? "completed" },
			null,
		);
		writeEvent(response, request, {}, "stop");
	}

	response.end("data: [DONE]\n\n");
}

const server = createServer(async (request, response) => {
	if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
		response.writeHead(404).end();
		return;
	}
	try {
		const chatRequest = await readJson(request);
		if (chatRequest.messages?.at(-1)?.role === "tool" && lastUserText(chatRequest).includes("Your assignment:") && lastUserText(chatRequest).includes("REPLICATION_FAIL_WITH_HISTORY")) {
			providerRequests.push(providerRequest(chatRequest, 400));
			response.writeHead(400, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: { message: "deterministic replica terminal failure" } }));
			return;
		}
		if (chatRequest.model === "fallback-primary" || chatRequest.model === "fallback-fail") {
			providerRequests.push(providerRequest(chatRequest, 503));
			response.writeHead(503, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: { message: "deterministic fallback provider failure" } }));
			return;
		}
		providerRequests.push(providerRequest(chatRequest, 200));

		const plan = await planResponse(chatRequest);
		if (plan.holdQuiet) {
			response.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});
			response.flushHeaders();
			return;
		}
		writeResponse(response, chatRequest, plan);
	} catch (error) {
		providerRequests.push({ status: 500, messages: [], tools: [], text: "", userText: "" });
		response.writeHead(500, { "content-type": "application/json" });
		response.end(
			JSON.stringify({
				error: {
					message: error instanceof Error ? error.message : String(error),
				},
			}),
		);
	}
});

server.listen(0, "127.0.0.1");
await once(server, "listening");
server.unref();

const address = server.address();
if (!address || typeof address === "string")
	throw new Error("Expected fake provider to bind to a TCP port");

export const TEST_PROVIDER_URL = `http://127.0.0.1:${address.port}/v1`;
