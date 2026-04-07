/**
 * LanceDB REST API client
 *
 * Shared client for vector database operations. Used by:
 * - query-dedup.ts (query deduplication)
 * - vectorMemorySelector.ts (memory file selection)
 * - crawler.ts (nitter social graph storage)
 *
 * Environment:
 *   LANCEDB_URI - REST API base URL (default: http://lancedb-api:8000)
 *   LANCEDB_DB  - Database name (default: user_dbs)
 */

const LANCEDB_URI = process.env.LANCEDB_URI ?? "http://lancedb-api:8000";
const LANCEDB_DB = process.env.LANCEDB_DB ?? "user_dbs";

// Default timeouts (ms)
const DEFAULT_QUERY_TIMEOUT = 5000;
const DEFAULT_SEARCH_TIMEOUT = 5000;
const DEFAULT_INGEST_TIMEOUT = 30000;
const DEFAULT_DELETE_TIMEOUT = 10000;

export interface LanceDBRecord {
  id: string;
  [key: string]: unknown;
}

export interface QueryResult {
  records: LanceDBRecord[];
  error?: string;
}

export interface SearchResult {
  results: Array<LanceDBRecord & { _distance?: number }>;
  error?: string;
}

export interface TableInfo {
  name: string;
  row_count: number;
  columns: { name: string; type: string }[];
}

export interface LanceDBOptions {
  timeout?: number;
}

/**
 * Query table with optional filter
 */
export async function lancedbQuery(
  table: string,
  filter?: string,
  limit = 100,
  options?: LanceDBOptions
): Promise<QueryResult> {
  const url = `${LANCEDB_URI}/dbs/${LANCEDB_DB}/tables/${table}/query`;
  const payload: Record<string, unknown> = { limit };
  if (filter) payload.filter = filter;

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(options?.timeout ?? DEFAULT_QUERY_TIMEOUT),
    });

    if (!resp.ok) {
      const text = await resp.text();
      return { records: [], error: text };
    }

    const data = (await resp.json()) as { records?: LanceDBRecord[] };
    return { records: data.records ?? [] };
  } catch (err) {
    return { records: [], error: String(err) };
  }
}

/**
 * Vector similarity search
 */
export async function lancedbSearch(
  table: string,
  vector: number[],
  limit = 10,
  options?: LanceDBOptions
): Promise<SearchResult> {
  const url = `${LANCEDB_URI}/dbs/${LANCEDB_DB}/tables/${table}/search`;

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query_vector: vector, limit }),
      signal: AbortSignal.timeout(options?.timeout ?? DEFAULT_SEARCH_TIMEOUT),
    });

    if (!resp.ok) {
      const text = await resp.text();
      return { results: [], error: text };
    }

    const data = (await resp.json()) as { results?: Array<LanceDBRecord & { _distance?: number }> };
    return { results: data.results ?? [] };
  } catch (err) {
    return { results: [], error: String(err) };
  }
}

/**
 * Insert records (auto-creates table if not exists)
 */
export async function lancedbIngest(
  table: string,
  records: LanceDBRecord[],
  options?: LanceDBOptions
): Promise<{ success: boolean; error?: string }> {
  const url = `${LANCEDB_URI}/dbs/${LANCEDB_DB}/tables/${table}/ingest`;

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ records }),
      signal: AbortSignal.timeout(options?.timeout ?? DEFAULT_INGEST_TIMEOUT),
    });

    if (!resp.ok) {
      const text = await resp.text();
      return { success: false, error: text };
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

/**
 * Delete records matching filter
 */
export async function lancedbDelete(
  table: string,
  filter: string,
  options?: LanceDBOptions
): Promise<{ success: boolean; error?: string }> {
  const url = `${LANCEDB_URI}/dbs/${LANCEDB_DB}/tables/${table}/delete`;

  try {
    const resp = await fetch(url, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filter }),
      signal: AbortSignal.timeout(options?.timeout ?? DEFAULT_DELETE_TIMEOUT),
    });

    if (!resp.ok) {
      const text = await resp.text();
      return { success: false, error: text };
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

/**
 * List all tables with metadata
 */
export async function lancedbListTables(options?: LanceDBOptions): Promise<TableInfo[]> {
  const url = `${LANCEDB_URI}/dbs/${LANCEDB_DB}/tables`;

  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(options?.timeout ?? DEFAULT_QUERY_TIMEOUT),
    });
    if (!resp.ok) return [];

    const data = (await resp.json()) as { tables?: TableInfo[] };
    return data.tables ?? [];
  } catch {
    return [];
  }
}

/**
 * Update a single record field (delete + insert pattern)
 */
export async function lancedbUpdateField(
  table: string,
  primaryKey: string,
  primaryValue: string,
  updates: Record<string, unknown>
): Promise<boolean> {
  // Fetch existing record
  const existing = await lancedbQuery(
    table,
    `${primaryKey} = '${primaryValue}'`,
    1
  );
  if (!existing.records.length) return false;

  // Merge updates
  const record = { ...existing.records[0], ...updates };

  // Delete old record
  await lancedbDelete(table, `${primaryKey} = '${primaryValue}'`);

  // Insert updated record
  const result = await lancedbIngest(table, [record as LanceDBRecord]);
  return result.success;
}

/**
 * Check if LanceDB is available
 */
export async function lancedbHealthCheck(): Promise<boolean> {
  try {
    const resp = await fetch(`${LANCEDB_URI}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

/**
 * Get current configuration
 */
export function getLanceDBConfig(): { uri: string; db: string } {
  return { uri: LANCEDB_URI, db: LANCEDB_DB };
}
