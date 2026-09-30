/**
 * The provider-neutral shape of an inbound WhatsApp event.
 *
 * Each provider route owns authentication and its own payload parsing,
 * then hands one of these envelopes to the shared processors. Everything
 * downstream — contacts, conversations, idempotency, unread counts, flow
 * and automation dispatch, public webhooks — works only from this shape,
 * so adding a provider never means touching that logic again.
 *
 * Meta-only concepts stay out of the envelope on purpose: template
 * lifecycle events and reactions are handled inside the Meta route,
 * because UAZAPI v1 has no equivalent and inventing a shared contract for
 * them would be guessing.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import type {
  WhatsAppConnectionStatus,
  WhatsAppProvider,
} from '../providers/types';

/** How a provider points at a media file it delivered. */
export interface NormalizedMedia {
  /** The provider's id for the file, used for idempotent storage paths. */
  externalMediaId: string;
  /**
   * `provider_id` means the file must be fetched through the provider's
   * API (Meta); `provider_url` means the payload carried a direct link
   * (UAZAPI).
   */
  locator: 'provider_id' | 'provider_url';
  locatorValue: string;
  mimeType: string | null;
  fileName: string | null;
  fileSize: number | null;
}

export type NormalizedSenderIdKind = 'bsuid' | 'lid' | 'jid';

export interface NormalizedSender {
  /** Digits-only phone, or `''` when the provider withheld it. */
  phone: string;
  /** Provider-specific identifier, when one was supplied. */
  externalId: string | null;
  externalIdKind: NormalizedSenderIdKind | null;
  /** Meta's portfolio-level id. Null for every other provider. */
  parentExternalId: string | null;
  /**
   * The profile name the provider actually supplied, or null. Distinct
   * from `displayName` on purpose: backfilling a matched contact must not
   * overwrite an agent's hand-edited name with a fallback.
   */
  profileName: string | null;
  /** Name to use when creating a row; falls back to the phone or id. */
  displayName: string;
  username: string | null;
}

export type NormalizedContent =
  | { type: 'text'; text: string }
  | {
      type: 'image' | 'video' | 'audio' | 'document';
      text: string | null;
      /** Null when the provider announced media but sent no locator. */
      media: NormalizedMedia | null;
    }
  | { type: 'location'; text: string }
  | { type: 'interactive'; text: string; replyId: string | null };

/**
 * The thread a message belongs to.
 *
 * In a one-to-one chat this is the sender, so the CRM keys the
 * conversation off the contact as it always has. In a group the thread
 * belongs to the group and the sender is one participant among many —
 * keying off the sender there would scatter one conversation across a
 * contact per person.
 */
export interface NormalizedChat {
  /**
   * The thread's own identifier: the group JID, or the other party's JID
   * in a one-to-one chat. Null when the provider did not name it.
   *
   * This matters most for a message the business typed on its own phone:
   * there the sender is us, and only the chat says who the thread is
   * with.
   */
  externalId: string | null;
  /** Digits-only phone of the other party, or '' when there is none. */
  phone: string;
  isGroup: boolean;
  /** Group subject, when the provider supplied one. */
  name: string | null;
}

/**
 * The ad a lead clicked before writing, when the message came from a
 * click-to-WhatsApp campaign. WhatsApp renders it as the preview card
 * above the customer's first message; the CRM keeps the same fields so
 * the inbox can show the same card.
 *
 * Meta documents this as `referral` on the inbound message. UAZAPI
 * forwards WhatsApp's own `contextInfo.externalAdReply`, whose exact
 * spelling is not documented — `raw` keeps a sanitized copy of what
 * actually arrived, so the mapping can be checked against a real lead.
 */
