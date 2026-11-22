// SQL client abstraction. Two adapters:
//  - PgSqlClient: production, uses the `pg` package (install with `npm install pg`). NOT verified in the build sandbox.
//  - PsqlCliClient: runs statements through the `psql` binary. Used by tests and local tooling; verified against PostgreSQL 16.
import { spawn } from "node:child_process";

export type SqlValue = string | number | boolean | null | Date;

export interface SqlClient {
  /** Runs statements in one transaction. Throws (and rolls back) on any failure. */
  batch(statements: Array<{ text: string; params?: SqlValue[] }>): Promise<void>;
  /** Runs a row-returning query. */
  query<T extends Record<string, unknown>>(text: string, params?: SqlValue[]): Promise<T[]>;
  close(): Promise<void>;
}

/** Escapes a parameter as a SQL literal. Only used by the psql adapter (no bind parameters there). */
export function literal(v: SqlValue | undefined): string {
  if (v === undefined || v === null) return "NULL";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("non-finite number parameter");
    return String(v);
  }
  if (v instanceof Date) return `'${v.toISOString()}'`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

/** Replaces $1..$n placeholders with literals. Placeholders inside string literals are not touched. */
export function inlineParams(text: string, params: SqlValue[] = []): string {
  let out = "";
  let i = 0;
  let inStr = false;
  while (i < text.length) {
    const c = text[i];
    if (c === "'") {
      inStr = !inStr;
      out += c;
      i++;
      continue;
    }
    if (!inStr && c === "$" && /\d/.test(text[i + 1] ?? "")) {
      let j = i + 1;
      while (j < text.length && /\d/.test(text[j])) j++;
      const n = Number(text.slice(i + 1, j));
      if (n < 1 || n > params.length) throw new Error(`missing parameter $${n}`);
      out += literal(params[n - 1]);
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

export class PsqlCliClient implements SqlClient {
  private readonly url: string;
  private readonly psql: string;
  constructor(url: string, psql = "psql") {
    this.url = url;
    this.psql = psql;
  }

  private run(input: string, json: boolean): Promise<string> {
    const args = ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-A", "-t", "--no-psqlrc", this.url];
    return new Promise((resolve, reject) => {
      const p = spawn(this.psql, args, { stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      let err = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (err += d));
      p.on("error", reject);
      p.on("close", (code) => (code === 0 ? resolve(json ? out.trim() : out) : reject(new Error(`psql failed: ${err.trim()}`))));
      p.stdin.end(input);
    });
  }

  async batch(statements: Array<{ text: string; params?: SqlValue[] }>): Promise<void> {
    const body = statements.map((s) => inlineParams(s.text, s.params) + ";").join("\n");
    await this.run(`BEGIN;\n${body}\nCOMMIT;\n`, false);
  }

  async query<T extends Record<string, unknown>>(text: string, params: SqlValue[] = []): Promise<T[]> {
    const sql = inlineParams(text, params).replace(/;\s*$/, "");
    const out = await this.run(`SELECT COALESCE(json_agg(t), '[]'::json) FROM (${sql}) t;\n`, true);
    return JSON.parse(out || "[]") as T[];
  }

  async close(): Promise<void> {
    /* stateless */
  }
}

/** Production adapter. Requires the `pg` package. Not exercised in the build sandbox. */
export async function createPgClient(connectionString: string): Promise<SqlClient> {
  let pg: any;
  // Loaded through a variable so `pg` stays an optional dependency: the typecheck does not require its types.
  const pgModule = "pg";
  try {
    pg = await import(pgModule);
  } catch {
    throw new Error("DATABASE_URL is set but the 'pg' package is not installed. Run: npm install pg");
  }
  const Pool = pg.default?.Pool ?? pg.Pool;
  const pool = new Pool({
    connectionString,
    ssl: process.env.PGSSL === "disable" ? false : { rejectUnauthorized: process.env.PGSSL_REJECT_UNAUTHORIZED !== "false" },
    max: Number(process.env.PG_POOL_MAX ?? 5),
  });
  return {
    async batch(statements) {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        for (const s of statements) await c.query(s.text, s.params ?? []);
        await c.query("COMMIT");
      } catch (e) {
        await c.query("ROLLBACK").catch(() => undefined);
        throw e;
      } finally {
        c.release();
      }
    },
    async query(text, params = []) {
      const r = await pool.query(text, params);
      return r.rows;
    },
    async close() {
      await pool.end();
    },
  };
}
