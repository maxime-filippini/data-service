import { decompress } from "fzstd";
import { parquetMetadata, parquetReadObjects, parquetSchema, type SchemaElement } from "hyparquet";

// Polars writes zstd. hyparquet decodes snappy and uncompressed files itself;
// the other codecs would need decoders that load WASM, which the CSP blocks.
const compressors = { ZSTD: (input: Uint8Array) => decompress(input) };

export type Value = string | number | boolean | null;
export type Row = Record<string, Value>;

export type Column = {
  name: string;
  /** "date" values are ISO strings, so they sort and compare as text. */
  kind: "date" | "number" | "text";
};

export type Dataset = { columns: Column[]; rows: Row[] };

const kindOf = (element: SchemaElement): Column["kind"] => {
  const converted = element.converted_type;
  const logical = element.logical_type?.type;
  if (converted === "DATE" || logical === "DATE") return "date";
  if (converted?.startsWith("TIMESTAMP") || logical === "TIMESTAMP" || element.type === "INT96") return "date";
  if (converted === "DECIMAL" || logical === "DECIMAL") return "number";
  if (["INT32", "INT64", "FLOAT", "DOUBLE"].includes(element.type ?? "")) return "number";
  return "text";
};

const toValue = (value: unknown, column: Column): Value => {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    const iso = value.toISOString();
    // DATE columns decode to midnight UTC; keep just the day.
    return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso;
  }
  if (typeof value === "bigint") {
    // Volumes and other counts fit easily; very large values stay exact as text.
    return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return column.kind === "text" ? JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v)) : null;
};

/** Decode a whole Parquet file into plain rows with one value per top-level column. */
export const readParquet = async (file: ArrayBuffer): Promise<Dataset> => {
  const metadata = parquetMetadata(file);
  const columns = parquetSchema(metadata).children.map((child) => ({
    name: child.element.name,
    kind: child.children.length > 0 ? ("text" as const) : kindOf(child.element),
  }));
  const raw = await parquetReadObjects({ file, metadata, compressors, rowFormat: "object" });
  const rows = raw.map((record) => {
    const row: Row = {};
    for (const column of columns) row[column.name] = toValue(record[column.name], column);
    return row;
  });
  return { columns, rows };
};
