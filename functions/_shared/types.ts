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
  // 400 — more reference images than the caller's tier allows. Coded rather than left as a bare
  // validation 400 because, unlike the others, an AUTHOR can reach it without a bug: a tier that
  // changes while the sheet is open (a trial ending, a downgrade) leaves the client holding a
  // cached Premium cap while the server answers on the new one.
  | 'reference-limit'
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

// Included (subsidised) image generation.
// KEEP IN SYNC with the frontend IncludedImageApiService request type.
// `npm run check:shared-constants` fails the build when the two disagree.
export type IncludedImageSize =
  | 'square_hd' | 'square'
  | 'portrait_4_3' | 'portrait_16_9'
  | 'landscape_4_3' | 'landscape_16_9';

/**
 * An explicit output size, which fal accepts anywhere the six tokens above are accepted
 * (`ImageSize` in fal's own schema for `fal-ai/flux-2/klein/4b/edit`, read 2026-08-28).
 *
 * It exists because the tokens cannot express the ratios this app offers. "3:2" is 1.5 and the
 * nearest token, `landscape_4_3`, is 1.333 — 12% out, which is a visibly different picture, and a
 * receipt claiming the aspect was honoured would then be wrong. With a width and a height the
 * four offered ratios are exact.
 *
 * **The pixel count is the cost**, so the server caps it — see MAX_INCLUDED_PIXELS. fal meters
 * this model per output megapixel (`x-fal-billable-units`, measured), so an uncapped size is an
 * uncapped charge against the shared monthly budget.
 */
export interface IncludedImageDimensions {
  width: number;
  height: number;
}

export type IncludedImageSizeInput = IncludedImageSize | IncludedImageDimensions;

export interface IncludedImageRequest {
  // Cover path: a ready-made image prompt is used directly.
  prompt?: string;
  image_size?: IncludedImageSizeInput;
  /**
   * Character reference images as full `data:` URLs, in slot order — the beat-illustration path.
   *
   * **Their presence is what selects the model**: with references the request goes to
   * `fal-ai/flux-2/klein/4b/edit`, without them to `fal-ai/flux/schnell` as before. Only valid
   * alongside `prompt`; the structured portrait path below builds its own prompt from a single
   * codex entry and has no line-up to reference.
   *
   * How many are allowed is the caller's TIER, not a constant — see REFERENCE_CAP_BY_TIER.
   */
  image_urls?: string[];
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
