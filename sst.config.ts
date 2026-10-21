// SST declares $config, $app, $transform, aws and sst as ambient globals in
// this generated file; they cannot be imported, so the reference is required.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
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
    // Contract amendment 1: every IAM role this app creates carries the
    // workload permissions boundary (deny all IAM and STS role assumption).
    // Registered before infra/index.ts is imported and before any component
    // exists: Pulumi copies the stack's transformations into each resource
    // when it is constructed, and children inherit them from their parent,
    // so roles SST creates inside components (Fargate task and execution
    // roles, Nextjs function roles) are covered. See infra/README.md.
    const { workloadBoundaryArn } = await import("./infra/config.ts");
    const boundary = aws.getCallerIdentityOutput().accountId.apply(workloadBoundaryArn);
    $transform(aws.iam.Role, (args, opts) => {
      // `Role.get` only reads an existing role; there is nothing to create.
      if (opts.id) return;
      args.permissionsBoundary = boundary;
    });

    const { deploy } = await import("./infra/index.ts");
    return deploy($app.stage);
  },
});
