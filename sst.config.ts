/// <reference path="./.sst/platform/config.d.ts" />
// Thin entry point. The stacks live in infra/ (see infra/README.md).
// SST forbids top-level imports here; infra is imported inside run().

export default $config({
  app(input) {
    // Mirrors infra/config.ts (REGION, stage kinds); app() cannot import.
    const longLived = input.stage === "dev" || input.stage === "prod";
    return {
      name: "a2h",
      home: "aws",
      providers: { aws: { region: "eu-west-3" } },
      removal: longLived ? "retain" : "remove",
      protect: longLived,
      version: "4.17.2",
    };
  },
  async run() {
    const { deploy } = await import("./infra/index.ts");
    return deploy($app.stage);
  },
});
