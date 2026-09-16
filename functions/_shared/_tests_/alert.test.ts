/**
 * Deno tests for the operator email-alert transport (alert.ts).
 *
 * Run locally with:
 *   deno test --node-modules-dir=none --allow-env --allow-net \
 *     supabase/functions/_shared/_tests_/alert.test.ts
 *
 * Run in CI via the "Test (Edge Functions / Deno)" step in ci.yml's lint-and-test
 * job (which globs `supabase/functions/`).
 *
 * Context: alerting is a fire-and-forget, no-op-until-configured transport — the
 * moment a Stripe webhook is orphaned or fails, the operator gets an email so they
 * can run reconcile-stripe-orphans.ts (closing the 2026-07-23 "found manually"
 * gap). Only the PURE `buildResendRequest` is unit-tested here: the `sendAlertEmail`
 * side is un-awaited I/O (a bare `fetch(...).then().catch()` that never blocks or
 * throws), which has no return value to assert and no network in CI. Everything
 * observable about a request — url, auth header, and the from/to/subject/text
 * payload — is decided by `buildResendRequest`, so testing it covers the contract.
 */

import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  alertFingerprint,
  buildResendRequest,
  getAlertConfig,
  shouldSuppressAlert,
  type AlertConfig,
} from '../alert.ts';

const HOUR_MS = 60 * 60 * 1000;

const FULL_CONFIG: AlertConfig = {
  apiKey: 'test_key_123',
  to: 'ops@example.com',
  from: 'onboarding@resend.dev',
};

const ORPHAN_META = {
  stripe_event_id: 'evt_orphan_1',
  stripe_customer_id: 'cus_ABC123',
  stripe_event_type: 'checkout.session.completed',
};

Deno.test('buildResendRequest: returns null when apiKey is missing', () => {
  const req = buildResendRequest({ to: 'ops@example.com', from: 'x@y.z' }, 'webhook.orphan_skipped', ORPHAN_META);
  assertEquals(req, null);
});

Deno.test('buildResendRequest: returns null when to is missing', () => {
  const req = buildResendRequest({ apiKey: 'k', from: 'x@y.z' }, 'webhook.orphan_skipped', ORPHAN_META);
  assertEquals(req, null);
});

Deno.test('buildResendRequest: returns null when both apiKey and to are missing', () => {
  const req = buildResendRequest({ from: 'x@y.z' }, 'webhook.orphan_skipped', ORPHAN_META);
  assertEquals(req, null);
});

Deno.test('buildResendRequest: full config produces a well-formed Resend request', () => {
  const req = buildResendRequest(FULL_CONFIG, 'webhook.orphan_skipped', ORPHAN_META);
  assert(req !== null);

  assertEquals(req.url, 'https://api.resend.com/emails');
  assertEquals(req.headers['Authorization'], 'Bearer test_key_123');
  assertEquals(req.headers['Content-Type'], 'application/json');

  const body = JSON.parse(req.body);
  assertEquals(body.from, 'onboarding@resend.dev');
  assertEquals(body.to, 'ops@example.com');
  assertEquals(body.subject, '⚠️ [CreativeWriter] webhook.orphan_skipped');

  // text body carries the identifying metadata and the remediation hint.
  assert(body.text.includes('cus_ABC123'), 'text should name the customer id');
  assert(body.text.includes('evt_orphan_1'), 'text should name the event id');
  assert(
    body.text.includes('reconcile-stripe-orphans.ts --customer cus_ABC123'),
    'text should include the reconcile remediation hint targeting the customer',
  );
});

Deno.test('buildResendRequest: default from is used when ALERT_EMAIL_FROM is unset', () => {
  // getAlertConfig() defaults `from` to onboarding@resend.dev; that value flows
  // straight through buildResendRequest into the payload.
  const req = buildResendRequest(
    { apiKey: 'k', to: 'ops@example.com', from: 'onboarding@resend.dev' },
    'webhook.orphan_skipped',
    ORPHAN_META,
  );
  assert(req !== null);
  assertEquals(JSON.parse(req.body).from, 'onboarding@resend.dev');
});

Deno.test('buildResendRequest: orphan_skipped renders its distinct header line', () => {
  const req = buildResendRequest(FULL_CONFIG, 'webhook.orphan_skipped', ORPHAN_META);
  assert(req !== null);
  const text = JSON.parse(req.body).text;
  assert(
    text.includes('skipped because the customer could not be mapped'),
    'orphan header line should describe the mapping failure',
  );
});

Deno.test('buildResendRequest: processing_failed renders its header line and the error field', () => {
  const meta = {
    stripe_event_id: 'evt_fail_9',
    stripe_customer_id: 'cus_XYZ789',
    stripe_event_type: 'invoice.paid',
    error: 'syncStripeData: connection reset',
  };
  const req = buildResendRequest(FULL_CONFIG, 'webhook.processing_failed', meta);
  assert(req !== null);

  const body = JSON.parse(req.body);
  assertEquals(body.subject, '⚠️ [CreativeWriter] webhook.processing_failed');
  assert(
    body.text.includes('failed to process; Stripe will retry'),
    'processing_failed header line should mention the retry',
  );
  assert(body.text.includes('syncStripeData: connection reset'), 'text should render the error field');
  assert(body.text.includes('cus_XYZ789'), 'text should name the customer id');
});

