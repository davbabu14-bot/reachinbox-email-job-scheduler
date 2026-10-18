import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),
  REDIS_URL: z.string().default('redis://127.0.0.1:6379'),
  DATABASE_URL: z.string().default('postgresql://postgres:postgres@127.0.0.1:5432/reachinbox?schema=public'),
  ELASTICSEARCH_NODE: z.string().default('http://127.0.0.1:9200'),
  ENCRYPTION_KEY: z
    .string()
    .refine(
      (val) => !val || /^[0-9a-fA-F]{64}$/.test(val) || val.length >= 32,
      {
        message: 'ENCRYPTION_KEY must be a 64-character hex string (32 bytes) or at least 32 characters long',
      }
    )
    .optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  SESSION_SECRET: z.string().default('reachinbox-scheduler-session-secret-change-in-production'),
  SLACK_CLIENT_ID: z.string().optional(),
  SLACK_CLIENT_SECRET: z.string().optional(),
  SLACK_REDIRECT_URI: z.string().optional(),
  FRONTEND_URL: z.string().default('http://localhost:3000'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Report which keys failed validation without ever logging raw values
  const missingOrInvalid = parsed.error.issues.map((issue) => issue.path.join('.'));
  console.error('[Config] Environment validation failed for fields:', missingOrInvalid);
  throw new Error(`Invalid environment configuration: ${missingOrInvalid.join(', ')}`);
}

export const env = parsed.data;
export type Env = z.infer<typeof envSchema>;
