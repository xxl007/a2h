// The page body, as a pure server component: props in, markup out.
// No colours, no fonts, no client state: plain text on the browser's default
// background (ADR 0003; the owner's no-invented-palette rule).

export interface HomeProps {
  /** The SST stage name (`STAGE`), e.g. `dev` or `pr-12`. */
  stage?: string | undefined;
  /** The public MCP endpoint of the same stage (`MCP_URL`). */
  mcpUrl?: string | undefined;
}

export function Home({ stage, mcpUrl }: HomeProps) {
  const showStage = Boolean(stage);
  const showMcp = Boolean(mcpUrl);
  return (
    <main>
      <h1>A2H</h1>
      <p>
        A2H (Agent-to-Human) is a protocol and platform that lets AI agents find consenting
        humans, send them questions on behalf of an accountable principal, and bring back
        attested answers.
      </p>
      {showStage || showMcp ? (
        <dl>
          {showStage ? (
            <>
              <dt>Stage</dt>
              <dd>{stage}</dd>
            </>
          ) : null}
          {showMcp ? (
            <>
              <dt>MCP endpoint</dt>
              <dd>
                <code>{mcpUrl}</code>
              </dd>
            </>
          ) : null}
        </dl>
      ) : null}
    </main>
  );
}
