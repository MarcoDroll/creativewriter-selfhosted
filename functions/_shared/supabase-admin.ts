import { createClient, SupabaseClient } from 'npm:@supabase/supabase-js@2';

let adminClient: SupabaseClient | null = null;

/**
 * Get a Supabase client with the service role key.
 * This client bypasses RLS and should only be used for server-side operations.
 */
export function getAdminClient(): SupabaseClient {
  if (adminClient) return adminClient;

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  return adminClient;
}
