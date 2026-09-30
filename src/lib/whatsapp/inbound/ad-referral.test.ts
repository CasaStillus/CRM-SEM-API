import { describe, expect, it, vi } from 'vitest';

import {
  buildAdReferralRow,
  extractMetaAdReferral,
  extractUazapiAdReferral,
  isMissingAdReferralColumn,
  mirrorAdThumbnail,
  sanitizeForDiagnosis,
} from './ad-referral';
import { normalizeMetaMessage } from './meta-normalizer';
import { normalizeUazapiWebhook } from './uazapi-normalizer';
import type { NormalizedInboundMessage } from './types';

// A 1x1 JPEG is not needed — the decoder only has to see base64-shaped
// text of plausible length.
const FAKE_JPEG_BASE64 = '/9j/'.padEnd(400, 'A') + '==';

/**
 * WhatsApp's own spelling of the ad card (whatsmeow / protobuf JSON),
 * which is what UAZAPI forwards inside the message content.
 */
const UAZAPI_AD_MESSAGE = {
  id: '5516994306261:3EB0AD1234',
  messageid: '3EB0AD1234',
  chatid: '5511988887777@s.whatsapp.net',
  sender: '5511988887777@s.whatsapp.net',
  sender_pn: '5511988887777@s.whatsapp.net',
  senderName: 'Maria',
  fromMe: false,
  isGroup: false,
  wasSentByApi: false,
  messageType: 'ExtendedTextMessage',
  messageTimestamp: 1790730000000,
  text: 'Olá! Tenho interesse e queria mais informações, por favor.',
  content: {
    text: 'Olá! Tenho interesse e queria mais informações, por favor.',
    contextInfo: {
      conversionSource: 'FB_Ads',
      entryPointConversionSource: 'ctwa_ad',
      entryPointConversionApp: 'instagram',
      externalAdReply: {
        title: 'Casa Stillus — Sofás sob medida',
        body: 'Frete grátis para toda a região. Fale com a gente!',
        mediaType: 1,
        thumbnailURL: 'https://scontent.xx.fbcdn.net/v/t45/ad-thumb.jpg?oe=ABC',
        thumbnail: FAKE_JPEG_BASE64,
        sourceType: 'ad',
        sourceID: '120212345678900123',
        sourceURL: 'https://fb.me/1abcDEF',
        ctwaClid: 'Afc123-click-id',
        showAdAttribution: true,
        renderLargerThumbnail: false,
      },
    },
  },
};

function uazapiDelivery(message: Record<string, unknown>) {
  return {
    EventType: 'messages',
    instanceName: 'wacrm-test',
    token: 'secret-instance-token',
    message,
  };
}

describe('extractUazapiAdReferral', () => {
  it('reads the WhatsApp ad card forwarded by UAZAPI', () => {
    const ad = extractUazapiAdReferral(UAZAPI_AD_MESSAGE);

    expect(ad).toMatchObject({
      source: 'uazapi_external_ad_reply',
      sourceType: 'ad',
      sourceId: '120212345678900123',
      sourceUrl: 'https://fb.me/1abcDEF',
      title: 'Casa Stillus — Sofás sob medida',
      body: 'Frete grátis para toda a região. Fale com a gente!',
      mediaType: 'image',
      thumbnailUrl: 'https://scontent.xx.fbcdn.net/v/t45/ad-thumb.jpg?oe=ABC',
      thumbnailBase64: FAKE_JPEG_BASE64,
      ctwaClid: 'Afc123-click-id',
    });
  });

  it('matches field names regardless of case and underscores', () => {
    const ad = extractUazapiAdReferral({
      messageType: 'ExtendedTextMessage',
      ContextInfo: {
        external_ad_reply: {
          Title: 'Promoção',
          Body: 'Só hoje',
          media_type: 'VIDEO',
          thumbnail_url: 'https://cdn.example/thumb.jpg',
          source_id: '999',
          source_url: 'https://fb.me/x',
        },
      },
    });

    expect(ad).toMatchObject({
      title: 'Promoção',
      body: 'Só hoje',
      mediaType: 'video',
      thumbnailUrl: 'https://cdn.example/thumb.jpg',
      sourceId: '999',
      sourceUrl: 'https://fb.me/x',
    });
  });

  it('flags an ad lead even when no card came with it', () => {
    const ad = extractUazapiAdReferral({
      messageType: 'Conversation',
      content: {
        text: 'oi',
        contextInfo: { conversionSource: 'FB_Ads', ctwaClid: 'clid-1' },
      },
    });

    expect(ad).toMatchObject({
      source: 'uazapi_signal',
      title: null,
      thumbnailUrl: null,
      ctwaClid: 'clid-1',
    });
  });

  it('does not treat an organic wa.me link as an ad', () => {
    expect(
      extractUazapiAdReferral({
        content: {
          contextInfo: { entryPointConversionSource: 'click_to_chat_link' },
        },
      })
    ).toBeNull();
  });

  it('returns null for an ordinary message', () => {
    expect(
      extractUazapiAdReferral({
        id: '1',
        text: 'ola',
        content: 'ola',
        messageType: 'Conversation',
      })
    ).toBeNull();
  });

  it('rejects a non-http thumbnail link and a non-base64 thumbnail', () => {
    const ad = extractUazapiAdReferral({
      content: {
        contextInfo: {
          externalAdReply: {
            title: 'x',
            thumbnailURL: 'javascript:alert(1)',
            thumbnail: 'not base64 at all! '.repeat(10),
          },
        },
      },
    });
    expect(ad?.thumbnailUrl).toBeNull();
    expect(ad?.thumbnailBase64).toBeNull();
  });

  it('keeps a sanitized copy for diagnosis: no long blobs, no secrets', () => {
    const ad = extractUazapiAdReferral({
      content: {
        contextInfo: {
          token: 'should-not-be-stored',
          externalAdReply: { title: 'x', thumbnail: FAKE_JPEG_BASE64 },
        },
      },
    });
    const raw = JSON.stringify(ad?.raw);
    expect(raw).not.toContain('should-not-be-stored');
    expect(raw).not.toContain(FAKE_JPEG_BASE64);
    expect(raw).toContain('omitted');
  });
});

