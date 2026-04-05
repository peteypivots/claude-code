/**
 * LanceDB REST API client
 *
 * Environment:
 *   LANCEDB_URI - REST API base URL (default: http://lancedb-api:8000)
 *   LANCEDB_DB  - Database name (default: user_dbs)
 */

const LANCEDB_URI = process.env.LANCEDB_URI ?? "http://lancedb-api:8000";
const LANCEDB_DB = process.env.LANCEDB_DB ?? "user_dbs";

export interface LanceDBRecord {
  id: string;
  [key: string]: unknown;
}

export interface QueryResult {
  records: LanceDBRecord[];
  error?: string;
}

export interface SearchResult {
  results: LanceDBRecord[];
  error?: string;
}

export interface TableInfo {
  name: string;
  row_count: number;
  columns: { name: string; type: string }[];
}

/**
 * Query table with optional filter
 */
export async function lancedbQuery(
  table: string,
  filter?: string,
  limit = 100
): Promise<QueryResult> {
  const url = `${LANCEDB_URI}/dbs/${LANCEDB_DB}/tables/${table}/query`;
  const payload: Record<string, unknown> = { limit };
  if (filter) payload.filter = filter;

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const text = await resp.text();
      return { records: [], error: text };
    }

    const data = await resp.json();
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
  limit = 10
): Promise<SearchResult> {
  const url = `${LANCEDB_URI}/dbs/${LANCEDB_DB}/tables/${table}/search`;

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query_vector: vector, limit }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      return { results: [], error: text };
    }

    const data = await resp.json();
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
  records: LanceDBRecord[]
): Promise<{ success: boolean; error?: string }> {
  const url = `${LANCEDB_URI}/dbs/${LANCEDB_DB}/tables/${table}/ingest`;

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ records }),
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
  filter: string
): Promise<{ success: boolean; error?: string }> {
  const url = `${LANCEDB_URI}/dbs/${LANCEDB_DB}/tables/${table}/delete`;

  try {
    const resp = await fetch(url, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filter }),
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
export async function lancedbListTables(): Promise<TableInfo[]> {
  const url = `${LANCEDB_URI}/dbs/${LANCEDB_DB}/tables`;

  try {
    const resp = await fetch(url);
    if (!resp.ok) return [];

    const data = await resp.json();
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
