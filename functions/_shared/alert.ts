/**
 * Operational email alerts for the Stripe webhook path.
 *
 * Fire-and-forget, no-op-until-configured transport. When a Stripe webhook is
 * orphaned (`webhook.orphan_skipped`) or fails to process
 * (`webhook.processing_failed`), the operator gets an email naming the customer
 * and event so they can run `scripts/reconcile-stripe-orphans.ts` — closing the
 * "found manually" gap from the 2026-07-23 orphan incident.
 *
 * Delivery uses the Resend HTTP API (a single `fetch`) rather than an SMTP
 * client, avoiding connection/TLS overhead in the edge function.
 *
 * Fires only when BOTH `RESEND_API_KEY` and `ALERT_EMAIL_TO` are set (manual
 * per-project Supabase secrets, like `STRIPE_API_KEY` — not CI-injected). Absent
 * either one, `buildResendRequest` returns null and `sendAlertEmail` no-ops, so
 * self-hosted and unconfigured-hosted instances stay silent.
 *
 * A `processing_failed` that keeps 500-ing makes Stripe retry the SAME event
 * (identical `event.id`) with backoff. To avoid a mailbox flood, a best-effort
 * in-isolate throttle (`shouldSuppressAlert`) collapses repeat alerts for the
 * same event fingerprint into one email per `ALERT_DEDUP_WINDOW_MS`. It is
 * best-effort only — edge isolates are ephemeral and there may be several
 * concurrently, so a retry handled by a cold/other isolate still alerts. This is
 * deliberately a cheap in-memory guard, not a DB-backed hard rate limit (which
 * would add a round trip to the alert path for a rare event).
 */

const RESEND_URL = 'https://api.resend.com/emails';

/** Window during which a repeat alert for the same fingerprint is suppressed. */
const ALERT_DEDUP_WINDOW_MS = 60 * 60 * 1000; // 1 hour

/**
 * Backstop cap on distinct fingerprints held in the in-isolate dedup store, so a
 * pathological spread of unique events can't grow it without bound. Far above any
 * realistic count of concurrently-failing Stripe events.
 */
const ALERT_DEDUP_MAX_ENTRIES = 500;

/** In-isolate, best-effort dedup store: fingerprint → last-alerted epoch ms. */
const alertDedupStore = new Map<string, number>();

/**
 * Resend's shared sender: needs no domain verification and delivers to the
 * account owner. Prod overrides with a verified-domain address via
 * `ALERT_EMAIL_FROM`.
 */
const DEFAULT_FROM = 'onboarding@resend.dev';

export interface AlertConfig {
  apiKey?: string;
  to?: string;
  from: string;
}

/**
 * Read alert configuration from the environment. `from` always has a value
 * (the Resend shared sender default); `apiKey`/`to` are undefined until the
 * operator sets the secrets.
 */
export function getAlertConfig(): AlertConfig {
  return {
    apiKey: Deno.env.get('RESEND_API_KEY') || undefined,
    to: Deno.env.get('ALERT_EMAIL_TO') || undefined,
    from: Deno.env.get('ALERT_EMAIL_FROM') || DEFAULT_FROM,
  };
}

/** Per-event-type header line describing what happened. */
function headerLine(event: string): string {
  switch (event) {
    case 'webhook.orphan_skipped':
      return 'A paid Stripe webhook was skipped because the customer could not be mapped to a user.';
    case 'webhook.processing_failed':
      return 'A Stripe webhook failed to process; Stripe will retry.';
    default:
      return 'A CreativeWriter operational alert was raised.';
  }
}

/**
 * Pure request-shaper — the whole point of this module's testability.
 *
 * Returns the Resend payload, or `null` when `apiKey` or `to` is absent (caller
 * no-ops). The `text` body is a header line by event type, the metadata rendered
 * as `key: value` lines, and a remediation hint pointing at the reconcile script.
 */
