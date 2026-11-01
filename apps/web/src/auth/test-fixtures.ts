// Client ID Metadata Documents for the registration tests run against a
// preview (task 5.5; test/e2e/clients.spec.ts): a CIMD client must be an
// HTTPS URL on a public host, and the preview's own host is one. Served on
// non-production stages only; prod answers 404. They name loopback redirects
// only, so no browser can be sent anywhere but the tester's own machine.
export const FIXTURE_REDIRECT = "http://127.0.0.1:43110/callback";
export const FIXTURE_PATH = "/test-fixtures/cimd";

export function cimdFixture(name: string, baseURL: string): Record<string, unknown> | undefined {
  const self = `${baseURL}${FIXTURE_PATH}/${name}`;
  const common = {
    redirect_uris: [FIXTURE_REDIRECT],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  };
  switch (name) {
    case "match.json":
      return { client_id: self, client_name: "A2H test client (metadata document)", ...common };
    case "mismatch.json":
      return { client_id: `${baseURL}${FIXTURE_PATH}/someone-else.json`, client_name: "A2H test client (wrong client_id)", ...common };
    default:
      return undefined;
  }
}
