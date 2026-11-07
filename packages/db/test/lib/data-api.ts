// A stand-in for the RDS Data API (apps/web's driver, ADR 0001 amendment 2)
// in front of a real Postgres, for tests. It plays the parts that differ from
// node-postgres and have bitten us (pr-82, 2026-11-03: `operator does not
// exist: timestamp with time zone >= text`):
// - every parameter is bound with the SQL type the Data API gives it: a
//   string is text unless its typeHint says TIMESTAMP, DATE, DECIMAL, JSON,
//   UUID or TIME; whole numbers are bigint, other numbers double precision,
//   booleans boolean. node-postgres sends untyped parameters and lets
//   Postgres infer, so a raw `sql` template with an ISO string compared to a
//   timestamptz passes there and fails here, as on Aurora;
// - results come back as Data API field objects (strings, longs, doubles,
//   booleans, nulls, string arrays) with column metadata;
// - transactions are Begin/Execute(transactionId)/Commit/Rollback commands,
//   and a transaction runs one statement at a time: an ExecuteStatement on a
//   transactionId that already has one in flight is refused with Aurora's
//   DatabaseErrorException "Transaction is still running a query" (pr-82,
//   2026-11-03: `approvalFacts` ran two queries through Promise.all inside
//   `decideApproval`'s transaction). node-postgres queues them on its client
//   instead, so only this stand-in sees it;
// - a Postgres error comes back as DatabaseErrorException with the SQLState
//   and the constraint name only in its message, never as `code` or
//   `constraint` fields (pr-85, run 42246226973: `createAwaitingRequest` on
//   a taken id surfaced "duplicate key value violates unique constraint
//   \"requests_pkey\"; SQLState: 23505" instead of RequestIdTaken).
// It is driven by Drizzle's own `drizzle-orm/aws-data-api/pg` driver, so the
// statements, placeholders (`:1`) and type hints are exactly what the web
// Lambda sends. Test-only: no AWS call is made.
import { randomUUID } from "node:crypto";
import pg from "pg";

type Param = {
  name: string;
  value: { isNull?: boolean; stringValue?: string; longValue?: number; doubleValue?: number; booleanValue?: boolean };
  typeHint?: string;
};
type Field = { isNull?: true; stringValue?: string; longValue?: number; doubleValue?: number; booleanValue?: boolean; arrayValue?: { stringValues: string[] } };
interface Command {
  constructor: { name: string };
  input: { sql?: string; parameters?: Param[]; transactionId?: string };
}

/**
 * What Aurora's Data API throws: for a second statement on a busy transaction
 * (no SQLState), and for every Postgres error (`<message>; SQLState: <code>`,
 * nothing else: no `code`, no `constraint`, like the SDK's class).
 */
export class DatabaseErrorException extends Error {
  override name = "DatabaseErrorException";
}

/** A Postgres error as the Data API reports it. */
function asDataApiError(error: unknown): unknown {
  if (error instanceof pg.DatabaseError && error.code) return new DatabaseErrorException(`${error.message}; SQLState: ${error.code}`);
  return error;
}

const HINT_TYPE: Record<string, string> = { TIMESTAMP: "timestamp", DATE: "date", DECIMAL: "numeric", JSON: "json", UUID: "uuid", TIME: "time" };

/** The SQL type the Data API gives a parameter. */
function sqlTypeOf(p: Param): string | null {
  const v = p.value;
  if (v.isNull) return null;
  if (v.stringValue !== undefined) return p.typeHint ? (HINT_TYPE[p.typeHint] ?? "text") : "text";
  if (v.longValue !== undefined) return "bigint";
  if (v.doubleValue !== undefined) return "double precision";
  if (v.booleanValue !== undefined) return "boolean";
  throw new Error(`data-api stand-in: unsupported parameter ${JSON.stringify(p)}`);
}

function valueOf(p: Param): unknown {
  const v = p.value;
  if (v.isNull) return null;
  return v.stringValue ?? v.longValue ?? v.doubleValue ?? v.booleanValue;
}

// Postgres type OIDs of the result columns the stand-in maps to non-string fields.
const BOOL = 16;
const INTEGERS = new Set([20, 21, 23]);
const FLOATS = new Set([700, 701]);
const STRING_ARRAYS = new Set([1009, 1015]); // text[], varchar[]

