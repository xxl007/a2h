// The stage line of every screen ("Test stage {stage}. Not the live
// service."): the stage name off prod, undefined on prod (design.md S0).
export function stageNameFromEnv(env: Record<string, string | undefined> = process.env): string | undefined {
  const stage = env["STAGE"];
  return stage && stage !== "prod" ? stage : undefined;
}

/** Next.js `searchParams` as URLSearchParams (repeated keys kept). */
export function toSearchParams(raw: Record<string, string | string[] | undefined>): URLSearchParams {
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    if (Array.isArray(value)) for (const v of value) out.append(key, v);
    else if (value !== undefined) out.append(key, value);
  }
  return out;
}
