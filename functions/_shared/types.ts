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

export interface ErrorResponse {
  error: string;
}

// Portrait generation types
export type PortraitModel = 'flux' | 'seedream';
export type PortraitStyle = 'photorealistic' | 'digital-illustration' | 'anime' | 'oil-painting' | 'watercolor' | 'comic-book';

export interface GeneratePortraitRequest {
  characterName: string;
  description?: string;
  physicalAppearance?: string;
  backstory?: string;
  personality?: string;
  openRouterApiKey: string;
  model?: PortraitModel;
  style?: PortraitStyle;
}

export interface GeneratePortraitResponse {
  imageBase64: string;
  generatedPrompt: string;
  success: boolean;
}

export interface BudgetInfo {
  usagePercent: number;  // 0-100
}
