// What the e2e flows need from the environment (playwright.config.ts).
export const WEB_URL = (process.env["A2H_WEB_URL"] ?? "http://localhost:3210").replace(/\/$/, "");
export const MCP_URL = process.env["A2H_MCP_URL"] ?? "http://localhost:3001/mcp";
export const ISSUER = `${WEB_URL}/api/auth`;
export const EMAIL = process.env["A2H_TEST_EMAIL"] ?? "owner@example.com";
export const EMAIL_2 = process.env["A2H_TEST_EMAIL_2"] ?? "second@example.com";
export const STAGE = process.env["A2H_STAGE"] ?? "pr-99";
/** CIMD needs an https client_id on a public host: only a deployed stage can serve its own test documents. */
export const HTTPS_STAGE = WEB_URL.startsWith("https://");
