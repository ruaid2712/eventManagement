import 'dotenv/config';

const requiredVariables = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
const missingVariables = requiredVariables.filter((name) => !process.env[name]);

if (missingVariables.length) {
  throw new Error(`Missing required environment variables: ${missingVariables.join(', ')}`);
}

export const config = {
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  clientOrigin: process.env.CLIENT_ORIGIN ?? 'http://localhost:5173',
  port: Number(process.env.PORT ?? 3001),
};
