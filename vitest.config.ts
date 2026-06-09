import { defineConfig } from 'vitest/config';

// FooBar's `fetch` handler uses web-standard Request/Response, so the MCP
// transport runs end-to-end in a plain Node environment — which also sidesteps
// vitest-pool-workers' miniflare CJS shim choking on ajv (pulled transitively by
// @modelcontextprotocol/sdk). The real workerd bundle is validated by
// `wrangler deploy --dry-run` and by the live chat → mcp-proxy → module flow.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node'
  }
});
