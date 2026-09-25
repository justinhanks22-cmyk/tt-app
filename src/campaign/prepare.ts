import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Settings } from "../config/schema.js";
import { cardLabel, productImageFromLandingPage, renderDisplayCard } from "../creative/displayCard.js";
import { ingestCreative, type IngestedVideo } from "../creative/ingest.js";
import { planCampaign, PlanError, selectDisplayCard, type CampaignPlan, type CampaignRequest } from "./plan.js";
import { reviewSummary } from "./run.js";
import { validateCampaign, type Check, type LiveFacts } from "./validate.js";

/** One video: a TikTok link, optionally with the original file if the link can't be downloaded. */
export interface VideoInput {
  url?: string;
  file?: string;
}

/** What the form (or a request file) provides. */
export interface PrepareInput extends Omit<CampaignRequest, "uploads" | "tiktokItemIds"> {
  tiktokItemIds?: string[];
  videos?: VideoInput[];
  /** The user confirms they own or have permission for every video. */
  rightsConfirmed: boolean;
  productImage?: string;
}

export interface Prepared {
  plan: CampaignPlan;
  checks: Check[];
  review: ReturnType<typeof reviewSummary>;
}

/** Per-video problems (e.g. a blocked download) reported without losing the others. */
export class PrepareError extends Error {
  constructor(message: string, readonly problems: { video: string; error: string }[] = []) {
    super(message);
  }
}

/**
 * Link(s) → videos, price → display card, form → plan, then live checks.
 * Nothing is written to TikTok here.
 */
export async function prepareCampaign(
  settings: Settings,
  input: PrepareInput,
  liveFacts: (plan: CampaignPlan) => Promise<LiveFacts>,
  now = new Date(),
): Promise<Prepared> {
  const uploads: IngestedVideo[] = [];
  const problems: { video: string; error: string }[] = [];
  for (const v of input.videos ?? []) {
    try {
      uploads.push(await ingestCreative({ filePath: v.file, url: v.url, rightsConfirmed: input.rightsConfirmed }));
    } catch (err) {
      problems.push({ video: v.url ?? v.file ?? "?", error: (err as Error).message });
    }
  }
  if (problems.length) throw new PrepareError(`${problems.length} video(s) couldn't be prepared`, problems);

  const request: CampaignRequest = { ...input, tiktokItemIds: input.tiktokItemIds ?? [], uploads };

  // Display card: reuse an exact product+price card, otherwise generate one from the price.
  let generated: { pngPath: string; label: string } | undefined;
  try {
    selectDisplayCard(settings, request.advertiserId, request.productName, request.price);
  } catch (err) {
    if (!(err instanceof PlanError) || /match/.test(err.message)) throw err;
    const photo = input.productImage ? readFileSync(input.productImage) : await productImageFromLandingPage(request.landingPageUrl);
    mkdirSync("media/cards", { recursive: true });
    const pngPath = `media/cards/${request.productName.replace(/[^\w-]+/g, "-").toLowerCase()}-${request.price}.png`;
    writeFileSync(pngPath, await renderDisplayCard(photo, request.price));
    generated = { pngPath, label: cardLabel(request.price) };
  }

  const plan = planCampaign(settings, request, now, generated);
  const checks = validateCampaign(plan, settings, await liveFacts(plan), now);
  return { plan, checks, review: reviewSummary(plan, checks) };
}
