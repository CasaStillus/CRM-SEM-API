/**
 * Click-to-WhatsApp ad referrals: reading them from each provider's
 * payload, and turning them into what `messages.ad_referral` stores.
 *
 * When someone taps "Send message" on a Facebook or Instagram ad, their
 * first WhatsApp message carries the ad with it. The phone shows that as
 * a card — photo, headline, text — above the message. Before this module
 * the CRM read the text and dropped the card.
 *
 * Two shapes exist:
 *
 * - Meta Cloud API: `message.referral`, documented, snake_case.
 * - UAZAPI: WhatsApp's own `contextInfo.externalAdReply`, forwarded as
 *   the provider's JSON. Its exact spelling is not documented and has
 *   changed between provider versions, so it is found by searching the
 *   payload for the key rather than by a fixed path, and field names are
 *   matched without regard to case or underscores.
 *
 * Everything here is best-effort. A payload we cannot read yields null
 * and the message is stored exactly as before; a thumbnail we cannot
 * mirror keeps the provider link. Nothing in this file may make an
 * inbound delivery fail.
 */

import {
  mirrorInboundMedia,
  type MirrorStorage,
} from '../mirror-inbound-media';
import type { NormalizedAdReferral } from './types';

// ------------------------------------------------------------------
// Reading
// ------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

/** `thumbnailURL`, `thumbnailUrl` and `thumbnail_url` all become `thumbnailurl`. */
function keyOf(name: string): string {
  return name.replace(/[_\-\s]/g, '').toLowerCase();
}

/** First value under any of `names`, matched loosely. */
function pick(obj: Record<string, unknown>, ...names: string[]): unknown {
  const wanted = new Set(names.map(keyOf));
  for (const [key, value] of Object.entries(obj)) {
    if (wanted.has(keyOf(key))) return value;
  }
  return undefined;
}

function pickText(
  obj: Record<string, unknown>,
  ...names: string[]
): string | null {
  const value = pick(obj, ...names);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return asText(value);
}

/** Only absolute http(s) links are worth keeping or fetching. */
function pickUrl(
  obj: Record<string, unknown>,
  ...names: string[]
): string | null {
  for (const name of names) {
    const value = pickText(obj, name);
    if (value && /^https?:\/\//i.test(value)) return value;
  }
  return null;
}

/**
 * WhatsApp's MediaType enum arrives as a number (1 image, 2 video), as
 * the enum name, or as Meta's lower-case word, depending on who
 * serialized it.
 */
function mediaTypeOf(value: unknown): string | null {
  if (value === 1 || value === '1') return 'image';
  if (value === 2 || value === '2') return 'video';
  const text = asText(value)?.toLowerCase();
  if (!text || text === 'none' || text === '0') return null;
  if (text.includes('image')) return 'image';
  if (text.includes('video')) return 'video';
  return text;
}

/**
 * A base64 JPEG as Go's JSON encoder writes a `[]byte`. Anything that
 * does not look like one is ignored rather than handed to the decoder.
 */
function base64Of(value: unknown): string | null {
  const text = asText(value);
  if (!text || text.length < 100) return null;
  const compact = text.replace(/\s/g, '');
  return /^[A-Za-z0-9+/]+={0,2}$/.test(compact) ? compact : null;
}

// ------------------------------------------------------------------
// Sanitized copy for diagnosis
// ------------------------------------------------------------------

const SECRET_KEY = /token|secret|password|authorization|apikey/i;
const MAX_RAW_STRING = 1000;
const MAX_RAW_DEPTH = 6;

/**
 * Deep copy fit for a database column: secrets dropped, long strings
 * (the embedded thumbnail, mostly) replaced by their length, depth
 * capped. The point is to see which keys arrived, not to store bytes.
 */
export function sanitizeForDiagnosis(value: unknown, depth = 0): unknown {
  if (depth > MAX_RAW_DEPTH) return '[depth limit]';
  if (typeof value === 'string') {
    // Long text, and anything shaped like an embedded file, is replaced
    // by its length. Links (signed CDN URLs run to a few hundred chars)
    // are kept: they are what a mapping check needs to see.
    const looksLikeBlob =
      value.length > 200 && /^[A-Za-z0-9+/=\s]+$/.test(value);
    return value.length > MAX_RAW_STRING || looksLikeBlob
      ? `[omitted ${value.length} chars]`
      : value;
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, 20)
      .map((item) => sanitizeForDiagnosis(item, depth + 1));
  }
  const record = asRecord(value);
  if (record) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(record)) {
      if (SECRET_KEY.test(key)) continue;
      out[key] = sanitizeForDiagnosis(item, depth + 1);
    }
    return out;
  }
  return value ?? null;
}

function sanitizedRecord(value: unknown): Record<string, unknown> {
  return asRecord(sanitizeForDiagnosis(value)) ?? {};
}

// ------------------------------------------------------------------
// Meta
// ------------------------------------------------------------------

