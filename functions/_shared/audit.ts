import { getAdminClient } from './supabase-admin.ts';
import { sendAlertEmail } from './alert.ts';

/**
 * Audit event types that also trigger an operator email alert (via alert.ts).
 * Future audited events opt in by adding their name here — no call-site change.
 * The high-frequency `verify.*` events never touch logAuditEvent, so they are
 * excluded by construction.
 */
const ALERT_EVENT_TYPES = new Set([
  'webhook.orphan_skipped',
  'webhook.processing_failed',
]);

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

  // Fire-and-forget: don't await. Wrap in Promise.resolve so the chain is a real
  // Promise (the PostgREST builder is only a PromiseLike thenable, whose .then()
  // returns PromiseLike<void> — which has no .catch).
  Promise.resolve(
    getAdminClient()
      .rpc('log_audit_event', {
        p_user_id: options.userId || null,
        p_event_type: eventType,
        p_metadata: metadata,
        p_ip_address: ip,
      }),
  )
    .then(({ error }) => {
      if (error) {
        console.error('[Audit] Failed to log event:', eventType, error.message);
      }
    })
    .catch((err: Error) => {
      console.error('[Audit] RPC call failed:', eventType, err.message);
    });

  // Fire-and-forget operator alert for allowlisted event types. Reuses the
  // metadata already assembled at the call site; no-ops unless the alert secrets
  // are configured (see alert.ts).
  if (ALERT_EVENT_TYPES.has(eventType)) {
    sendAlertEmail(eventType, metadata);
  }
}
