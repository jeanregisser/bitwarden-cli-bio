import { resolve } from "node:path";

try {
  process.loadEnvFile(resolve(__dirname, "../../.env.e2e"));
} catch {
  // .env.e2e not found — rely on env vars being set externally (CI)
}