/** Meta's `referral` object on an inbound message. */
export interface MetaReferralPayload {
  source_url?: string;
  source_id?: string;
  source_type?: string;
  headline?: string;
  body?: string;
  media_type?: string;
  image_url?: string;
  video_url?: string;
  thumbnail_url?: string;
  ctwa_clid?: string;
  [key: string]: unknown;
}

export function extractMetaAdReferral(
  referral: unknown
): NormalizedAdReferral | null {
  const data = asRecord(referral);
  if (!data) return null;

  const mediaType = mediaTypeOf(data.media_type);
  const imageUrl = pickUrl(data, 'image_url');
  const videoUrl = pickUrl(data, 'video_url');
  const thumbnailUrl = pickUrl(data, 'thumbnail_url') ?? imageUrl;

  const result: NormalizedAdReferral = {
    source: 'meta_referral',
    sourceType: pickText(data, 'source_type'),
    sourceId: pickText(data, 'source_id'),
    sourceUrl: pickUrl(data, 'source_url'),
    title: pickText(data, 'headline'),
    body: pickText(data, 'body'),
    mediaType,
    thumbnailUrl,
    mediaUrl: videoUrl ?? imageUrl,
    thumbnailBase64: null,
    ctwaClid: pickText(data, 'ctwa_clid'),
    raw: sanitizedRecord(data),
  };

  return hasAnyAdField(result) ? result : null;
}

// ------------------------------------------------------------------
// UAZAPI
// ------------------------------------------------------------------

const AD_REPLY_KEYS = new Set(['externaladreply']);

/**
 * Keys that say "this conversation started from an ad" even when no
 * card came with them. WhatsApp sets these on the context of a
 * click-to-WhatsApp message.
 */
const CONVERSION_KEYS = new Set([
  'conversionsource',
  'entrypointconversionsource',
  'entrypointconversionapp',
  'ctwaclid',
]);

function looksLikeAdSignal(key: string, value: unknown): boolean {
  if (!CONVERSION_KEYS.has(keyOf(key))) return false;
  const text = asText(value)?.toLowerCase();
  if (!text) return false;
  if (keyOf(key) === 'ctwaclid') return true;
  // `FB_Ads`, `ctwa_ad`, `ig_ad`… — but not an organic `click_to_chat_link`.
  return /(^|[^a-z])ads?([^a-z]|$)|ctwa|_ads?\b/.test(text);
}

interface SearchHit {
  /** The ad card object itself, when one was found. */
  adReply: Record<string, unknown> | null;
  /** The object holding the card or the signal — WhatsApp's contextInfo. */
  container: Record<string, unknown> | null;
  signal: boolean;
}

/**
 * Walks the message payload looking for the ad card. Depth-capped: the
 * card sits three or four levels down in every shape seen so far.
 */
function searchPayload(value: unknown, depth = 0): SearchHit {
  const none: SearchHit = { adReply: null, container: null, signal: false };
  if (depth > 6) return none;

  const record = asRecord(value);
  if (!record) {
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 20)) {
        const hit = searchPayload(item, depth + 1);
        if (hit.adReply || hit.signal) return hit;
      }
    }
    return none;
  }

  let signalHere = false;
  for (const [key, item] of Object.entries(record)) {
    if (AD_REPLY_KEYS.has(keyOf(key))) {
      const adReply = asRecord(item);
      if (adReply) return { adReply, container: record, signal: true };
    }
    if (looksLikeAdSignal(key, item)) signalHere = true;
  }

  // A card deeper down wins over a bare signal at this level.
  for (const item of Object.values(record)) {
    if (typeof item !== 'object' || item === null) continue;
    const hit = searchPayload(item, depth + 1);
    if (hit.adReply) return hit;
    if (hit.signal && !signalHere) return hit;
  }

  return signalHere ? { adReply: null, container: record, signal: true } : none;
}

/**
 * The ad behind a UAZAPI message, or null when it did not come from one.
 *
 * `message` is the provider's message object — the `message` key of a
 * webhook delivery, or one row of `/message/find`.
 */
export function extractUazapiAdReferral(
  message: unknown
): NormalizedAdReferral | null {
  const data = asRecord(message);
  if (!data) return null;

  const hit = searchPayload(data);
  if (!hit.adReply && !hit.signal) return null;

  const container = hit.container ?? {};
  const ctwaClid =
    (hit.adReply && pickText(hit.adReply, 'ctwaClid')) ??
    pickText(container, 'ctwaClid');

  if (!hit.adReply) {
    return {
      source: 'uazapi_signal',
      sourceType: 'ad',
      sourceId: null,
      sourceUrl: null,
      title: null,
      body: null,
      mediaType: null,
      thumbnailUrl: null,
      mediaUrl: null,
      thumbnailBase64: null,
      ctwaClid,
      raw: sanitizedRecord(container),
    };
  }

  const ad = hit.adReply;
  const sourceType = pickText(ad, 'sourceType');

  return {
    source: 'uazapi_external_ad_reply',
    sourceType: sourceType ? sourceType.toLowerCase() : 'ad',
    sourceId: pickText(ad, 'sourceID', 'sourceId'),
    sourceUrl: pickUrl(ad, 'sourceURL', 'sourceUrl', 'adPreviewURL'),
    title: pickText(ad, 'title'),
    body: pickText(ad, 'body'),
    mediaType: mediaTypeOf(pick(ad, 'mediaType')),
    thumbnailUrl: pickUrl(
      ad,
      'thumbnailURL',
      'thumbnailUrl',
      'originalImageURL',
      'previewURL'
    ),
    mediaUrl: pickUrl(ad, 'mediaURL', 'mediaUrl'),
    thumbnailBase64: base64Of(pick(ad, 'thumbnail', 'jpegThumbnail')),
    ctwaClid,
    raw: sanitizedRecord(container),
  };
}