describe('normalizeUazapiWebhook — ad referral', () => {
  it('attaches the ad to the normalized message', () => {
    const result = normalizeUazapiWebhook(uazapiDelivery(UAZAPI_AD_MESSAGE));
    expect(result.outcome).toBe('event');
    if (result.outcome !== 'event') return;

    const event = result.events[0] as NormalizedInboundMessage;
    expect(event.content).toEqual({
      type: 'text',
      text: 'Olá! Tenho interesse e queria mais informações, por favor.',
    });
    expect(event.adReferral?.title).toBe('Casa Stillus — Sofás sob medida');
  });

  it('leaves ordinary messages without the property', () => {
    const result = normalizeUazapiWebhook(
      uazapiDelivery({ ...UAZAPI_AD_MESSAGE, content: 'oi', text: 'oi' })
    );
    if (result.outcome !== 'event') throw new Error('expected an event');
    expect('adReferral' in result.events[0]).toBe(false);
  });

  it('ignores ad context on a message we sent ourselves', () => {
    const result = normalizeUazapiWebhook(
      uazapiDelivery({ ...UAZAPI_AD_MESSAGE, fromMe: true })
    );
    if (result.outcome !== 'event') throw new Error('expected an event');
    expect('adReferral' in result.events[0]).toBe(false);
  });
});

describe('extractMetaAdReferral', () => {
  const REFERRAL = {
    source_url: 'https://fb.me/abc',
    source_id: '2383',
    source_type: 'ad',
    headline: 'Sofás sob medida',
    body: 'Fale com a gente',
    media_type: 'image',
    image_url: 'https://scontent.xx.fbcdn.net/image.jpg',
    ctwa_clid: 'ARAk-clid',
  };

  it('maps Meta’s documented referral', () => {
    expect(extractMetaAdReferral(REFERRAL)).toMatchObject({
      source: 'meta_referral',
      sourceType: 'ad',
      sourceId: '2383',
      sourceUrl: 'https://fb.me/abc',
      title: 'Sofás sob medida',
      body: 'Fale com a gente',
      mediaType: 'image',
      thumbnailUrl: 'https://scontent.xx.fbcdn.net/image.jpg',
      ctwaClid: 'ARAk-clid',
    });
  });

  it('prefers the video thumbnail for a video ad', () => {
    const ad = extractMetaAdReferral({
      ...REFERRAL,
      media_type: 'video',
      image_url: undefined,
      video_url: 'https://cdn.example/v.mp4',
      thumbnail_url: 'https://cdn.example/v.jpg',
    });
    expect(ad?.thumbnailUrl).toBe('https://cdn.example/v.jpg');
    expect(ad?.mediaUrl).toBe('https://cdn.example/v.mp4');
  });

  it('is carried through normalizeMetaMessage', () => {
    const event = normalizeMetaMessage(
      {
        id: 'wamid.1',
        from: '5511988887777',
        timestamp: '1790730000',
        type: 'text',
        text: { body: 'Oi' },
        referral: REFERRAL,
      },
      { wa_id: '5511988887777', profile: { name: 'Maria' } }
    );
    expect(event?.adReferral?.title).toBe('Sofás sob medida');
  });

  it('returns null for an empty referral', () => {
    expect(extractMetaAdReferral({})).toBeNull();
    expect(extractMetaAdReferral(null)).toBeNull();
  });
});

