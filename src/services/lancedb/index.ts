/**
 * LanceDB service barrel export
 */
export {
  lancedbQuery,
  lancedbSearch,
  lancedbIngest,
  lancedbDelete,
  lancedbListTables,
  lancedbUpdateField,
  lancedbHealthCheck,
  getLanceDBConfig,
  type LanceDBRecord,
  type QueryResult,
  type SearchResult,
  type TableInfo,
  type LanceDBOptions,
} from './client.js';