function hasAnyAdField(ad: NormalizedAdReferral): boolean {
  return Boolean(
    ad.sourceId ||
    ad.sourceUrl ||
    ad.title ||
    ad.body ||
    ad.thumbnailUrl ||
    ad.ctwaClid
  );
}

// ------------------------------------------------------------------
// Storing
// ------------------------------------------------------------------

/** What `messages.ad_referral` holds. snake_case like every other column. */
export interface AdReferralRow {
  source: NormalizedAdReferral['source'];
  source_type: string | null;
  source_id: string | null;
  source_url: string | null;
  title: string | null;
  body: string | null;
  media_type: string | null;
  /** The mirrored copy when the mirror worked, otherwise the provider link. */
  thumbnail_url: string | null;
  media_url: string | null;
  ctwa_clid: string | null;
  raw: Record<string, unknown>;
}

const THUMBNAIL_TIMEOUT_MS = 10_000;
/** A card preview is a few hundred KB at most. */
const THUMBNAIL_MAX_BYTES = 5 * 1024 * 1024;

function thumbnailDownloader(fetchImpl: typeof fetch) {
  return async ({ downloadUrl }: { downloadUrl: string }) => {
    const response = await fetchImpl(downloadUrl, {
      signal: AbortSignal.timeout(THUMBNAIL_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`thumbnail download failed with HTTP ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > THUMBNAIL_MAX_BYTES) {
      throw new Error(`thumbnail is ${buffer.byteLength} bytes`);
    }
    const contentType = response.headers?.get?.('content-type') ?? '';
    if (contentType && !contentType.toLowerCase().startsWith('image/')) {
      throw new Error(`thumbnail is ${contentType}, not an image`);
    }
    return { buffer, contentType: contentType || 'image/jpeg' };
  };
}

function base64Downloader(base64: string) {
  return async () => ({
    buffer: Buffer.from(base64, 'base64'),
    contentType: 'image/jpeg',
  });
}

/**
 * Copies the ad's preview image into `chat-media`, because the link the
 * provider hands over is signed and expires within days — the card
 * would lose its photo long before anyone stops looking at the lead.
 *
 * Tries the link first (it is the sharper image) and the preview
 * embedded in the message second. Returns null when neither worked; the
 * caller then keeps the provider link.
 */
export async function mirrorAdThumbnail(input: {
  storage: MirrorStorage | null;
  accountId: string;
  externalMessageId: string;
  referral: NormalizedAdReferral;
  occurredAt: string;
  fetchImpl?: typeof fetch;
}): Promise<string | null> {
  const { storage, referral } = input;
  if (!storage) return null;

  const mediaId = `${input.externalMessageId}-ad`;
  const messageTimestamp = Date.parse(input.occurredAt) || null;

  if (referral.thumbnailUrl) {
    const mirrored = await mirrorInboundMedia({
      storage,
      accountId: input.accountId,
      mediaId,
      downloadUrl: referral.thumbnailUrl,
      mimeType: null,
      messageTimestamp,
      download: thumbnailDownloader(input.fetchImpl ?? globalThis.fetch),
    });
    if (mirrored) return mirrored;
  }

  if (referral.thumbnailBase64) {
    return mirrorInboundMedia({
      storage,
      accountId: input.accountId,
      mediaId,
      downloadUrl: 'embedded-thumbnail',
      mimeType: 'image/jpeg',
      messageTimestamp,
      download: base64Downloader(referral.thumbnailBase64),
    });
  }

  return null;
}

export function buildAdReferralRow(
  referral: NormalizedAdReferral,
  mirroredThumbnailUrl: string | null
): AdReferralRow {
  return {
    source: referral.source,
    source_type: referral.sourceType,
    source_id: referral.sourceId,
    source_url: referral.sourceUrl,
    title: referral.title,
    body: referral.body,
    media_type: referral.mediaType,
    thumbnail_url: mirroredThumbnailUrl ?? referral.thumbnailUrl,
    media_url: referral.mediaUrl,
    ctwa_clid: referral.ctwaClid,
    raw: referral.raw,
  };
}

/**
 * True when an insert failed only because migration 051 has not been
 * applied yet. The caller then stores the message without the card
 * rather than losing the message.
 */
export function isMissingAdReferralColumn(error: unknown): boolean {
  const record = asRecord(error);
  if (!record) return false;
  const text = [record.message, record.details, record.hint]
    .filter((part): part is string => typeof part === 'string')
    .join(' ');
  return /ad_referral/.test(text);
}