/** Postgres's text[] parser (pg-types), typed for the one use here. */
const parseTextArray = (pg.types.getTypeParser as (oid: number) => (value: string) => string[])(1009);

const raw = { getTypeParser: () => (value: string) => value };

function field(value: unknown, typeId: number): Field {
  if (value === null) return { isNull: true };
  const text = value as string;
  if (typeId === BOOL) return { booleanValue: text === "t" };
  if (INTEGERS.has(typeId)) return { longValue: Number(text) };
  if (FLOATS.has(typeId)) return { doubleValue: Number(text) };
  if (STRING_ARRAYS.has(typeId)) return { arrayValue: { stringValues: parseTextArray(text) } };
  return { stringValue: text };
}

/** Rewrites `:1`… into `$1::<type>`… (never touching `::casts`). */
function bind(sql: string, params: Param[]): { text: string; values: unknown[] } {
  const byName = new Map(params.map((p) => [p.name, p]));
  const order: Param[] = [];
  const text = sql.replace(/(?<!:):(\d+)\b/g, (_, name: string) => {
    const p = byName.get(name);
    if (!p) throw new Error(`data-api stand-in: no parameter ${name}`);
    order.push(p);
    const type = sqlTypeOf(p);
    return type ? `$${order.length}::${type}` : `$${order.length}`;
  });
  return { text, values: order.map(valueOf) };
}

export interface DataApiStandIn {
  /** Pass as the RDSDataClient to `drizzle-orm/aws-data-api/pg`. */
  client: { send: (command: Command) => Promise<unknown> };
  /** Every statement sent, as the Data API received it, with the transaction it ran on if any (for assertions). */
  statements: { sql: string; parameters: Param[]; transactionId?: string }[];
  close: () => Promise<void>;
}

export function dataApiStandIn(connectionString: string, schema: string): DataApiStandIn {
  const pool = new pg.Pool({ connectionString, max: 6, options: `-c search_path=${schema} -c timezone=UTC` });
  const open = new Map<string, pg.PoolClient>();
  const busy = new Set<string>();
  const statements: DataApiStandIn["statements"] = [];
  // A class instance, not a plain object: Drizzle's `drizzle()` reads a plain object as its config.
  class StandInRdsDataClient {
    async send(command: Command): Promise<unknown> {
      switch (command.constructor.name) {
        case "BeginTransactionCommand": {
          const c = await pool.connect();
          await c.query("BEGIN");
          const id = randomUUID();
          open.set(id, c);
          return { transactionId: id };
        }
        case "CommitTransactionCommand":
        case "RollbackTransactionCommand": {
          const id = command.input.transactionId!;
          const c = open.get(id);
          if (!c) throw new Error("data-api stand-in: unknown transaction");
          open.delete(id);
          try {
            await c.query(command.constructor.name === "CommitTransactionCommand" ? "COMMIT" : "ROLLBACK");
          } finally {
            c.release();
          }
          return { transactionStatus: "done" };
        }
        case "ExecuteStatementCommand": {
          const parameters = command.input.parameters ?? [];
          statements.push({ sql: command.input.sql!, parameters, ...(command.input.transactionId ? { transactionId: command.input.transactionId } : {}) });
          const { text, values } = bind(command.input.sql!, parameters);
          const id = command.input.transactionId;
          const runner = id ? open.get(id) : pool;
          if (!runner) throw new Error("data-api stand-in: unknown transaction");
          if (id && busy.has(id)) throw new DatabaseErrorException("Transaction is still running a query");
          if (id) busy.add(id);
          let result: pg.QueryResult;
          try {
            result = await runner.query({ text, values, rowMode: "array", types: raw });
          } catch (error) {
            throw asDataApiError(error);
          } finally {
            if (id) busy.delete(id);
          }
          const records = (result.rows as unknown[][]).map((row) => row.map((v, i) => field(v, result.fields[i]!.dataTypeID)));
          return {
            numberOfRecordsUpdated: result.command === "SELECT" ? 0 : (result.rowCount ?? 0),
            records,
            columnMetadata: result.fields.map((f) => ({ name: f.name })),
          };
        }
        default:
          throw new Error(`data-api stand-in: unsupported command ${command.constructor.name}`);
      }
    }
  }
  const client = new StandInRdsDataClient();
  return {
    client,
    statements,
    close: async () => {
      for (const c of open.values()) c.release();
      await pool.end();
    },
  };
}