export function buildResendRequest(
  config: AlertConfig,
  event: string,
  metadata: Record<string, unknown>,
): { url: string; headers: Record<string, string>; body: string } | null {
  if (!config.apiKey || !config.to) {
    return null;
  }

  const customerId = metadata['stripe_customer_id'];
  const metadataLines = Object.entries(metadata)
    // Primitives render as-is; a stray object/array is JSON-stringified rather
    // than collapsing to "[object Object]" (current callers only pass strings).
    .map(([key, value]) => {
      const rendered = value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value);
      return `${key}: ${rendered}`;
    })
    .join('\n');

  const reconcileTarget = typeof customerId === 'string' && customerId
    ? customerId
    : '<customer-id>';
  const remediation =
    `Remediation: deno run --allow-env --allow-net scripts/reconcile-stripe-orphans.ts --customer ${reconcileTarget}`;

  const text = [
    headerLine(event),
    '',
    metadataLines,
    '',
    remediation,
  ].join('\n');

  return {
    url: RESEND_URL,
    headers: {
      'Authorization': `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: config.from,
      to: config.to,
      subject: `⚠️ [CreativeWriter] ${event}`,
      text,
    }),
  };
}

/**
 * Fingerprint identifying "the same alert" for dedup. Stripe retries a failed
 * webhook with the SAME `event.id`, so keying on event type + `stripe_event_id`
 * collapses a retry storm into one email per window. Distinct events (different
 * ids) still alert separately.
 */
export function alertFingerprint(event: string, metadata: Record<string, unknown>): string {
  const eventId = metadata['stripe_event_id'];
  return `${event}:${typeof eventId === 'string' && eventId ? eventId : 'unknown'}`;
}

/**
 * Best-effort, in-isolate throttle. Returns `true` when an alert with this
 * fingerprint was already sent within `ALERT_DEDUP_WINDOW_MS` (→ caller
 * suppresses the duplicate); otherwise records `now` as the last-alerted time and
 * returns `false`. Mutates `store`; pure w.r.t. the injected `now`/`store` for
 * testability. See the module header for why this is best-effort, not a hard
 * guarantee.
 */
export function shouldSuppressAlert(
  event: string,
  metadata: Record<string, unknown>,
  now: number,
  store: Map<string, number> = alertDedupStore,
): boolean {
  const fingerprint = alertFingerprint(event, metadata);
  const last = store.get(fingerprint);
  if (last !== undefined && now - last < ALERT_DEDUP_WINDOW_MS) {
    return true;
  }

  // Record this send. delete+set moves the key to the end so Map insertion order
  // tracks recency, letting the cap evict the least-recently-alerted first.
  store.delete(fingerprint);
  store.set(fingerprint, now);
  pruneDedupStore(store, now);
  return false;
}

/** Drop entries past the window (they can never suppress again) and enforce the cap. */
function pruneDedupStore(store: Map<string, number>, now: number): void {
  for (const [key, ts] of store) {
    if (now - ts >= ALERT_DEDUP_WINDOW_MS) {
      store.delete(key);
    }
  }
  while (store.size > ALERT_DEDUP_MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    store.delete(oldest);
  }
}

/**
 * Fire-and-forget alert email. Never throws and never blocks the caller — mirrors
 * `logAuditEvent`'s contract exactly. No-ops when unconfigured or when throttled
 * as a duplicate within the dedup window.
 */
export function sendAlertEmail(event: string, metadata: Record<string, unknown> = {}): void {
  const request = buildResendRequest(getAlertConfig(), event, metadata);
  if (!request) {
    return;
  }

  // Throttle repeat alerts for the same event (Stripe retries reuse event.id).
  // Checked after the config guard so the store only tracks real send attempts.
  if (shouldSuppressAlert(event, metadata, Date.now())) {
    console.log('[Alert] Suppressed duplicate within dedup window:', alertFingerprint(event, metadata));
    return;
  }

  // Fire-and-forget: don't await. The webhook response returns before this
  // resolves, so alerting adds zero latency to the Stripe handler.
  fetch(request.url, { method: 'POST', headers: request.headers, body: request.body })
    .then((res) => {
      if (!res.ok) {
        console.error('[Alert] Resend returned non-2xx:', event, res.status);
      }
    })
    .catch((err: Error) => {
      console.error('[Alert] Email send failed:', event, err.message);
    });
}
