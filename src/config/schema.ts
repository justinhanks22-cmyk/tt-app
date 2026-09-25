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

export const PixelMappingSchema = z.object({
  advertiserId: z.string(),
  pixelId: z.string(),
  pixelCode: z.string().optional(),
  name: z.string(),
  isDefault: z.boolean().default(false),
});

export const DisplayCardSchema = z
  .object({
    advertiserId: z.string(),
    cardId: z.string(),
    label: z.string(), // exactly as shown on the card, e.g. "$29 TODAY ONLY"
    price: z.number().positive().optional(), // for "$N TODAY ONLY" cards
    offer: z.string().optional(), // for non-price cards, e.g. "70% OFF"
  })
  .refine((c) => c.price !== undefined || c.offer !== undefined, "a display card needs a price or an offer key");

export const DefaultsSchema = z.object({
  dailyBudget: z.number().positive().default(50),
  budgetLevel: z.literal("campaign").default("campaign"),
  delivery: z.literal("Maximum Delivery").default("Maximum Delivery"),
  optimizationEvent: z.string().default("Add to Cart"),
  adCopy: z.string().default("Sale ends at midnight!"),
  placements: z.array(z.literal("TikTok")).default(["TikTok"]),
});

export const NamingSchema = z.object({
  // Tokens: {product} {price} {event} {date}. {date} uses dateFormat.
  campaignTemplate: z.string().default("{product} | ${price} | SPARK | {event} | {date}"),
  adGroupTemplate: z.string().default("{product} | ${price} | {event}"),
  adTemplate: z.string().default("{product} | creative {n}"),
  dateFormat: z.string().default("MM-dd"),
  eventAbbreviations: z.record(z.string(), z.string()).default({ "Add to Cart": "ATC" }),
});

export const SettingsSchema = z.object({
  advertisers: z.array(AdvertiserSchema).default([]),
  postingAccounts: z.array(PostingAccountSchema).default([]),
  pixels: z.array(PixelMappingSchema).default([]),
  displayCards: z.array(DisplayCardSchema).default([]),
  landingPageDomains: z.array(z.string()).default([]),
  defaults: DefaultsSchema.default(DefaultsSchema.parse({})),
  naming: NamingSchema.default(NamingSchema.parse({})),
});

export type Settings = z.infer<typeof SettingsSchema>;
