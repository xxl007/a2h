const PR_STAGE = /^pr-([1-9][0-9]*)$/;

/** Same stage names as infra/config.ts `stageInfo`: dev, prod, pr-<n>. */
export function assertStage(stage: string): void {
  if (stage !== "dev" && stage !== "prod" && !PR_STAGE.test(stage)) {
    throw new Error(`Unknown stage "${stage}". A2H deploys only the stages dev, prod and pr-<n>.`);
  }
}

/**
 * The label shown in non-production emails, or undefined on prod (where no
 * label is ever shown): "development" for dev, "preview pr-<n>" for previews.
 */
export function stageLabel(stage: string): string | undefined {
  assertStage(stage);
  if (stage === "prod") return undefined;
  if (stage === "dev") return "development";
  return `preview ${stage}`;
}
