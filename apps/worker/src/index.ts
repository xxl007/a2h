// M0 placeholder entry point (step 4): one log line, then idle until stopped,
// so the Fargate service stays healthy on the first `dev` deploy. Step 5
// replaces it with the pg-boss worker.
console.log(
  JSON.stringify({ level: "info", msg: "placeholder worker started", stage: process.env.STAGE }),
);

const keepAlive = setInterval(() => {}, 60 * 60 * 1000);

process.on("SIGTERM", () => {
  clearInterval(keepAlive);
  process.exit(0);
});

export {};
