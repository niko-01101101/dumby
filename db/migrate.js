import { readdir, readFile } from "node:fs/promises";
import { createConnection } from "mysql2/promise";
const MIGRATIONS_DIR = new URL("./migrations/", import.meta.url);
function requireEnv(name) {
    const value = process.env[name];
    if (!value)
        throw new Error(`[ERROR] Missing required env var: ${name}`);
    return value;
}
async function main() {
    const connection = await createConnection({
        host: process.env.MYSQL_HOST ?? "127.0.0.1",
        port: Number(process.env.MYSQL_PORT ?? 3306),
        user: requireEnv("MYSQL_USER"),
        password: requireEnv("MYSQL_PASSWORD"),
        database: requireEnv("MYSQL_DATABASE"),
        multipleStatements: true,
    });
    try {
        await connection.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name VARCHAR(255) NOT NULL PRIMARY KEY,
        applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
        const [rows] = await connection.query("SELECT name FROM schema_migrations");
        const applied = new Set(rows.map((row) => row.name));
        const files = (await readdir(MIGRATIONS_DIR))
            .filter((file) => file.endsWith(".sql"))
            .sort();
        for (const file of files) {
            if (applied.has(file))
                continue;
            console.log(`Applying migration: ${file}`);
            const sql = await readFile(new URL(file, MIGRATIONS_DIR), "utf8");
            // MySQL implicitly commits DDL, so a migration can't be rolled back
            // automatically if it fails partway through a multi-statement file.
            await connection.query(sql);
            await connection.query("INSERT INTO schema_migrations (name) VALUES (?)", [file]);
        }
        console.log("Migrations up to date.");
    }
    finally {
        await connection.end();
    }
}
main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
//# sourceMappingURL=migrate.js.map