describe('mirrorAdThumbnail', () => {
  function fakeStorage() {
    const uploads: { path: string; contentType: string; bytes: number }[] = [];
    const storage = {
      from: () => ({
        upload: async (
          path: string,
          body: Buffer,
          options: { contentType: string }
        ) => {
          uploads.push({
            path,
            contentType: options.contentType,
            bytes: body.byteLength,
          });
          return { error: null };
        },
        getPublicUrl: (path: string) => ({
          data: { publicUrl: `https://storage.test/${path}` },
        }),
      }),
    };
    return { storage, uploads };
  }

  const referral = extractUazapiAdReferral(UAZAPI_AD_MESSAGE)!;

  it('copies the linked preview into storage', async () => {
    const { storage, uploads } = fakeStorage();
    const fetchImpl = vi.fn(
      async () =>
        new Response(new Uint8Array(1234), {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        })
    );

    const url = await mirrorAdThumbnail({
      storage,
      accountId: 'acc-1',
      externalMessageId: '3EB0AD1234',
      referral,
      occurredAt: '2026-09-29T12:00:00.000Z',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      referral.thumbnailUrl,
      expect.anything()
    );
    expect(url).toMatch(
      /^https:\/\/storage\.test\/account-acc-1\/inbound\/3EB0AD1234-ad/
    );
    expect(uploads[0]).toMatchObject({
      contentType: 'image/jpeg',
      bytes: 1234,
    });
  });

  it('falls back to the embedded preview when the link has expired', async () => {
    const { storage, uploads } = fakeStorage();
    const fetchImpl = vi.fn(async () => new Response('gone', { status: 403 }));

    const url = await mirrorAdThumbnail({
      storage,
      accountId: 'acc-1',
      externalMessageId: '3EB0AD1234',
      referral,
      occurredAt: '2026-09-29T12:00:00.000Z',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(url).not.toBeNull();
    expect(uploads).toHaveLength(1);
    expect(uploads[0].contentType).toBe('image/jpeg');
  });

  it('refuses a link that is not an image', async () => {
    const { storage, uploads } = fakeStorage();
    const fetchImpl = vi.fn(
      async () =>
        new Response('<html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        })
    );

    await mirrorAdThumbnail({
      storage,
      accountId: 'acc-1',
      externalMessageId: 'm',
      referral: { ...referral, thumbnailBase64: null },
      occurredAt: '2026-09-29T12:00:00.000Z',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(uploads).toHaveLength(0);
  });

  it('does nothing without storage', async () => {
    expect(
      await mirrorAdThumbnail({
        storage: null,
        accountId: 'acc-1',
        externalMessageId: 'm',
        referral,
        occurredAt: '2026-09-29T12:00:00.000Z',
      })
    ).toBeNull();
  });
});

describe('buildAdReferralRow / isMissingAdReferralColumn', () => {
  it('prefers the mirrored thumbnail and keeps the provider link otherwise', () => {
    const referral = extractUazapiAdReferral(UAZAPI_AD_MESSAGE)!;
    expect(
      buildAdReferralRow(referral, 'https://mine/x.jpg').thumbnail_url
    ).toBe('https://mine/x.jpg');
    const row = buildAdReferralRow(referral, null);
    expect(row.thumbnail_url).toBe(referral.thumbnailUrl);
    expect(row).not.toHaveProperty('thumbnailBase64');
    expect(JSON.stringify(row)).not.toContain(FAKE_JPEG_BASE64);
  });

  it('recognizes PostgREST’s missing-column error', () => {
    expect(
      isMissingAdReferralColumn({
        code: 'PGRST204',
        message:
          "Could not find the 'ad_referral' column of 'messages' in the schema cache",
      })
    ).toBe(true);
    expect(isMissingAdReferralColumn({ message: 'duplicate key' })).toBe(false);
    expect(isMissingAdReferralColumn(null)).toBe(false);
  });

  it('sanitizeForDiagnosis caps depth', () => {
    let deep: Record<string, unknown> = { v: 1 };
    for (let i = 0; i < 12; i++) deep = { next: deep };
    expect(JSON.stringify(sanitizeForDiagnosis(deep))).toContain('depth limit');
  });
});
