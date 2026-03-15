import { createClient, SupabaseClient } from 'npm:@supabase/supabase-js@2';

/**
 * Create a user-scoped Supabase client from JWT.
 * This client respects RLS policies (auth.uid() = user_id).
 */
export function getUserClient(jwt: string): SupabaseClient {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
      auth: { autoRefreshToken: false, persistSession: false },
    }
  );
}
