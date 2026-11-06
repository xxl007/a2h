// When recording a decision fails, the log says enough to find the cause on a
// deployed stage (pr-82: "approval decision not recorded" with code "Error"
// and nothing else) without carrying what a database message can quote: the
// question, the parameters, the SQL. Only the SQLSTATE and the class names.
import { describe, expect, test } from "vitest";
import { decide } from "../src/approval/decide";
import { createLogger } from "../src/log";

const QUESTION = "Which cover would make you pick this picture book up first?";
/** Well-formed (packages/protocol ApprovalTokenSchema), so the decision reaches the database. */
const TOKEN = "a".repeat(42) + "A";

/** What drizzle throws on the Data API: "Failed query: <sql>\nparams: <values>", the driver's error as cause. */
function dataApiFailure(): Error {
  const cause = Object.assign(new Error(`ERROR: new row violates check constraint "x" Detail: Failing row contains (${QUESTION}).; SQLState: 23514`), {
    name: "DatabaseErrorException",
    $metadata: { httpStatusCode: 400 },
  });
  return new Error(`Failed query: update "requests" set "question" = :1\nparams: ${QUESTION}`, { cause });
}

/** A read made by the action itself, outside `decideApproval`'s transaction (review F2: there is none). */
class ReadOutsideTransaction extends Error {
  override name = "ReadOutsideTransaction";
}

/** A database whose transaction fails as given; any read outside it is its own, distinct failure. */
function failingDb(inTransaction: () => never): never {
  const outside = () => {
    throw new ReadOutsideTransaction("the action read the request on its own");
  };
  return { select: outside, update: outside, insert: outside, execute: outside, transaction: inTransaction } as never;
}

function throwingDb(): never {
  return failingDb(() => {
    throw dataApiFailure();
  });
}

describe("decide: a failure to record the decision", () => {
  test("is logged with the SQLSTATE and the cause's class, never the question, the SQL or the parameters", async () => {
    const lines: string[] = [];
    const form = new FormData();
    form.set("decision", "send");
    form.set("question", QUESTION);
    const state = await decide(
      { db: throwingDb(), feeRate: 0.2, logger: createLogger({ write: (l) => lines.push(l), level: "debug" }) },
      { requestId: "A2H-fd84", token: TOKEN, principalId: "user-1", form, reference: "ref_0123456789abcdef" },
    );
    expect(state).toMatchObject({ state: "error", reference: "ref_0123456789abcdef" });
    const errors = lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l["level"] === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      code: "Error",
      cause: "DatabaseErrorException",
      sql_state: "23514",
      // The first clause of the driver's message, quoted values and parentheses removed.
      db_error: "ERROR: new row violates check constraint …",
      request_id: "ref_0123456789abcdef",
    });
    const all = lines.join("\n");
    expect(all).not.toContain("picture book");
    expect(all).not.toMatch(/Failed query|params:|update "requests"|Failing row|Detail/);
  });

  test("a Data API error without a SQLSTATE: its first clause, values removed", async () => {
    const lines: string[] = [];
    const cause = Object.assign(new Error(`Transaction 'AQC2abc' is not found (request for '${QUESTION}'); please retry`), { name: "DatabaseErrorException" });
    const db = failingDb(() => { throw new Error("Failed query: select 1\nparams: " + QUESTION, { cause }); });
    const form = new FormData();
    form.set("decision", "send");
    await decide({ db, feeRate: 0.2, logger: createLogger({ write: (l) => lines.push(l), level: "debug" }) }, { requestId: "A2H-fd84", token: TOKEN, principalId: "user-1", form, reference: "ref_2" });
    const error = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l["level"] === "error")!;
    expect(error).toMatchObject({ cause: "DatabaseErrorException", db_error: "Transaction … is not found …" });
    expect(error).not.toHaveProperty("sql_state");
    expect(lines.join("\n")).not.toMatch(/picture book|AQC2abc|retry/);
  });

  test("without a database cause: the class name only", async () => {
    const lines: string[] = [];
    const db = failingDb(() => { throw new TypeError("boom: " + QUESTION); });
    const form = new FormData();
    form.set("decision", "send");
    await decide({ db, feeRate: 0.2, logger: createLogger({ write: (l) => lines.push(l), level: "debug" }) }, { requestId: "A2H-fd84", token: TOKEN, principalId: "user-1", form, reference: "ref_1" });
    const error = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l["level"] === "error")!;
    expect(error).toMatchObject({ code: "TypeError" });
    expect(error).not.toHaveProperty("sql_state");
    expect(error).not.toHaveProperty("db_error");
    expect(lines.join("\n")).not.toContain("picture book");
  });
});