export interface NormalizedAdReferral {
  /**
   * Which shape was read. `uazapi_signal` means the payload said the
   * conversation came from an ad but carried no card to show.
   */
  source: 'meta_referral' | 'uazapi_external_ad_reply' | 'uazapi_signal';
  /** `ad` or `post`, as the provider reports it. */
  sourceType: string | null;
  /** The ad or post id. */
  sourceId: string | null;
  /** Link to the ad or post. */
  sourceUrl: string | null;
  /** Headline shown in bold on the card. */
  title: string | null;
  /** Ad text shown under the headline. */
  body: string | null;
  /** `image` or `video`. */
  mediaType: string | null;
  /** Provider-hosted preview image. Usually short-lived. */
  thumbnailUrl: string | null;
  /** Provider-hosted full image or video, when supplied. */
  mediaUrl: string | null;
  /**
   * The JPEG preview WhatsApp embeds in the message itself, base64.
   * Used only when the link above cannot be downloaded; never stored.
   */
  thumbnailBase64: string | null;
  /** Click id Meta uses to attribute the conversation to the ad. */
  ctwaClid: string | null;
  /** Sanitized copy of the provider's ad object, for diagnosis. */
  raw: Record<string, unknown>;
}

export interface NormalizedInboundMessage {
  kind: 'message';
  provider: WhatsAppProvider;
  externalMessageId: string;
  /** ISO timestamp, already converted from the provider's own units. */
  occurredAt: string;
  fromMe: boolean;
  isGroup: boolean;
  sender: NormalizedSender;
  chat: NormalizedChat;
  content: NormalizedContent;
  /** The provider id of the message being replied to, when quoting. */
  replyToExternalId: string | null;
  /**
   * The ad the customer clicked to start this conversation. Absent on
   * everything that did not come from a click-to-WhatsApp ad.
   */
  adReferral?: NormalizedAdReferral | null;
  /**
   * Set when the delivery is an emoji reaction to an earlier message
   * rather than a message of its own. A reaction is per-(message, person)
   * state: it is written to `message_reactions`, never to `messages`, and
   * nothing downstream (unread, flows, automations, AI) sees it. Only
   * UAZAPI sets this; the Meta route handles its reactions itself.
   */
  reaction?: NormalizedReaction | null;
}

export interface NormalizedReaction {
  /** The emoji, or '' when the person removed their reaction. */
  emoji: string;
  /** Provider id of the message that was reacted to. */
  targetExternalId: string;
}

export interface NormalizedStatusUpdate {
  kind: 'status';
  provider: WhatsAppProvider;
  externalMessageId: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  occurredAt: string;
  failure: {
    code: string | null;
    title: string | null;
    details: string | null;
  } | null;
}

export interface NormalizedConnectionUpdate {
  kind: 'connection';
  provider: WhatsAppProvider;
  status: Exclude<WhatsAppConnectionStatus, 'not_configured'>;
  occurredAt: string;
  phone: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

export type NormalizedInboundEvent =
  | NormalizedInboundMessage
  | NormalizedStatusUpdate
  | NormalizedConnectionUpdate;

/**
 * Raised when processing failed for a reason that may succeed on a retry
 * — a database or storage blip. Provider routes turn it into a 503 so the
 * provider redelivers, instead of acknowledging a message we dropped.
 */
export class TransientInboundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransientInboundError';
  }
}

/**
 * Turns a media locator into a durable URL. Provider-specific: Meta
 * verifies the id and mirrors the bytes, UAZAPI uses the supplied link or
 * asks for one. Returning a null url means the attachment is unavailable;
 * the message is still stored without it.
 */
export type InboundMediaResolver = (
  media: NormalizedMedia
) => Promise<{ url: string | null; mimeType: string | null }>;

/**
 * Fetches a durable photo URL for a chat, when the provider can supply
 * one. Only UAZAPI implements it today, via `/chat/details` — the
 * webhook payload itself never carries a sender's photo, so this is a
 * separate lookup, not part of the normalized envelope. A provider with
 * no such capability (Meta) simply never passes one, and the contact is
 * created with no photo, same as before this existed.
 */
export type InboundAvatarResolver = (chatId: string) => Promise<string | null>;

/**
 * Always the service-role client: inbound processing has no session to
 * scope by, and it writes tables no browser policy allows.
 */
export type InboundDatabase = SupabaseClient;
