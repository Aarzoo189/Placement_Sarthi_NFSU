// Creates .env from .env.example with freshly generated encryption keys. Works on Windows, macOS and Linux.
//   node scripts/setup-env.mjs
// It never overwrites an existing .env: replacing DATA_KEY would make already-encrypted data unreadable.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = resolve(root, ".env");

if (existsSync(target)) {
  console.log(".env already exists - leaving it alone (its keys protect existing data).");
  process.exit(0);
}

const key = () => randomBytes(32).toString("base64");
const text = readFileSync(resolve(root, ".env.example"), "utf8")
  .replace(/^DATA_KEY=.*$/m, `DATA_KEY=${key()}`)
  .replace(/^HMAC_KEY=.*$/m, `HMAC_KEY=${key()}`);
writeFileSync(target, text);
console.log("Created .env with new DATA_KEY and HMAC_KEY. Keep this file private; do not commit it.");
