// Build the pg configuration without placing the database password in source or logs.
// Supabase's downloaded root certificate can be supplied through Vercel as a PEM
// value (literal newlines or escaped \n) for full certificate verification.
export function connectionConfig(env = process.env) {
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required for PostgreSQL");
  const url = new URL(env.DATABASE_URL);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.username || !url.pathname.slice(1)) {
    throw new Error("DATABASE_URL must be a PostgreSQL connection URL");
  }
  const ca = env.SUPABASE_DB_CA_CERT?.replaceAll("\\n", "\n").trim();
  if (!ca && env.SECUREAWARE_DEMO_DATA !== "on") {
    throw new Error("Set SUPABASE_DB_CA_CERT to verify the PostgreSQL server certificate");
  }
  return {
    host: url.hostname,
    port: Number(url.port || 5432),
    database: decodeURIComponent(url.pathname.slice(1)),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    // Academic demos may use Supabase's encrypted `sslmode=require` behavior
    // until a project CA is installed. This does not authenticate the server.
    ssl: ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: false },
    connectionTimeoutMillis: 10_000,
    query_timeout: 20_000
  };
}
