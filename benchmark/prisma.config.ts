import path from 'node:path';
import { defineConfig } from 'prisma/config';

// The benchmark's own schema and database, kept away from the test ones.
export default defineConfig({
  schema: path.join(__dirname, 'schema.prisma'),
  datasource: {
    url:
      process.env.BENCH_DATABASE_URL ??
      'postgresql://postgres:postgres@127.0.0.1:5432/prisma_bench',
  },
});
