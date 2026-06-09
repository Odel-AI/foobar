import { describe, test, expect } from 'vitest';
import worker from './index';

/** Parse an MCP JSON-RPC response (application/json or SSE frame). */
async function parseMcp(response: Response): Promise<{
	result?: { content?: Array<{ text: string }>; structuredContent?: unknown; tools?: Array<{ name: string }>; isError?: boolean };
	error?: { code: number; message: string };
}> {
	const contentType = response.headers.get('content-type') ?? '';
	if (contentType.includes('text/event-stream')) {
		const text = await response.text();
		const dataLine = text.split('\n').find((l) => l.startsWith('data: '));
		if (!dataLine) throw new Error('No data frame in SSE response');
		return JSON.parse(dataLine.slice(6));
	}
	return response.json();
}

function rpc(method: string, params?: Record<string, unknown>) {
	return worker
		.fetch(
			new Request('http://foobar/mcp', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
				body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
			})
		)
		.then(parseMcp);
}

/** The Odel envelope the way mcp-proxy injects it. */
function envelope(context: Record<string, unknown>, secrets: Record<string, string> = {}) {
	return { 'app.odel/context': context, 'app.odel/secrets': secrets };
}

/** Call a tool and return the parsed business JSON from its text content. */
async function callTool(name: string, args: Record<string, unknown>, _meta?: Record<string, unknown>) {
	const parsed = await rpc('tools/call', { name, arguments: args, ...(_meta ? { _meta } : {}) });
	return parsed;
}

describe('FooBar — MCP compliance', () => {
	test('lists all six tools', async () => {
		const parsed = await rpc('tools/list');
		const names = (parsed.result?.tools ?? []).map((t) => t.name).sort();
		expect(names).toEqual(['boom', 'check_config', 'compute', 'echo', 'slow_echo', 'whoami']);
	});
});

describe('FooBar — basic tools', () => {
	test('echo returns message + length', async () => {
		const parsed = await callTool('echo', { message: 'hello' });
		expect(parsed.result?.structuredContent).toEqual({ message: 'hello', length: 5 });
	});

	test('compute add', async () => {
		const parsed = await callTool('compute', { a: 2, b: 3, op: 'add' });
		expect(JSON.parse(parsed.result!.content![0].text)).toEqual({ success: true, result: 5 });
	});

	test('compute divide-by-zero returns error branch', async () => {
		const parsed = await callTool('compute', { a: 1, b: 0, op: 'divide' });
		expect(JSON.parse(parsed.result!.content![0].text)).toEqual({ success: false, error: 'Division by zero' });
	});
});

describe('FooBar — context envelope (app.odel/context)', () => {
	test('whoami reflects the injected identity', async () => {
		const parsed = await callTool('whoami', {}, envelope({ userId: 'u_1', displayName: 'Ada' }));
		const ctx = JSON.parse(parsed.result!.content![0].text);
		expect(ctx.userId).toBe('u_1');
		expect(ctx.displayName).toBe('Ada');
	});

	test('whoami falls back to anonymous when no envelope is present', async () => {
		const parsed = await callTool('whoami', {});
		const ctx = JSON.parse(parsed.result!.content![0].text);
		// DEFAULT_MODULE_CONTEXT fallback — not the injected user.
		expect(ctx.userId).not.toBe('u_1');
		expect(typeof ctx.requestId).toBe('string');
	});
});

describe('FooBar — secrets envelope (app.odel/secrets)', () => {
	test('check_config reports masked status when the API key is injected', async () => {
		const parsed = await callTool('check_config', {}, envelope({ userId: 'u_1' }, { FOOBAR_API_KEY: 'demo-key' }));
		expect(JSON.parse(parsed.result!.content![0].text)).toEqual({
			success: true,
			apiKeyPresent: true,
			apiKeyLength: 'demo-key'.length,
			webhookConfigured: false
		});
	});

	test('check_config errors (MISSING_SECRET) when the API key is absent', async () => {
		const parsed = await callTool('check_config', {}, envelope({ userId: 'u_1' }, {}));
		// A thrown ModuleError surfaces as an MCP tool error result.
		const errored = parsed.result?.isError === true || parsed.error != null;
		expect(errored).toBe(true);
		const text = parsed.result?.content?.[0]?.text ?? parsed.error?.message ?? '';
		expect(text).toMatch(/FOOBAR_API_KEY|secret/i);
	});
});
