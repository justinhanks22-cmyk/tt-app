import { z } from "zod";

/**
 * Saved, non-secret configuration (config/settings.json). Everything the user
 * sets up once lives here. Values that map to TikTok API enums are stored as
 * the human label and translated at request time, after the enum is checked
 * against the current official docs (see docs/capability-matrix.md).
 */
export const AdvertiserSchema = z.object({
  advertiserId: z.string().regex(/^\d+$/, "advertiser IDs are numeric"),
  name: z.string(),
  currency: z.string().optional(),
  timezone: z.string().optional(),
});

export const PostingAccountSchema = z.object({
  label: z.string(),
  handle: z.string(),
  // Filled in Phase 4 from identity/get once the account is linked to an ad account.
  identityType: z.string().optional(),
  identityId: z.string().optional(),
  identityAuthorizedBcId: z.string().optional(),
});

// Display cards are images (product photo + price text); the API returns no
// label, so each card's product and price are recorded here when it's added.
export const DisplayCardSchema = z
  .object({
    advertiserId: z.string(),
    cardId: z.string(), // creative_portfolio_id, type CARD
    product: z.string().optional(),
    label: z.string(), // exactly as shown on the card, e.g. "$29 TODAY ONLY"
    price: z.number().positive().optional(), // for "$N TODAY ONLY" cards
    offer: z.string().optional(), // for non-price cards, e.g. "70% OFF"
  })
  .refine((c) => c.price !== undefined || c.offer !== undefined, "a display card needs a price or an offer key");

/**
 * Product-test defaults: Upgraded Smart+ "Sales → Website" campaign, catalog
 * off, Maximum Delivery, TikTok-only placement, audiences left automatic,
 * no products, no catalog creatives, no recommendations/enhancements.
 * Values not specified by the user mirror the live "poncho" campaign.
 */
export const DefaultsSchema = z.object({
  dailyBudget: z.number().positive().default(50),
  optimizationEvent: z.string().default("ON_WEB_CART"), // Add to Cart
  locationIds: z.array(z.string()).default(["6252001"]), // United States
  audienceAge: z.enum(["ALL", "OVER_EIGHTEEN", "OVER_TWENTY_FIVE"]).default("ALL"),
  commentDisabled: z.boolean().default(true),
  videoDownloadDisabled: z.boolean().default(true),
  // Dynamic CTA portfolio required for Spark ads on TikTok placement.
  ctaPortfolioId: z.string().default("7689257320064322567"),
  // One ad per creative (true) or one ad holding all creatives (false).
  oneAdPerCreative: z.boolean().default(true),
});

export const NamingSchema = z.object({
  // Tokens: {product} {price} {event} {date}. {date} uses dateFormat.
  campaignTemplate: z.string().default("{product} | ${price} | SPARK | {event} | {date}"),
  adGroupTemplate: z.string().default("{product} | ${price} | {event}"),
  adTemplate: z.string().default("{product} | creative {n}"),
  dateFormat: z.string().default("MM-dd"),
  eventAbbreviations: z.record(z.string(), z.string()).default({ ON_WEB_CART: "ATC" }),
  timezone: z.string().default("America/New_York"),
});

export const SettingsSchema = z.object({
  advertisers: z.array(AdvertiserSchema).default([]),
  postingAccounts: z.array(PostingAccountSchema).default([]),
  // No saved pixel list: pixels are created/deleted per product, so the pixel
  // is chosen for each campaign and re-verified live (exists, has Add to Cart).
  displayCards: z.array(DisplayCardSchema).default([]),
  landingPageDomains: z.array(z.string()).default([]),
  defaults: DefaultsSchema.default(DefaultsSchema.parse({})),
  naming: NamingSchema.default(NamingSchema.parse({})),
});

export type Settings = z.infer<typeof SettingsSchema>;
