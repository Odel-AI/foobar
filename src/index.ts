/**
 * FooBar — the Odel reference / test module.
 *
 * A deliberately feature-complete module that exercises every part of
 * `@odel/module-sdk`. It exists so that:
 *  - module authors have a copy-paste reference for each capability,
 *  - client/inspector developers have a stable target to test against,
 *  - we can verify the SDK + the Odel context/secrets envelope end-to-end.
 *
 * As the SDK grows, FooBar grows with it — every new feature should show up here.
 *
 * Capabilities demonstrated today:
 *  - tools with typed Zod input (`validators`)
 *  - the standard `{ success, … } | { success:false, error }` response shape (`SuccessResponseSchema`)
 *  - reading per-request identity context (`getModuleContext`)
 *  - code-declared config + per-user secrets (`configSchema` + `parseConfig`)
 *  - structured `ModuleError`s for client error-handling
 *  - advertising declared config over MCP via the `odel://config` resource
 *    (this is what the inspector's Vars tab reads to prefill — see Odel#121)
 */

import { createOdelServer, WebStandardStreamableHTTPServerTransport, type CallToolResult } from '@odel/module-sdk/server';
import {
	getModuleContext,
	parseConfig,
	validators,
	SuccessResponseSchema,
	ModuleError,
	type ModuleContext
} from '@odel/module-sdk';
import { z } from 'zod';

/**
 * Config this module declares it needs. The inspector's Vars tab can read this
 * (via the `odel://config` resource below) and prompt for the values; mcp-proxy
 * injects the real ones in production. `.describe()` is placed last so it lands
 * on the outer schema and shows up in the manifest.
 */
export const configSchema = z.object({
	FOOBAR_API_KEY: z.string().min(1).describe('Any non-empty string — FooBar only checks presence, never the value'),
	FOOBAR_WEBHOOK_URL: z.string().url().optional().describe('Optional demo webhook URL (must be a valid URL if provided)')
});

/** Wrap any JSON-serialisable result as an MCP tool result. */
function json(result: unknown): CallToolResult {
	return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result as Record<string, unknown> };
}

const computeOutput = SuccessResponseSchema(z.object({ result: z.number() }));
type ComputeOutput = z.infer<typeof computeOutput>;

function buildServer() {
	// createOdelServer always exposes the `odel://config` marker resource
	// (here populated from configSchema), so Odel tooling can identify FooBar
	// as an Odel module and discover its declared secrets.
	const server = createOdelServer({ name: 'foobar', version: '0.1.0', configSchema });

	// 1) echo — simplest tool, and demonstrates a standard MCP output schema:
	//    declaring `outputSchema` makes the SDK advertise it in tools/list and
	//    validate the returned `structuredContent` against it.
	server.registerTool(
		'echo',
		{
			description: 'Echo a message back',
			inputSchema: { message: validators.nonEmptyString() },
			outputSchema: { message: z.string(), length: z.number() }
		},
		async ({ message }) => json({ message, length: message.length })
	);

	// 2) whoami — surfaces the Odel identity context from the request envelope.
	server.registerTool('whoami', { description: 'Return the Odel caller context', inputSchema: {} }, async (_args, extra) => {
		const ctx: ModuleContext = getModuleContext(extra);
		return json(ctx);
	});

	// 3) compute — typed numeric input + the standard success/error response shape.
	server.registerTool(
		'compute',
		{
			description: 'Run a binary arithmetic operation',
			inputSchema: {
				a: z.number().describe('First operand'),
				b: z.number().describe('Second operand'),
				op: validators.enumFrom(['add', 'subtract', 'multiply', 'divide'] as const).describe('Operation')
			}
		},
		async ({ a, b, op }) => {
			let out: ComputeOutput;
			switch (op) {
				case 'add':
					out = { success: true, result: a + b };
					break;
				case 'subtract':
					out = { success: true, result: a - b };
					break;
				case 'multiply':
					out = { success: true, result: a * b };
					break;
				case 'divide':
					out = b === 0 ? { success: false, error: 'Division by zero' } : { success: true, result: a / b };
					break;
			}
			return json(out);
		}
	);

	// 4) check_config — exercises the secrets envelope via parseConfig.
	//    Throws ModuleError(MISSING_SECRET) if FOOBAR_API_KEY is absent, or
	//    ModuleError(INVALID_SECRET) if FOOBAR_WEBHOOK_URL is present but invalid.
	//    Never returns the secret value — only safe, masked metadata.
	server.registerTool(
		'check_config',
		{ description: 'Validate the injected config/secrets and report (masked) status', inputSchema: {} },
		async (_args, extra) => {
			const cfg = parseConfig(configSchema, extra);
			return json({
				success: true,
				apiKeyPresent: true,
				apiKeyLength: cfg.FOOBAR_API_KEY.length,
				webhookConfigured: Boolean(cfg.FOOBAR_WEBHOOK_URL)
			});
		}
	);

	// 5) boom — deliberately throws a chosen ModuleError so client devs can test
	//    error handling against every error category.
	server.registerTool(
		'boom',
		{
			description: 'Throw a ModuleError of the requested kind (for testing client error handling)',
			inputSchema: {
				kind: validators.enumFrom(['api', 'rate_limit', 'timeout', 'not_found', 'internal'] as const).describe('Error kind')
			}
		},
		async ({ kind }) => {
			switch (kind) {
				case 'api':
					throw ModuleError.apiError('Simulated upstream API failure', { statusCode: 502 });
				case 'rate_limit':
					throw ModuleError.rateLimitError(30);
				case 'timeout':
					throw ModuleError.timeout('simulated-operation', 1000);
				case 'not_found':
					throw ModuleError.notFound('Widget', 'widget_123');
				case 'internal':
					throw ModuleError.internalError('Simulated internal error');
			}
		}
	);

	// 6) slow_echo — bounded delay, so client devs can exercise loading/timeout UI.
	server.registerTool(
		'slow_echo',
		{
			description: 'Echo a message after a delay (0–5000 ms) — useful for testing client timeouts/loading states',
			inputSchema: {
				message: validators.nonEmptyString(),
				delayMs: z.number().int().min(0).max(5000).describe('Delay before responding, in milliseconds')
			}
		},
		async ({ message, delayMs }) => {
			await new Promise(resolve => setTimeout(resolve, delayMs));
			return json({ success: true, message, delayedMs: delayMs });
		}
	);

	// Note: the `odel://config` resource is registered automatically by
	// createOdelServer above — no need to wire it here.

	return server;
}

export default {
	async fetch(request: Request): Promise<Response> {
		if (request.method === 'GET' && new URL(request.url).pathname === '/health') {
			return Response.json({ status: 'ok', module: 'foobar' });
		}

		const server = buildServer();
		const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
		await server.connect(transport);
		return transport.handleRequest(request);
	}
};
