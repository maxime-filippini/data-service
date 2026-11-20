import { makeSqliteD1 } from "$/local/sqlite-d1";

/**
 * A minimal D1 stand-in backed by in-memory SQLite with the real migrations,
 * so tests exercise the production SQL. Batches run in one transaction.
 */
export const makeTestDatabase = () => makeSqliteD1();
