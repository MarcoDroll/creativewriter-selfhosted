import { getAdminClient } from './supabase-admin.ts';

/**
 * Extract client IP from request headers.
 * Prefers x-forwarded-for (first entry), falls back to cf-connecting-ip.
 */
export function getClientIp(request: Request): string | null {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    return forwarded.split(',')[0].trim() || null;
  }
  return request.headers.get('cf-connecting-ip') || null;
}

/**
 * Fire-and-forget audit log entry via Postgres RPC.
 * Never throws — logs errors to console only.
 */
export function logAuditEvent(
  eventType: string,
  metadata: Record<string, unknown> = {},
  options: { userId?: string | null; request?: Request } = {},
): void {
  const ip = options.request ? getClientIp(options.request) : null;

  // Fire-and-forget: don't await
  getAdminClient()
    .rpc('log_audit_event', {
      p_user_id: options.userId || null,
      p_event_type: eventType,
      p_metadata: metadata,
      p_ip_address: ip,
    })
    .then(({ error }) => {
      if (error) {
        console.error('[Audit] Failed to log event:', eventType, error.message);
      }
    })
    .catch((err: Error) => {
      console.error('[Audit] RPC call failed:', eventType, err.message);
    });
}
