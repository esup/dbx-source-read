import type { DatabaseType } from "@/types/database";

type BuildViewDdlInput = {
  databaseType?: DatabaseType;
  schema?: string | null;
  name: string;
  source: string;
};

const postgresLikeTypes = new Set<DatabaseType>([
  "postgres",
  "redshift",
  "gaussdb",
  "kingbase",
  "highgo",
  "vastbase",
  "opengauss",
]);

function ensureSemicolon(sql: string): string {
  const trimmed = sql.trim();
  return trimmed.endsWith(";") ? trimmed : `${trimmed};`;
}

function quotePostgresIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteMysqlIdentifier(value: string): string {
  return `\`${value.replaceAll("`", "``")}\``;
}

function qualifiedName(input: BuildViewDdlInput): string {
  const parts = [input.schema, input.name].filter(Boolean) as string[];
  if (input.databaseType === "mysql" || input.databaseType === "goldendb") {
    return parts.map(quoteMysqlIdentifier).join(".");
  }
  return parts.map(quotePostgresIdentifier).join(".");
}

export function buildViewDdl(input: BuildViewDdlInput): string {
  const source = input.source.trim();
  if (/^(?:CREATE|ALTER)\s+/i.test(source)) return ensureSemicolon(source);

  if (!input.databaseType || postgresLikeTypes.has(input.databaseType)) {
    return `CREATE OR REPLACE VIEW ${qualifiedName(input)} AS\n${ensureSemicolon(source)}`;
  }

  return `CREATE VIEW ${qualifiedName(input)} AS\n${ensureSemicolon(source)}`;
}
