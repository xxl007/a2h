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
    //
    // The same transform names every role `a2h-<stage>-<readable>-<hash>`
    // (roleName() in infra/config.ts): the deploy roles may only create
    // `role/a2h-*`, and SST's physicalName(64, …) drops the app prefix on long
    // logical names. SST's naming transformation (component.ts) runs before
    // this one (a component's transformations precede the stack's in Pulumi's
    // resource.js), so this value is the one used. See infra/README.md, "IAM
    // role names". Never change roleName() after the first deploy without a
    // migration note.
    const { roleName, workloadBoundaryArn } = await import("./infra/config.ts");
    const boundary = aws.getCallerIdentityOutput().accountId.apply(workloadBoundaryArn);
    $transform(aws.iam.Role, (args, opts, name) => {
      // `Role.get` only reads an existing role; there is nothing to create.
      if (opts.id) return;
      args.permissionsBoundary = boundary;
      args.name = roleName($app.stage, name);
    });

    const { deploy } = await import("./infra/index.ts");
    // $cli.command is the SST CLI command ("deploy", "remove", …), injected
    // by SST as an esbuild define (pkg/project/run.go). It lets a pr stage be
    // removed after its database secret is gone (infra/database.ts).
    return deploy($app.stage, $cli.command);
  },
});
