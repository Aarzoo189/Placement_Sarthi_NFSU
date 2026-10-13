import { execSync } from 'child_process';
import { Client } from 'pg';
import './load-env';

/** Create (once) and migrate the `placement_test` database. Safe to run repeatedly. */
export default async function globalSetup() {
  const owner = new URL(process.env.DIRECT_DATABASE_URL!);
  owner.pathname = '/postgres';
  owner.search = '';
  const admin = new Client({ connectionString: owner.toString() });
  await admin.connect();
  const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = 'placement_test'");
  if (!exists.rowCount) await admin.query('CREATE DATABASE placement_test');
  await admin.query('GRANT CONNECT ON DATABASE placement_test TO placement_app');
  await admin.end();
  execSync('npx prisma migrate deploy', { stdio: 'pipe', env: process.env, cwd: __dirname + '/..' });
}