Deno.test('buildResendRequest: falls back to a placeholder target when no customer id is present', () => {
  const req = buildResendRequest(FULL_CONFIG, 'webhook.processing_failed', { stripe_event_id: 'evt_x' });
  assert(req !== null);
  assert(
    JSON.parse(req.body).text.includes('--customer <customer-id>'),
    'remediation should use a placeholder when the customer id is absent',
  );
});

Deno.test('buildResendRequest: unknown event types get a generic header line (defensive fallback)', () => {
  // ALERT_EVENT_TYPES only ever passes the two webhook events, but the exported
  // API accepts any string — assert the default branch renders sensibly.
  const req = buildResendRequest(FULL_CONFIG, 'some.future.event', { stripe_customer_id: 'cus_1' });
  assert(req !== null);
  const body = JSON.parse(req.body);
  assertEquals(body.subject, '⚠️ [CreativeWriter] some.future.event');
  assert(body.text.includes('operational alert was raised'), 'unknown event should use the generic header line');
});

Deno.test('buildResendRequest: non-primitive metadata values are JSON-stringified, not "[object Object]"', () => {
  const req = buildResendRequest(FULL_CONFIG, 'webhook.processing_failed', {
    stripe_customer_id: 'cus_1',
    detail: { code: 42, retryable: true },
  });
  assert(req !== null);
  const text = JSON.parse(req.body).text;
  assert(text.includes('{"code":42,"retryable":true}'), 'object value should be JSON-stringified');
  assert(!text.includes('[object Object]'), 'object value must not collapse to [object Object]');
});

Deno.test('getAlertConfig: unset env yields undefined apiKey/to and the default from', () => {
  Deno.env.delete('RESEND_API_KEY');
  Deno.env.delete('ALERT_EMAIL_TO');
  Deno.env.delete('ALERT_EMAIL_FROM');

  const config = getAlertConfig();
  assertEquals(config.apiKey, undefined);
  assertEquals(config.to, undefined);
  assertEquals(config.from, 'onboarding@resend.dev');
});

Deno.test('getAlertConfig: set env passes through and overrides the default from', () => {
  Deno.env.set('RESEND_API_KEY', 're_test');
  Deno.env.set('ALERT_EMAIL_TO', 'ops@example.com');
  Deno.env.set('ALERT_EMAIL_FROM', 'alerts@mydomain.com');
  try {
    const config = getAlertConfig();
    assertEquals(config.apiKey, 're_test');
    assertEquals(config.to, 'ops@example.com');
    assertEquals(config.from, 'alerts@mydomain.com');
  } finally {
    Deno.env.delete('RESEND_API_KEY');
    Deno.env.delete('ALERT_EMAIL_TO');
    Deno.env.delete('ALERT_EMAIL_FROM');
  }
});

// --- Dedup / throttle (shouldSuppressAlert + alertFingerprint) ---------------
// These use an injected `now` and a fresh Map so they never touch the wall clock
// or the module-level store, matching how sendAlertEmail passes Date.now().

Deno.test('alertFingerprint: keys on event type + stripe_event_id', () => {
  assertEquals(
    alertFingerprint('webhook.processing_failed', { stripe_event_id: 'evt_1' }),
    'webhook.processing_failed:evt_1',
  );
});

Deno.test('alertFingerprint: falls back to "unknown" when no event id is present', () => {
  assertEquals(alertFingerprint('webhook.orphan_skipped', {}), 'webhook.orphan_skipped:unknown');
});

Deno.test('shouldSuppressAlert: first alert passes, immediate retry of same event is suppressed', () => {
  const store = new Map<string, number>();
  const meta = { stripe_event_id: 'evt_retry' };
  assertEquals(shouldSuppressAlert('webhook.processing_failed', meta, 1_000, store), false);
  // Stripe retries the same event.id a minute later → suppressed.
  assertEquals(shouldSuppressAlert('webhook.processing_failed', meta, 1_000 + 60_000, store), true);
});

Deno.test('shouldSuppressAlert: a retry past the window alerts again', () => {
  const store = new Map<string, number>();
  const meta = { stripe_event_id: 'evt_retry' };
  assertEquals(shouldSuppressAlert('webhook.processing_failed', meta, 0, store), false);
  assertEquals(shouldSuppressAlert('webhook.processing_failed', meta, HOUR_MS, store), false);
});

Deno.test('shouldSuppressAlert: distinct events never suppress each other', () => {
  const store = new Map<string, number>();
  assertEquals(shouldSuppressAlert('webhook.processing_failed', { stripe_event_id: 'evt_a' }, 0, store), false);
  assertEquals(shouldSuppressAlert('webhook.processing_failed', { stripe_event_id: 'evt_b' }, 0, store), false);
  assertEquals(shouldSuppressAlert('webhook.orphan_skipped', { stripe_event_id: 'evt_a' }, 0, store), false);
  assertEquals(store.size, 3);
});

Deno.test('shouldSuppressAlert: expired entries are pruned so the store does not grow unbounded', () => {
  const store = new Map<string, number>();
  shouldSuppressAlert('webhook.processing_failed', { stripe_event_id: 'evt_old' }, 0, store);
  assertEquals(store.size, 1);
  // A later, distinct event past the window prunes the stale entry as a side effect.
  shouldSuppressAlert('webhook.processing_failed', { stripe_event_id: 'evt_new' }, HOUR_MS, store);
  assert(!store.has('webhook.processing_failed:evt_old'), 'stale entry should have been pruned');
  assertEquals(store.size, 1);
});
