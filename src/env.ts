import 'node:process';

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export const env = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: required('DATABASE_URL', 'postgres://localhost:5432/pulseboard'),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  seedDemo: process.env.SEED_DEMO !== 'false',
};
