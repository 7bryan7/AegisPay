import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "tests/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "**/.next/**", "tests/**/*.postgres.test.ts", "apps/web/lib/hedera-wallet-payment.test.ts"],
    environment: "node",
    coverage: { reporter: ["text", "html"] }
  }
});

