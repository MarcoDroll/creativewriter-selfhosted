/**
 * Which Stripe prices and products are CreativeWriter's.
 *
 * The prod Stripe account bills other things too, so anything that acts on "this customer's
 * subscriptions" must first ask whether each one is ours. delete-account used to cancel every
 * live subscription of every customer carrying the author's email, whatever it sold.
 *
 * **Identity is by id only.** The four configured `STRIPE_*_PRICE_ID_*` prices, the products those
 * prices belong to, and an optional `STRIPE_CW_LEGACY_PRODUCT_IDS` comma list naming older
 * CreativeWriter products. There is deliberately no name match (`getTierFromProductName` is a
 * substring test, so "Premium Support" would count) and no `subscription_cache` lookup (it holds
 * whichever subscription `pickSubscription` chose, product unseen).
 *
 * Pure and SDK-free, so delete-account's cleanup and the webhook can both be unit-tested.
 * `stripe-helpers.ts` re-exports it next to the Stripe-bound loader.
 */

export interface CwCatalog {
  priceIds: ReadonlySet<string>;
  productIds: ReadonlySet<string>;
}

export interface SubscriptionItemRef {
  priceId: string | null;
  productId: string | null;
}

/**
 * - `creativewriter`: every item is ours.
 * - `foreign`: no item is.
 * - `unsure`: some each way, no items at all, an item with no readable price, or a list Stripe truncated (`has_more`) — never
 *   guessed, because an unseen item could be either.
 */
export type ItemsClass = 'creativewriter' | 'foreign' | 'unsure';

export const CW_PRICE_ENV_KEYS = [
  'STRIPE_BASIC_PRICE_ID_MONTHLY',
  'STRIPE_BASIC_PRICE_ID_YEARLY',
  'STRIPE_PREMIUM_PRICE_ID_MONTHLY',
  'STRIPE_PREMIUM_PRICE_ID_YEARLY',
] as const;

export const CW_LEGACY_PRODUCTS_ENV_KEY = 'STRIPE_CW_LEGACY_PRODUCT_IDS';

export function isCreativeWriterItem(item: SubscriptionItemRef, catalog: CwCatalog): boolean {
  return (item.priceId !== null && catalog.priceIds.has(item.priceId))
    || (item.productId !== null && catalog.productIds.has(item.productId));
}

export function classifySubscriptionItems(
  items: readonly SubscriptionItemRef[],
  hasMore: boolean,
  catalog: CwCatalog,
): ItemsClass {
  if (hasMore || items.length === 0) return 'unsure';
  // An item with neither id could not be read: a webhook payload on a newer API version moves an
  // invoice line's price (basil: `pricing.price_details`), and a manual line has none. Unread is
  // not foreign.
  if (items.some(i => i.priceId === null && i.productId === null)) return 'unsure';
  let ours = 0;
  for (const item of items) if (isCreativeWriterItem(item, catalog)) ours++;
  if (ours === items.length) return 'creativewriter';
  if (ours === 0) return 'foreign';
  return 'unsure';
}

/** The four configured price ids, or null when any is unset. */
export function configuredCwPriceIds(env: (key: string) => string | undefined = (k) => Deno.env.get(k)): string[] | null {
  const ids = CW_PRICE_ENV_KEYS.map(k => env(k)?.trim() ?? '');
  return ids.every(Boolean) ? ids : null;
}

export function legacyCwProductIds(env: (key: string) => string | undefined = (k) => Deno.env.get(k)): string[] {
  return (env(CW_LEGACY_PRODUCTS_ENV_KEY) ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(s => s.startsWith('prod_'));
}

/**
 * Builds the catalog from the configured prices: their products (one `retrieveProductOf` per
 * price) plus the legacy list. Returns null when a price env var is unset, so each caller decides
 * what an incomplete configuration means — delete-account aborts, the webhook keeps today's path.
 */
export async function buildCwCatalog(
  retrieveProductOf: (priceId: string) => Promise<string>,
  env: (key: string) => string | undefined = (k) => Deno.env.get(k),
): Promise<CwCatalog | null> {
  const priceIds = configuredCwPriceIds(env);
  if (!priceIds) return null;
  const products = await Promise.all(priceIds.map(retrieveProductOf));
  return {
    priceIds: new Set(priceIds),
    productIds: new Set([...products, ...legacyCwProductIds(env)]),
  };
}

/**
 * The catalog or a thrown error: for a caller that must not guess, which is delete-account. With
 * a price unset it cannot tell CreativeWriter's subscriptions from anything else the account
 * bills, so it refuses to run rather than cancel by default.
 */
export async function requireCwCatalog(
  retrieveProductOf: (priceId: string) => Promise<string>,
  env: (key: string) => string | undefined = (k) => Deno.env.get(k),
): Promise<CwCatalog> {
  const catalog = await buildCwCatalog(retrieveProductOf, env);
  if (!catalog) {
    throw new Error(`Stripe catalog not configured: all of ${CW_PRICE_ENV_KEYS.join(', ')} must be set`);
  }
  return catalog;
}

export interface ForeignProductSkipInput {
  /** The event's items, or null for an event that carries none (a checkout session). */
  refs: { items: SubscriptionItemRef[]; hasMore: boolean } | null;
  configuredPriceIds: readonly string[] | null;
  isMapped(): Promise<boolean>;
  loadCatalog(): Promise<CwCatalog | null>;
}

/**
 * Whether a webhook should be dropped as another product's, before it can reach the orphan path.
 *
 * After delete-account keeps a customer because something else still bills it, that product's
 * renewals arrive with no user to map to. Each one used to raise `webhook.orphan_skipped`, an
 * operator alert, for a subscription that was never ours.
 *
 * Skips only when sure: an unmapped customer and an event whose every item is foreign. A
 * CreativeWriter price, a mixed or truncated list, an event without items, an unknown
 * configuration, a catalog that fails to load, or a customer that is already mapped all keep
 * today's path. The mapped case matters: a legacy CreativeWriter price nobody listed in
 * `STRIPE_CW_LEGACY_PRODUCT_IDS` must still sync for the author it entitles.
 */
export async function shouldSkipAsForeignProduct(input: ForeignProductSkipInput): Promise<boolean> {
  const { refs } = input;
  if (!refs || refs.hasMore || refs.items.length === 0 || !input.configuredPriceIds) return false;
  // No network for the common case: one of our configured prices is on the event.
  const configured = new Set(input.configuredPriceIds);
  if (refs.items.some(i => i.priceId !== null && configured.has(i.priceId))) return false;
  let catalog: CwCatalog | null;
  try {
    // A failed mapping read must not read as "unmapped": that would drop a mapped customer's event.
    if (await input.isMapped()) return false;
    catalog = await input.loadCatalog();
  } catch (err) {
    console.warn(JSON.stringify({
      level: 'warn',
      reason: 'foreign_product_check_failed',
      error: err instanceof Error ? err.message : String(err),
    }));
    return false;
  }
  if (!catalog) return false;
  return classifySubscriptionItems(refs.items, refs.hasMore, catalog) === 'foreign';
}
