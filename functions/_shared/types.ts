// Subscription tier and billing types
export type SubscriptionTier = 'none' | 'basic' | 'premium';
export type BillingCycle = 'monthly' | 'yearly';

// Subscription data stored in database (replaces KV)
export interface SubscriptionData {
  status: string;
  currentPeriodEnd: number;
  cancelAtPeriodEnd: boolean;
  priceId?: string;
  subscriptionId?: string;
  plan?: BillingCycle;
  tier?: SubscriptionTier;
  trialEnd?: number;
  /**
   * Epoch ms of the `cached_at` column, populated only by getSubscriptionCache().
   * Optional so every other construction site (syncStripeData, saveSubscriptionCache,
   * handleVerify) is unaffected — they build their own field lists and ignore it.
   * Consumed by isSubscriptionCacheStale() to decide whether a non-entitling cached
   * row must be re-checked against Stripe.
   */
  cachedAt?: number;
}

// JWT payload from Supabase
export interface SupabaseJwtPayload {
  sub: string;
  email: string;
  role: string;
  iat: number;
  exp: number;
  aud: string;
}

// Result of JWT-based auth extraction
export interface AuthResult {
  userId: string;
  email: string;
}

// Result of full subscription validation via JWT
export interface JwtValidationResult {
  valid: boolean;
  email?: string;
  tier?: SubscriptionTier;
  subData?: SubscriptionData;
  customerId?: string;
  userId?: string;
}

// API response types
export interface VerifyResponse {
  active: boolean;
  status: string;
  tier: SubscriptionTier;
  expiresAt?: number;
  cancelAtPeriodEnd?: boolean;
  plan?: BillingCycle;
  trialEnd?: number;
}

export interface PortalResponse {
  url: string;
}

/**
 * Stable, machine-readable reason a request failed. The **client** owns the wording: it maps this
 * to a `providerError.<code>` catalog key, so the sentence the author reads is in their language.
 *
 * `error` stays the English sentence and stays required — it is what the logs and the AI-log
 * viewer show, it is the fallback for a client older than the code it does not know, and for the
 * relay cases (`provider-message`) it is the only thing that carries any information.
 *
 * These strings are a contract with the frontend's `ProviderErrorCode`. Renaming one silently
 * degrades that client to its generic fallback — add a new code instead.
 *
 * Deliberately **not** on the 400-level validation responses: those state which field of the
 * request was malformed, an author cannot trigger them through the UI, and translating
 * "top_p must be between 0 and 1" would serve nobody.
 */
export type ApiErrorCode =
  | 'auth-required'             // 401 — missing/invalid/incomplete JWT
  | 'self-hosted-unavailable'   // 403 — included AI is hosted-only
  | 'subscription-required'     // 403 — no tier, or not the tier this endpoint needs
  | 'budget-exhausted'          // 429 — the account's monthly included-AI budget is spent
  | 'rate-limited'              // 429 — too many requests, or the provider throttled us
  // The upstream provider refused the credential. Answered with **502**, never 401/403:
  // those two are read as *this app's* session by the client's status fallback, and
  // "please sign in" is the wrong instruction for a rejected OpenRouter key.
  | 'api-key-invalid'
  | 'provider-timeout'          // 504 — upstream did not answer in time
  // 504 — OUR per-phase budget ran out, which is a different thing from the provider
  // being slow to answer: the request was still alive and would have finished given
  // more wall clock than the platform allows. Neither of these is `provider-timeout`,
  // whose "please try again" would send the author round the same 150s wall.
  //
  // Two, because the remedy is not the same one. `generation-too-long` is for the
  // size-driven phases (/draft, /refine, /analyze) — ask for less. `step-too-slow` is
  // for /plan and /research, which read neither wordCount nor preset, so asking for
  // less changes nothing; what the author can change there is the model that step uses.
  | 'generation-too-long'
  | 'step-too-slow'
  | 'provider-unavailable'      // 502 — upstream refused, errored, or returned nothing usable
  | 'moderation'                // 400 — the prompt was refused on content grounds
  | 'provider-message';         // the body IS upstream's own text; untranslatable, relay it

export interface ErrorResponse {
  error: string;
  code?: ApiErrorCode;
}

// Public pricing endpoint (GET /stripe/prices) — unauthenticated.
export interface PriceInfo {
  tier: SubscriptionTier;      // 'basic' | 'premium'
  cycle: BillingCycle;         // 'monthly' | 'yearly'
  unitAmount: number;          // MINOR units, e.g. 900 = €9.00
  currency: string;            // ISO 4217 as Stripe returns it (lowercase, e.g. 'eur')
  interval: 'month' | 'year';  // price.recurring.interval
}

export interface PricesResponse {
  prices: PriceInfo[];
}

// Portrait generation types
export type PortraitModel = 'flux' | 'seedream';
export type PortraitStyle = 'photorealistic' | 'digital-illustration' | 'anime' | 'oil-painting' | 'watercolor' | 'comic-book';
export type EntryKind = 'character' | 'location' | 'object' | 'generic';

export interface GeneratePortraitRequest {
  characterName: string;
  description?: string;
  physicalAppearance?: string;
  backstory?: string;
  personality?: string;
  openRouterApiKey: string;
  model?: PortraitModel;
  style?: PortraitStyle;
  entryKind?: EntryKind;
  extraFields?: Record<string, string>;
}

export interface GeneratePortraitResponse {
  imageBase64: string;
  generatedPrompt: string;
  success: boolean;
}

// Included (subsidised) image generation — fal-ai/flux/schnell.
// KEEP IN SYNC with the frontend IncludedImageApiService request type.
export type IncludedImageSize =
  | 'square_hd' | 'square'
  | 'portrait_4_3' | 'portrait_16_9'
  | 'landscape_4_3' | 'landscape_16_9';

export interface IncludedImageRequest {
  // Cover path: a ready-made image prompt is used directly.
  prompt?: string;
  image_size?: IncludedImageSize;
  // Portrait path: structured fields the backend turns into an image prompt
  // via the included DeepSeek text model (no user OpenRouter key needed).
  characterName?: string;
  description?: string;
  physicalAppearance?: string;
  backstory?: string;
  personality?: string;
  style?: PortraitStyle;
  entryKind?: EntryKind;
  extraFields?: Record<string, string>;
}

export interface BudgetInfo {
  usagePercent: number;  // 0-100
}
