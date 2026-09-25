import sharp from "sharp";
import type { Settings } from "../config/schema.js";
import { isDryRun, type Gateway } from "../tiktok/gateway.js";
import { log } from "../log/logger.js";

/** TikTok requires Display Card images to be exactly 750x421. */
export const CARD_WIDTH = 750;
export const CARD_HEIGHT = 421;

export function formatPrice(price: number): string {
  return Number.isInteger(price) ? String(price) : price.toFixed(2);
}

/** The exact text printed on the card. The card is generated from the price, so it can't disagree. */
export function cardLabel(price: number): string {
  return `$${formatPrice(price)} TODAY ONLY`;
}

const escapeXml = (s: string) => s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Renders a Display Card: product photo on the left, "$NN" and "TODAY ONLY"
 * on the right, white background (the layout of the existing cards).
 */
export async function renderDisplayCard(productImage: Buffer, price: number): Promise<Buffer> {
  const photoWidth = Math.round(CARD_WIDTH * 0.5);
  const photo = await sharp(productImage)
    .resize(photoWidth, CARD_HEIGHT, { fit: "cover", position: "attention" })
    .toBuffer();
  const priceText = escapeXml(`$${formatPrice(price)}`);
  const fontSize = priceText.length <= 4 ? 150 : priceText.length <= 6 ? 110 : 84;
  const textX = photoWidth + (CARD_WIDTH - photoWidth) / 2;
  const svg = `<svg width="${CARD_WIDTH}" height="${CARD_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    <style>text { font-family: 'DejaVu Sans', 'Liberation Sans', Arial, Helvetica, sans-serif; font-weight: 700; fill: #111; }</style>
    <text x="${textX}" y="${CARD_HEIGHT / 2 + fontSize * 0.3}" font-size="${fontSize}" text-anchor="middle">${priceText}</text>
    <text x="${textX}" y="${CARD_HEIGHT / 2 + fontSize * 0.3 + 58}" font-size="40" text-anchor="middle">TODAY ONLY</text>
  </svg>`;
  return sharp({ create: { width: CARD_WIDTH, height: CARD_HEIGHT, channels: 3, background: "#ffffff" } })
    .composite([{ input: photo, left: 0, top: 0 }, { input: Buffer.from(svg), left: 0, top: 0 }])
    .png()
    .toBuffer();
}

/** The product photo from a landing page's og:image (Shopify pages include one). */
export async function productImageFromLandingPage(landingPageUrl: string, fetchImpl: typeof fetch = fetch): Promise<Buffer> {
  const html = await (await fetchImpl(landingPageUrl)).text();
  const match =
    html.match(/<meta[^>]+property="og:image:secure_url"[^>]+content="([^"]+)"/) ??
    html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/);
  if (!match) throw new Error(`No product image (og:image) found on ${landingPageUrl}; provide one explicitly.`);
  const imageUrl = match[1]!.replace(/^http:/, "https:").replace(/&amp;/g, "&");
  const res = await fetchImpl(imageUrl);
  if (!res.ok) throw new Error(`Could not download product image ${imageUrl}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Registers an uploaded card image as a Display Card portfolio.
 * In dry run the write is recorded and a placeholder ID is returned.
 */
export async function createDisplayCard(
  gw: Gateway,
  opts: { advertiserId: string; product: string; price: number; imageId: string },
): Promise<{ cardId: string; label: string; dryRun: boolean }> {
  const portfolio = await gw.call<{ creative_portfolio_id: string }>("portfolioCreate", {
    advertiser_id: opts.advertiserId,
    creative_portfolio_type: "CARD",
    portfolio_content: [{ card_type: "IMAGE", image_id: opts.imageId }],
  });
  const dryRun = isDryRun(portfolio);
  const cardId = dryRun ? portfolio.fakeId : portfolio.creative_portfolio_id;
  log("info", "display_card.created", { product: opts.product, price: opts.price, cardId, dryRun });
  return { cardId, label: cardLabel(opts.price), dryRun };
}

/** Adds a real (non-dry-run) card to the saved library. */
export function rememberDisplayCard(settings: Settings, advertiserId: string, product: string, price: number, cardId: string): void {
  settings.displayCards.push({ advertiserId, cardId, product, price, label: cardLabel(price) });
}
