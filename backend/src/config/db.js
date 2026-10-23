const { Pool } = require("pg");
const env = require("./env");

// Single shared pool. Import `query` for one-off queries; import `pool`
// directly when you need a client for a transaction.
const pool = new Pool({ connectionString: env.databaseUrl });

pool.on("error", (err) => {
  console.error("Unexpected PostgreSQL error on idle client", err);
});

module.exports = {
  pool,
  query: (text, params) => pool.query(text, params),
};
