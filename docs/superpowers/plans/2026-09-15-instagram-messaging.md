# Instagram Direct Messaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Instagram Direct messages arrive in the wacrm inbox and let an agent reply to them from the CRM, as a fully independent channel from WhatsApp.

**Architecture:** Four new, fully isolated tables (`instagram_config`, `instagram_contacts`, `instagram_conversations`, `instagram_messages`) — no shared rows with the WhatsApp tables. A dedicated webhook route parses the Messenger-style `entry[].messaging[]` payload Instagram sends (different shape from WhatsApp's `entry[].changes[]`), a dedicated send route posts to the Instagram Graph API, and a dedicated, deliberately simple inbox UI lives behind a new "Instagram" tab next to the existing "WhatsApp" tab.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Supabase (Postgres + Auth + Storage + Realtime), Tailwind v4, Vitest. No new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-09-15-instagram-integration-design.md`

## Global Constraints

- No new npm dependencies — use the built-in `fetch`, the existing `@supabase/supabase-js` client, and existing storage helpers.
- Reuse `@/lib/whatsapp/encryption` (`encrypt`/`decrypt`) and `@/lib/whatsapp/webhook-signature` (`verifyMetaWebhookSignature`) exactly as they are — do not duplicate or modify them; they are already provider-agnostic despite the file path.
- The four new tables are fully independent of `contacts`/`conversations`/`messages` — no task may read from or write to those tables.
- `messages/en.json` is the source of truth for i18n; `pt.json`, `ko.json`, `es.json` must carry every new key with the same ICU placeholder signature or `src/i18n/messages.test.ts` fails. New strings here have no placeholders, so parity is just "same keys."
- Test runner is Vitest (`npm test`). Every new `src/lib/**` and `src/app/api/**` file gets a co-located `*.test.ts`. Component files (`.tsx`) follow existing repo convention and have no automated test — verify those manually in the browser.
- Do not commit to git automatically after each task unless the user has asked for it in this session; do not push/deploy.
- Local testing needs a public HTTPS tunnel (e.g. ngrok) pointed at `npm run dev` for the webhook — flagged again at the relevant task.

---

### Task 1: Database migration

**Files:**
- Create: `supabase/migrations/043_instagram_messaging.sql`

**Interfaces:**
- Produces: tables `instagram_config`, `instagram_contacts`, `instagram_conversations`, `instagram_messages` with the columns listed below — every later task's Supabase queries assume these exact names and types.

- [ ] **Step 1: Write the migration**

```sql
-- ============================================================
-- 043_instagram_messaging
--
-- Instagram Direct as an independent messaging channel. Fully
-- separate from contacts/conversations/messages (WhatsApp) — no
-- shared rows, no merged contact identity. See
-- docs/superpowers/specs/2026-09-15-instagram-integration-design.md
-- ============================================================

CREATE TABLE IF NOT EXISTS instagram_config (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL,
  ig_user_id TEXT NOT NULL,
  ig_username TEXT,
  page_access_token TEXT NOT NULL,
  verify_token TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'disconnected' CHECK (status IN ('connected', 'disconnected')),
  connected_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(account_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_instagram_config_ig_user_id ON instagram_config(ig_user_id);

ALTER TABLE instagram_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Account members can view instagram config" ON instagram_config;
DROP POLICY IF EXISTS "Account admins can manage instagram config" ON instagram_config;
CREATE POLICY "Account members can view instagram config" ON instagram_config
  FOR SELECT USING (is_account_member(account_id));
CREATE POLICY "Account admins can manage instagram config" ON instagram_config
  FOR ALL USING (is_account_member(account_id, 'admin')) WITH CHECK (is_account_member(account_id, 'admin'));

CREATE TABLE IF NOT EXISTS instagram_contacts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  igsid TEXT NOT NULL,
  username TEXT,
  name TEXT,
  profile_pic_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(account_id, igsid)
);

CREATE INDEX IF NOT EXISTS idx_instagram_contacts_account ON instagram_contacts(account_id);

ALTER TABLE instagram_contacts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Account members can view instagram contacts" ON instagram_contacts;
DROP POLICY IF EXISTS "Account agents can manage instagram contacts" ON instagram_contacts;
CREATE POLICY "Account members can view instagram contacts" ON instagram_contacts
  FOR SELECT USING (is_account_member(account_id));
CREATE POLICY "Account agents can manage instagram contacts" ON instagram_contacts
  FOR ALL USING (is_account_member(account_id, 'agent')) WITH CHECK (is_account_member(account_id, 'agent'));

CREATE TABLE IF NOT EXISTS instagram_conversations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES instagram_contacts(id) ON DELETE CASCADE,
  last_message_text TEXT,
  last_message_at TIMESTAMPTZ,
  last_customer_message_at TIMESTAMPTZ,
  unread_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(account_id, contact_id)
);

CREATE INDEX IF NOT EXISTS idx_instagram_conversations_account ON instagram_conversations(account_id);
CREATE INDEX IF NOT EXISTS idx_instagram_conversations_contact ON instagram_conversations(contact_id);

ALTER TABLE instagram_conversations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Account members can view instagram conversations" ON instagram_conversations;
DROP POLICY IF EXISTS "Account agents can manage instagram conversations" ON instagram_conversations;
CREATE POLICY "Account members can view instagram conversations" ON instagram_conversations
  FOR SELECT USING (is_account_member(account_id));
CREATE POLICY "Account agents can manage instagram conversations" ON instagram_conversations
  FOR ALL USING (is_account_member(account_id, 'agent')) WITH CHECK (is_account_member(account_id, 'agent'));

CREATE TABLE IF NOT EXISTS instagram_messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID NOT NULL REFERENCES instagram_conversations(id) ON DELETE CASCADE,
  sender_type TEXT NOT NULL CHECK (sender_type IN ('customer', 'agent')),
  sender_id UUID,
  content_type TEXT NOT NULL DEFAULT 'text' CHECK (content_type IN (
    'text', 'image', 'video', 'audio', 'file', 'share', 'story_mention', 'story_reply', 'unsupported'
  )),
  content_text TEXT,
  media_url TEXT,
  media_type TEXT,
  ig_message_id TEXT,
  reply_to_message_id UUID REFERENCES instagram_messages(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sending', 'sent', 'delivered', 'failed')),
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_instagram_messages_conversation ON instagram_messages(conversation_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_instagram_messages_conv_ig_id
  ON instagram_messages(conversation_id, ig_message_id) WHERE ig_message_id IS NOT NULL;

ALTER TABLE instagram_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Account members can view instagram messages" ON instagram_messages;
DROP POLICY IF EXISTS "Account agents can manage instagram messages" ON instagram_messages;
CREATE POLICY "Account members can view instagram messages" ON instagram_messages
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM instagram_conversations c
      WHERE c.id = instagram_messages.conversation_id AND is_account_member(c.account_id)
    )
  );
CREATE POLICY "Account agents can manage instagram messages" ON instagram_messages
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM instagram_conversations c
      WHERE c.id = instagram_messages.conversation_id AND is_account_member(c.account_id, 'agent')
    )
  ) WITH CHECK (
    EXISTS (
      SELECT 1 FROM instagram_conversations c
      WHERE c.id = instagram_messages.conversation_id AND is_account_member(c.account_id, 'agent')
    )
  );

DROP TRIGGER IF EXISTS set_updated_at ON instagram_config;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON instagram_config FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at ON instagram_contacts;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON instagram_contacts FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at ON instagram_conversations;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON instagram_conversations FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'instagram_messages'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE instagram_messages;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'instagram_conversations'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE instagram_conversations;
  END IF;
END $$;
```

- [ ] **Step 2: Apply it locally and verify**

Run against the local/dev Supabase project (via the Supabase CLI, `supabase db push`, or pasting into the SQL editor — whichever the project already uses). Then verify:

```sql
select table_name from information_schema.tables
where table_name like 'instagram_%';
```

Expected: `instagram_config`, `instagram_contacts`, `instagram_conversations`, `instagram_messages` all listed.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/043_instagram_messaging.sql
git commit -m "feat(instagram): add instagram messaging schema"
```

---

### Task 2: TypeScript types

**Files:**
- Create: `src/types/instagram.ts`

**Interfaces:**
- Produces: `InstagramConfig`, `InstagramContact`, `InstagramConversation`, `InstagramMessage`, `InstagramSenderType`, `InstagramContentType`, `InstagramMessageStatus`, `InstagramConnectionStatus` — every later TS task imports these exact names from `@/types/instagram`.

- [ ] **Step 1: Write the types**

```typescript
export type InstagramConnectionStatus = 'connected' | 'disconnected';

export interface InstagramConfig {
  id: string;
  account_id: string;
  page_id: string;
  ig_user_id: string;
  ig_username?: string | null;
  status: InstagramConnectionStatus;
  connected_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface InstagramContact {
  id: string;
  account_id: string;
  igsid: string;
  username?: string | null;
  name?: string | null;
  profile_pic_url?: string | null;
  created_at: string;
  updated_at: string;
}

export interface InstagramConversation {
  id: string;
  account_id: string;
  contact_id: string;
  last_message_text?: string | null;
  last_message_at?: string | null;
  last_customer_message_at?: string | null;
  unread_count: number;
  created_at: string;
  updated_at: string;
  contact?: InstagramContact;
}

export type InstagramSenderType = 'customer' | 'agent';
export type InstagramContentType =
  | 'text'
  | 'image'
  | 'video'
  | 'audio'
  | 'file'
  | 'share'
  | 'story_mention'
  | 'story_reply'
  | 'unsupported';
export type InstagramMessageStatus = 'sending' | 'sent' | 'delivered' | 'failed';

export interface InstagramMessage {
  id: string;
  conversation_id: string;
  sender_type: InstagramSenderType;
  sender_id?: string | null;
  content_type: InstagramContentType;
  content_text?: string | null;
  media_url?: string | null;
  media_type?: string | null;
  ig_message_id?: string | null;
  reply_to_message_id?: string | null;
  status: InstagramMessageStatus;
  error_message?: string | null;
  created_at: string;
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: passes (this file has no consumers yet, so it can only fail on its own syntax).

- [ ] **Step 3: Commit**

```bash
git add src/types/instagram.ts
git commit -m "feat(instagram): add TypeScript types for the Instagram channel"
```

---

### Task 3: Messaging-window helper

**Files:**
- Create: `src/lib/instagram/messaging-window.ts`
- Test: `src/lib/instagram/messaging-window.test.ts`

**Interfaces:**
- Produces: `isMessagingWindowOpen(lastCustomerMessageAt, now?)`, `messagingWindowClosesAt(lastCustomerMessageAt)`, `MESSAGING_WINDOW_MS` — used by Task 6 (send core) and Task 14 (composer).

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from 'vitest';
import { isMessagingWindowOpen, messagingWindowClosesAt, MESSAGING_WINDOW_MS } from './messaging-window';

describe('isMessagingWindowOpen', () => {
  it('is closed when there is no last customer message', () => {
    expect(isMessagingWindowOpen(null)).toBe(false);
    expect(isMessagingWindowOpen(undefined)).toBe(false);
  });

  it('is open just under 24h after the last customer message', () => {
    const now = new Date('2026-01-02T00:00:00.000Z');
    const last = new Date(now.getTime() - MESSAGING_WINDOW_MS + 1000).toISOString();
    expect(isMessagingWindowOpen(last, now)).toBe(true);
  });

  it('is closed exactly at 24h and beyond', () => {
    const now = new Date('2026-01-02T00:00:00.000Z');
    const last = new Date(now.getTime() - MESSAGING_WINDOW_MS).toISOString();
    expect(isMessagingWindowOpen(last, now)).toBe(false);
  });

  it('is closed for an unparseable date', () => {
    expect(isMessagingWindowOpen('not-a-date')).toBe(false);
  });
});

describe('messagingWindowClosesAt', () => {
  it('returns null with no last customer message', () => {
    expect(messagingWindowClosesAt(null)).toBeNull();
  });

  it('returns 24h after the last customer message', () => {
    const last = '2026-01-01T00:00:00.000Z';
    expect(messagingWindowClosesAt(last)).toBe('2026-01-02T00:00:00.000Z');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/instagram/messaging-window.test.ts`
Expected: FAIL — `./messaging-window` has no exports yet.

- [ ] **Step 3: Write the implementation**

```typescript
/**
 * Instagram's standard messaging window: free-form replies are only
 * allowed within 24h of the customer's last message. Outside it,
 * `POST /me/messages` returns error 1545041 ("Messaging window closed").
 * There is no generic template mechanism to send after it closes (unlike
 * WhatsApp), so the CRM just disables the composer.
 */
export const MESSAGING_WINDOW_MS = 24 * 60 * 60 * 1000;

export function isMessagingWindowOpen(
  lastCustomerMessageAt: string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!lastCustomerMessageAt) return false;
  const last = new Date(lastCustomerMessageAt).getTime();
  if (Number.isNaN(last)) return false;
  return now.getTime() - last < MESSAGING_WINDOW_MS;
}

export function messagingWindowClosesAt(
  lastCustomerMessageAt: string | null | undefined,
): string | null {
  if (!lastCustomerMessageAt) return null;
  const last = new Date(lastCustomerMessageAt).getTime();
  if (Number.isNaN(last)) return null;
  return new Date(last + MESSAGING_WINDOW_MS).toISOString();
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/lib/instagram/messaging-window.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/instagram/messaging-window.ts src/lib/instagram/messaging-window.test.ts
git commit -m "feat(instagram): add 24h messaging-window helper"
```

---

### Task 4: Graph API client

**Files:**
- Create: `src/lib/instagram/graph-api.ts`
- Test: `src/lib/instagram/graph-api.test.ts`

**Interfaces:**
- Consumes: nothing local (raw `fetch`).
- Produces: `InstagramApiError`, `fetchInstagramProfile({igsid, pageAccessToken})`, `sendInstagramTextMessage({igsid, pageAccessToken, text, replyToMid?})`, `sendInstagramAttachmentMessage({igsid, pageAccessToken, attachmentType, mediaUrl, replyToMid?})`, `markInstagramSeen({igsid, pageAccessToken})`, `InstagramOutboundAttachmentType`, `SendMessageResult {recipientId, messageId}` — consumed by Task 6 (send core) and Task 7 (webhook route).

- [ ] **Step 1: Write the failing test**

```typescript
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchInstagramProfile,
  InstagramApiError,
  markInstagramSeen,
  sendInstagramAttachmentMessage,
  sendInstagramTextMessage,
} from './graph-api';

function mockFetchOnce(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sendInstagramTextMessage', () => {
  it('posts to /me/messages and returns the message id', async () => {
    mockFetchOnce(200, { recipient_id: 'igsid-1', message_id: 'mid-1' });
    const result = await sendInstagramTextMessage({
      igsid: 'igsid-1',
      pageAccessToken: 'token',
      text: 'Hello',
    });
    expect(result).toEqual({ recipientId: 'igsid-1', messageId: 'mid-1' });
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('/me/messages');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      recipient: { id: 'igsid-1' },
      message: { text: 'Hello' },
    });
  });

  it('includes reply_to when replyToMid is set', async () => {
    mockFetchOnce(200, { recipient_id: 'igsid-1', message_id: 'mid-2' });
    await sendInstagramTextMessage({
      igsid: 'igsid-1',
      pageAccessToken: 'token',
      text: 'Hi',
      replyToMid: 'mid-1',
    });
    const [, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse((init as RequestInit).body as string).reply_to).toEqual({ mid: 'mid-1' });
  });

  it('throws InstagramApiError carrying the messaging-window code on a closed-window response', async () => {
    mockFetchOnce(400, { error: { message: 'Messaging window closed', code: 1545041 } });
    await expect(
      sendInstagramTextMessage({ igsid: 'igsid-1', pageAccessToken: 'token', text: 'Hi' }),
    ).rejects.toMatchObject({ code: 1545041 } satisfies Partial<InstagramApiError>);
  });
});

describe('sendInstagramAttachmentMessage', () => {
  it('posts an attachment payload with the given type and url', async () => {
    mockFetchOnce(200, { recipient_id: 'igsid-1', message_id: 'mid-3' });
    await sendInstagramAttachmentMessage({
      igsid: 'igsid-1',
      pageAccessToken: 'token',
      attachmentType: 'image',
      mediaUrl: 'https://example.com/a.png',
    });
    const [, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      recipient: { id: 'igsid-1' },
      message: { attachment: { type: 'image', payload: { url: 'https://example.com/a.png' } } },
    });
  });
});

describe('fetchInstagramProfile', () => {
  it('returns the profile fields', async () => {
    mockFetchOnce(200, { name: 'Jane', username: 'jane.doe', profile_pic: 'https://x/y.jpg' });
    const profile = await fetchInstagramProfile({ igsid: 'igsid-1', pageAccessToken: 'token' });
    expect(profile).toEqual({ name: 'Jane', username: 'jane.doe', profile_pic: 'https://x/y.jpg' });
  });
});

describe('markInstagramSeen', () => {
  it('posts a mark_seen sender action', async () => {
    mockFetchOnce(200, { recipient_id: 'igsid-1' });
    await markInstagramSeen({ igsid: 'igsid-1', pageAccessToken: 'token' });
    const [, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      recipient: { id: 'igsid-1' },
      sender_action: 'mark_seen',
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/instagram/graph-api.test.ts`
Expected: FAIL — `./graph-api` has no exports yet.

- [ ] **Step 3: Write the implementation**

```typescript
const GRAPH_API_VERSION = 'v21.0';
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

export class InstagramApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
    readonly subcode?: number,
  ) {
    super(message);
    this.name = 'InstagramApiError';
  }
}

async function graphFetch(
  path: string,
  accessToken: string,
  init?: RequestInit,
): Promise<unknown> {
  const url = `${GRAPH_API_BASE}${path}${path.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(accessToken)}`;
  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = (data as { error?: { message?: string; code?: number; error_subcode?: number } }).error;
    throw new InstagramApiError(
      err?.message ?? `Instagram Graph API request failed with status ${res.status}`,
      res.status,
      err?.code,
      err?.error_subcode,
    );
  }
  return data;
}

export interface InstagramProfile {
  name?: string;
  username?: string;
  profile_pic?: string;
}

/** Fetch the customer's public profile by IGSID. Requires prior consent
 *  (they must have messaged the business first) — Meta returns a 400
 *  otherwise, which callers should treat as "no profile available". */
export async function fetchInstagramProfile(args: {
  igsid: string;
  pageAccessToken: string;
}): Promise<InstagramProfile> {
  const data = await graphFetch(
    `/${args.igsid}?fields=name,username,profile_pic`,
    args.pageAccessToken,
  );
  return data as InstagramProfile;
}

export type InstagramOutboundAttachmentType = 'image' | 'video' | 'audio' | 'file';

export interface SendTextMessageArgs {
  igsid: string;
  pageAccessToken: string;
  text: string;
  replyToMid?: string;
}

export interface SendAttachmentMessageArgs {
  igsid: string;
  pageAccessToken: string;
  attachmentType: InstagramOutboundAttachmentType;
  mediaUrl: string;
  replyToMid?: string;
}

export interface SendMessageResult {
  recipientId: string;
  messageId: string;
}

function parseSendResult(data: unknown): SendMessageResult {
  const d = data as { recipient_id?: string; message_id?: string };
  return { recipientId: d.recipient_id ?? '', messageId: d.message_id ?? '' };
}

export async function sendInstagramTextMessage(
  args: SendTextMessageArgs,
): Promise<SendMessageResult> {
  const body: Record<string, unknown> = {
    recipient: { id: args.igsid },
    message: { text: args.text },
  };
  if (args.replyToMid) body.reply_to = { mid: args.replyToMid };
  const data = await graphFetch('/me/messages', args.pageAccessToken, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return parseSendResult(data);
}

export async function sendInstagramAttachmentMessage(
  args: SendAttachmentMessageArgs,
): Promise<SendMessageResult> {
  const body: Record<string, unknown> = {
    recipient: { id: args.igsid },
    message: {
      attachment: { type: args.attachmentType, payload: { url: args.mediaUrl } },
    },
  };
  if (args.replyToMid) body.reply_to = { mid: args.replyToMid };
  const data = await graphFetch('/me/messages', args.pageAccessToken, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return parseSendResult(data);
}

/** Marks the customer's most recent message as read. Best-effort UX —
 *  callers should not fail the surrounding operation if this throws. */
export async function markInstagramSeen(args: {
  igsid: string;
  pageAccessToken: string;
}): Promise<void> {
  await graphFetch('/me/messages', args.pageAccessToken, {
    method: 'POST',
    body: JSON.stringify({ recipient: { id: args.igsid }, sender_action: 'mark_seen' }),
  });
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/lib/instagram/graph-api.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/instagram/graph-api.ts src/lib/instagram/graph-api.test.ts
git commit -m "feat(instagram): add Instagram Graph API client"
```

---

### Task 5: Media mirror helper

**Files:**
- Create: `src/lib/instagram/mirror-media.ts`
- Test: `src/lib/instagram/mirror-media.test.ts`

**Interfaces:**
- Consumes: `buildMediaPath`, `MEDIA_MAX_BYTES` from `@/lib/storage/upload-media`.
- Produces: `mirrorInstagramMedia({storage, accountId, sourceUrl, stableId, fallbackExtension, downloadFn?})`, `MirrorStorage` type, `MIRROR_BUCKET`, `MIRROR_FOLDER` — consumed by Task 7 (webhook route, for both inbound attachments and profile pictures).

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it, vi } from 'vitest';
import { mirrorInstagramMedia } from './mirror-media';

function fakeStorage(uploadError: { message: string } | null = null) {
  return {
    from: () => ({
      upload: vi.fn().mockResolvedValue({ error: uploadError }),
      getPublicUrl: () => ({ data: { publicUrl: 'https://example.com/mirrored.jpg' } }),
    }),
  };
}

describe('mirrorInstagramMedia', () => {
  it('downloads and uploads the file, returning the public URL', async () => {
    const download = vi.fn().mockResolvedValue({
      buffer: Buffer.from('fake-bytes'),
      contentType: 'image/jpeg',
    });
    const url = await mirrorInstagramMedia({
      storage: fakeStorage(),
      accountId: 'acc-1',
      sourceUrl: 'https://cdn.example/original.jpg',
      stableId: 'mid-1-image',
      fallbackExtension: 'jpg',
      downloadFn: download,
    });
    expect(url).toBe('https://example.com/mirrored.jpg');
    expect(download).toHaveBeenCalledWith('https://cdn.example/original.jpg');
  });

  it('returns null when the download throws', async () => {
    const download = vi.fn().mockRejectedValue(new Error('network error'));
    const url = await mirrorInstagramMedia({
      storage: fakeStorage(),
      accountId: 'acc-1',
      sourceUrl: 'https://cdn.example/original.jpg',
      stableId: 'mid-1-image',
      fallbackExtension: 'jpg',
      downloadFn: download,
    });
    expect(url).toBeNull();
  });

  it('returns null when the storage upload fails', async () => {
    const download = vi.fn().mockResolvedValue({
      buffer: Buffer.from('fake-bytes'),
      contentType: 'image/jpeg',
    });
    const url = await mirrorInstagramMedia({
      storage: fakeStorage({ message: 'mime rejected' }),
      accountId: 'acc-1',
      sourceUrl: 'https://cdn.example/original.jpg',
      stableId: 'mid-1-image',
      fallbackExtension: 'jpg',
      downloadFn: download,
    });
    expect(url).toBeNull();
  });

  it('returns null for a file over the size limit', async () => {
    const oversized = Buffer.alloc(17 * 1024 * 1024);
    const download = vi.fn().mockResolvedValue({ buffer: oversized, contentType: 'video/mp4' });
    const url = await mirrorInstagramMedia({
      storage: fakeStorage(),
      accountId: 'acc-1',
      sourceUrl: 'https://cdn.example/original.mp4',
      stableId: 'mid-1-video',
      fallbackExtension: 'mp4',
      downloadFn: download,
    });
    expect(url).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/instagram/mirror-media.test.ts`
Expected: FAIL — `./mirror-media` has no exports yet.

- [ ] **Step 3: Write the implementation**

```typescript
import { buildMediaPath, MEDIA_MAX_BYTES } from '@/lib/storage/upload-media';

export interface MirrorStorage {
  from(bucket: string): {
    upload(
      path: string,
      body: Uint8Array | Buffer,
      options: { contentType: string; cacheControl: string; upsert: boolean },
    ): Promise<{ error: { message: string } | null }>;
    getPublicUrl(path: string): { data: { publicUrl: string } };
  };
}

export const MIRROR_BUCKET = 'chat-media';
export const MIRROR_FOLDER = 'instagram-inbound';

async function defaultDownload(url: string): Promise<{ buffer: Buffer; contentType: string | null }> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download ${url}: ${res.status}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  return { buffer: Buffer.from(arrayBuffer), contentType: res.headers.get('content-type') };
}

function extensionFor(contentType: string | null, fallback: string): string {
  if (!contentType) return fallback;
  const map: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'video/mp4': 'mp4',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'application/pdf': 'pdf',
  };
  return map[contentType.split(';')[0].trim()] ?? fallback;
}

/** Mirrors any inbound Instagram media URL (attachments or a profile
 *  picture) into the durable `chat-media` bucket. Instagram's CDN URLs
 *  are short-lived, so the DB should never store them directly.
 *  Best-effort: returns null on any failure so the caller can fall back
 *  to the (still-valid-for-now) original URL rather than fail the
 *  surrounding webhook/profile-fetch. */
export async function mirrorInstagramMedia(args: {
  storage: MirrorStorage;
  accountId: string;
  sourceUrl: string;
  /** Stable id to key the object path on — the message id for an
   *  attachment, the igsid for a profile picture — so repeated mirrors
   *  of the same thing overwrite instead of accumulating. */
  stableId: string;
  fallbackExtension: string;
  downloadFn?: typeof defaultDownload;
}): Promise<string | null> {
  const { storage, accountId, sourceUrl, stableId, fallbackExtension, downloadFn = defaultDownload } = args;
  try {
    const { buffer, contentType } = await downloadFn(sourceUrl);
    if (buffer.byteLength > MEDIA_MAX_BYTES) {
      console.warn(`[instagram mirror-media] skipping ${stableId}: ${buffer.byteLength} bytes over limit`);
      return null;
    }
    const ext = extensionFor(contentType, fallbackExtension);
    const uploadType = contentType?.split(';')[0].trim() ?? 'application/octet-stream';
    const path = buildMediaPath(accountId, `${stableId}.${ext}`, null, MIRROR_FOLDER);
    const { error } = await storage.from(MIRROR_BUCKET).upload(path, buffer, {
      contentType: uploadType,
      cacheControl: '3600',
      upsert: true,
    });
    if (error) {
      console.warn(`[instagram mirror-media] upload failed for ${stableId}:`, error.message);
      return null;
    }
    const {
      data: { publicUrl },
    } = storage.from(MIRROR_BUCKET).getPublicUrl(path);
    return publicUrl || null;
  } catch (err) {
    console.warn(`[instagram mirror-media] could not mirror ${stableId}:`, err instanceof Error ? err.message : err);
    return null;
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/lib/instagram/mirror-media.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/instagram/mirror-media.ts src/lib/instagram/mirror-media.test.ts
git commit -m "feat(instagram): add inbound media/profile-picture mirroring"
```

---

### Task 6: Send-message core

**Files:**
- Create: `src/lib/instagram/send-message.ts`
- Test: `src/lib/instagram/send-message.test.ts`

**Interfaces:**
- Consumes: `sendInstagramTextMessage`, `sendInstagramAttachmentMessage`, `InstagramOutboundAttachmentType` from `./graph-api` (Task 4); `isMessagingWindowOpen` from `./messaging-window` (Task 3); `decrypt` from `@/lib/whatsapp/encryption`.
- Produces: `InstagramSendError` (has `.status: number`), `validateSendInstagramMessageParams({contentType, contentText?, mediaUrl?})`, `sendInstagramMessage(supabase, accountId, {conversationId, contentType, contentText?, mediaUrl?, replyToMessageId?})` returning `{messageId, igMessageId}` — consumed by Task 8 (send route).

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it, vi } from 'vitest';
import {
  InstagramSendError,
  sendInstagramMessage,
  validateSendInstagramMessageParams,
} from './send-message';
import * as graphApi from './graph-api';
import { encrypt } from '@/lib/whatsapp/encryption';

vi.mock('./graph-api', async () => {
  const actual = await vi.importActual<typeof graphApi>('./graph-api');
  return {
    ...actual,
    sendInstagramTextMessage: vi.fn(),
    sendInstagramAttachmentMessage: vi.fn(),
  };
});

process.env.ENCRYPTION_KEY = 'a'.repeat(64);

function thenable(result: { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  builder.select = chain;
  builder.eq = chain;
  builder.insert = chain;
  builder.update = chain;
  builder.maybeSingle = async () => result;
  builder.single = async () => result;
  builder.then = (resolve: (v: typeof result) => unknown) => resolve(result);
  return builder;
}

describe('validateSendInstagramMessageParams', () => {
  it('requires non-empty text for a text message', () => {
    expect(() => validateSendInstagramMessageParams({ contentType: 'text', contentText: '' })).toThrow(
      InstagramSendError,
    );
  });

  it('requires a media url for an attachment message', () => {
    expect(() => validateSendInstagramMessageParams({ contentType: 'image' })).toThrow(InstagramSendError);
  });

  it('accepts a valid text message', () => {
    expect(() =>
      validateSendInstagramMessageParams({ contentType: 'text', contentText: 'Hi' }),
    ).not.toThrow();
  });
});

describe('sendInstagramMessage', () => {
  it('rejects when the 24h messaging window is closed', async () => {
    const supabase = {
      from: (table: string) => {
        if (table === 'instagram_conversations') {
          return thenable({
            data: {
              id: 'conv-1',
              account_id: 'acc-1',
              contact_id: 'contact-1',
              last_customer_message_at: '2000-01-01T00:00:00.000Z',
              instagram_contacts: { igsid: 'igsid-1' },
            },
            error: null,
          });
        }
        throw new Error(`unexpected table ${table}`);
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    await expect(
      sendInstagramMessage(supabase, 'acc-1', {
        conversationId: 'conv-1',
        contentType: 'text',
        contentText: 'Hi',
      }),
    ).rejects.toThrow('janela de 24h');
  });

  it('sends a text message and persists it when the window is open', async () => {
    const now = new Date().toISOString();
    const inserted = { id: 'msg-1' };
    const supabase = {
      from: (table: string) => {
        if (table === 'instagram_conversations') {
          return thenable({
            data: {
              id: 'conv-1',
              account_id: 'acc-1',
              contact_id: 'contact-1',
              last_customer_message_at: now,
              instagram_contacts: { igsid: 'igsid-1' },
            },
            error: null,
          });
        }
        if (table === 'instagram_config') {
          return thenable({ data: { page_access_token: encrypt('page-token') }, error: null });
        }
        if (table === 'instagram_messages') {
          return thenable({ data: inserted, error: null });
        }
        throw new Error(`unexpected table ${table}`);
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    vi.mocked(graphApi.sendInstagramTextMessage).mockResolvedValue({
      recipientId: 'igsid-1',
      messageId: 'ig-mid-1',
    });

    const result = await sendInstagramMessage(supabase, 'acc-1', {
      conversationId: 'conv-1',
      contentType: 'text',
      contentText: 'Hello there',
    });

    expect(result).toEqual({ messageId: 'msg-1', igMessageId: 'ig-mid-1' });
    expect(graphApi.sendInstagramTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({ igsid: 'igsid-1', text: 'Hello there' }),
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/instagram/send-message.test.ts`
Expected: FAIL — `./send-message` has no exports yet.

- [ ] **Step 3: Write the implementation**

```typescript
import type { SupabaseClient } from '@supabase/supabase-js';
import { decrypt } from '@/lib/whatsapp/encryption';
import {
  sendInstagramAttachmentMessage,
  sendInstagramTextMessage,
  type InstagramOutboundAttachmentType,
} from './graph-api';
import { isMessagingWindowOpen } from './messaging-window';

export class InstagramSendError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'InstagramSendError';
  }
}

export interface SendInstagramMessageParams {
  conversationId: string;
  contentType: 'text' | InstagramOutboundAttachmentType;
  contentText?: string;
  mediaUrl?: string;
  replyToMessageId?: string;
}

export interface SendInstagramMessageResult {
  messageId: string;
  igMessageId: string;
}

export function validateSendInstagramMessageParams(params: {
  contentType: string;
  contentText?: string;
  mediaUrl?: string;
}) {
  if (params.contentType === 'text') {
    if (!params.contentText || !params.contentText.trim()) {
      throw new InstagramSendError('O texto da mensagem é obrigatório', 400);
    }
    if (params.contentText.length > 1000) {
      throw new InstagramSendError('O texto deve ter no máximo 1000 caracteres', 400);
    }
    return;
  }
  if (!params.mediaUrl) {
    throw new InstagramSendError('A URL da mídia é obrigatória', 400);
  }
}

export async function sendInstagramMessage(
  supabase: SupabaseClient,
  accountId: string,
  params: SendInstagramMessageParams,
): Promise<SendInstagramMessageResult> {
  validateSendInstagramMessageParams(params);

  const { data: conversation, error: convError } = await supabase
    .from('instagram_conversations')
    .select('id, account_id, contact_id, last_customer_message_at, instagram_contacts(igsid)')
    .eq('id', params.conversationId)
    .eq('account_id', accountId)
    .maybeSingle();

  if (convError || !conversation) {
    throw new InstagramSendError('Conversa não encontrada', 404);
  }

  if (!isMessagingWindowOpen(conversation.last_customer_message_at)) {
    throw new InstagramSendError(
      'A janela de 24h para responder esta conversa expirou. Aguarde uma nova mensagem do cliente.',
      409,
    );
  }

  const { data: config, error: configError } = await supabase
    .from('instagram_config')
    .select('page_access_token')
    .eq('account_id', accountId)
    .maybeSingle();

  if (configError || !config) {
    throw new InstagramSendError('Instagram não está conectado nesta conta', 409);
  }

  const igsid = (
    conversation as unknown as { instagram_contacts: { igsid: string } }
  ).instagram_contacts.igsid;
  const pageAccessToken = decrypt(config.page_access_token);

  let replyToMid: string | undefined;
  if (params.replyToMessageId) {
    const { data: replyTarget } = await supabase
      .from('instagram_messages')
      .select('ig_message_id')
      .eq('id', params.replyToMessageId)
      .eq('conversation_id', params.conversationId)
      .maybeSingle();
    replyToMid = replyTarget?.ig_message_id ?? undefined;
  }

  let sendResult;
  try {
    sendResult =
      params.contentType === 'text'
        ? await sendInstagramTextMessage({
            igsid,
            pageAccessToken,
            text: params.contentText!.trim(),
            replyToMid,
          })
        : await sendInstagramAttachmentMessage({
            igsid,
            pageAccessToken,
            attachmentType: params.contentType,
            mediaUrl: params.mediaUrl!,
            replyToMid,
          });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Falha ao enviar mensagem ao Instagram';
    await supabase.from('instagram_messages').insert({
      conversation_id: params.conversationId,
      sender_type: 'agent',
      content_type: params.contentType,
      content_text: params.contentText ?? null,
      media_url: params.mediaUrl ?? null,
      status: 'failed',
      error_message: message,
      reply_to_message_id: params.replyToMessageId ?? null,
    });
    throw new InstagramSendError(message, 502);
  }

  const { data: inserted, error: insertError } = await supabase
    .from('instagram_messages')
    .insert({
      conversation_id: params.conversationId,
      sender_type: 'agent',
      content_type: params.contentType,
      content_text: params.contentText ?? null,
      media_url: params.mediaUrl ?? null,
      ig_message_id: sendResult.messageId,
      status: 'sent',
      reply_to_message_id: params.replyToMessageId ?? null,
    })
    .select('id')
    .single();

  if (insertError || !inserted) {
    throw new InstagramSendError('Mensagem enviada, mas não foi possível salvá-la', 500);
  }

  await supabase
    .from('instagram_conversations')
    .update({
      last_message_text: params.contentType === 'text' ? params.contentText : `[${params.contentType}]`,
      last_message_at: new Date().toISOString(),
    })
    .eq('id', params.conversationId);

  return { messageId: inserted.id, igMessageId: sendResult.messageId };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/lib/instagram/send-message.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/instagram/send-message.ts src/lib/instagram/send-message.test.ts
git commit -m "feat(instagram): add outbound send core"
```

---

### Task 7: Webhook route

**Files:**
- Create: `src/app/api/instagram/webhook/route.ts`
- Test: `src/app/api/instagram/webhook/route.test.ts`

**Interfaces:**
- Consumes: `decrypt` from `@/lib/whatsapp/encryption`; `verifyMetaWebhookSignature` from `@/lib/whatsapp/webhook-signature`; `fetchInstagramProfile`, `markInstagramSeen` from `@/lib/instagram/graph-api` (Task 4); `mirrorInstagramMedia` from `@/lib/instagram/mirror-media` (Task 5).
- Produces: `GET`, `POST` route handlers.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';

vi.mock('next/server', async () => {
  const actual = await vi.importActual<typeof import('next/server')>('next/server');
  return {
    ...actual,
    after: (cb: () => Promise<void>) => cb(),
  };
});

process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.META_APP_SECRET = 'test-app-secret';
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';

import { encrypt } from '@/lib/whatsapp/encryption';

const tables: Record<string, unknown[]> = {
  instagram_config: [],
  instagram_contacts: [],
  instagram_conversations: [],
  instagram_messages: [],
};

function resetTables() {
  tables.instagram_config = [
    {
      account_id: 'acc-1',
      ig_user_id: 'ig-user-1',
      page_access_token: encrypt('page-token'),
      verify_token: encrypt('verify-me'),
    },
  ];
  tables.instagram_contacts = [];
  tables.instagram_conversations = [];
  tables.instagram_messages = [];
}

// Minimal in-memory fake covering exactly the query shapes the route
// uses: select/eq/maybeSingle, insert/select/single, upsert/select.
function fakeAdminClient() {
  return {
    from(table: string) {
      const rows = () => tables[table];
      const builder = {
        _filters: [] as Array<[string, unknown]>,
        select() {
          return builder;
        },
        eq(col: string, val: unknown) {
          builder._filters.push([col, val]);
          return builder;
        },
        maybeSingle: async () => {
          const match = rows().find((r) =>
            builder._filters.every(([col, val]) => (r as Record<string, unknown>)[col] === val),
          );
          return { data: match ?? null, error: null };
        },
        insert(row: Record<string, unknown>) {
          const withId = { id: crypto.randomUUID(), ...row };
          rows().push(withId);
          return {
            select: () => ({
              single: async () => ({ data: withId, error: null }),
            }),
          };
        },
        upsert(row: Record<string, unknown>, opts: { onConflict: string; ignoreDuplicates?: boolean }) {
          const conflictCols = opts.onConflict.split(',');
          const existing = rows().find((r) =>
            conflictCols.every(
              (col) => (r as Record<string, unknown>)[col] === (row as Record<string, unknown>)[col],
            ),
          );
          if (existing && opts.ignoreDuplicates) {
            return { select: () => Promise.resolve({ data: [], error: null }) };
          }
          const withId = { id: crypto.randomUUID(), ...row };
          rows().push(withId);
          return { select: () => Promise.resolve({ data: [withId], error: null }) };
        },
        update(patch: Record<string, unknown>) {
          return {
            eq: (col: string, val: unknown) => {
              const match = rows().find((r) => (r as Record<string, unknown>)[col] === val);
              if (match) Object.assign(match, patch);
              return Promise.resolve({ data: null, error: null });
            },
          };
        },
      };
      return builder;
    },
    storage: {
      from: () => ({
        upload: async () => ({ error: null }),
        getPublicUrl: () => ({ data: { publicUrl: 'https://example.com/mirrored.jpg' } }),
      }),
    },
  };
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => fakeAdminClient(),
}));

vi.mock('@/lib/instagram/graph-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/instagram/graph-api')>(
    '@/lib/instagram/graph-api',
  );
  return {
    ...actual,
    fetchInstagramProfile: vi.fn().mockResolvedValue({ name: 'Jane', username: 'jane' }),
    markInstagramSeen: vi.fn().mockResolvedValue(undefined),
  };
});

import { GET, POST } from './route';

function signedRequest(body: unknown) {
  const raw = JSON.stringify(body);
  const signature =
    'sha256=' + crypto.createHmac('sha256', 'test-app-secret').update(raw).digest('hex');
  return new Request('http://localhost/api/instagram/webhook', {
    method: 'POST',
    body: raw,
    headers: { 'x-hub-signature-256': signature },
  });
}

beforeEach(() => {
  resetTables();
});

describe('GET /api/instagram/webhook', () => {
  it('returns the challenge when the verify token matches', async () => {
    const url =
      'http://localhost/api/instagram/webhook?hub.mode=subscribe&hub.challenge=123&hub.verify_token=verify-me';
    const res = await GET(new Request(url));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('123');
  });

  it('rejects an unmatched verify token', async () => {
    const url =
      'http://localhost/api/instagram/webhook?hub.mode=subscribe&hub.challenge=123&hub.verify_token=wrong';
    const res = await GET(new Request(url));
    expect(res.status).toBe(403);
  });

  it('rejects a request missing parameters', async () => {
    const res = await GET(new Request('http://localhost/api/instagram/webhook'));
    expect(res.status).toBe(400);
  });
});

describe('POST /api/instagram/webhook', () => {
  it('rejects a request with an invalid signature', async () => {
    const res = await POST(
      new Request('http://localhost/api/instagram/webhook', {
        method: 'POST',
        body: JSON.stringify({ object: 'instagram', entry: [] }),
        headers: { 'x-hub-signature-256': 'sha256=wrong' },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('stores an inbound text message, creating the contact and conversation', async () => {
    const res = await POST(
      signedRequest({
        object: 'instagram',
        entry: [
          {
            id: 'ig-user-1',
            time: 1700000000000,
            messaging: [
              {
                sender: { id: 'igsid-1' },
                recipient: { id: 'ig-user-1' },
                timestamp: 1700000000000,
                message: { mid: 'mid-1', text: 'Olá!' },
              },
            ],
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    expect(tables.instagram_contacts).toHaveLength(1);
    expect(tables.instagram_conversations).toHaveLength(1);
    expect(tables.instagram_messages).toHaveLength(1);
    expect(tables.instagram_messages[0]).toMatchObject({
      content_text: 'Olá!',
      content_type: 'text',
      sender_type: 'customer',
    });
  });

  it('is idempotent for a redelivered message id', async () => {
    const payload = {
      object: 'instagram',
      entry: [
        {
          id: 'ig-user-1',
          time: 1700000000000,
          messaging: [
            {
              sender: { id: 'igsid-1' },
              recipient: { id: 'ig-user-1' },
              timestamp: 1700000000000,
              message: { mid: 'mid-1', text: 'Olá!' },
            },
          ],
        },
      ],
    };
    await POST(signedRequest(payload));
    await POST(signedRequest(payload));
    expect(tables.instagram_messages).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/app/api/instagram/webhook/route.test.ts`
Expected: FAIL — `./route` has no exports yet.

- [ ] **Step 3: Write the implementation**

```typescript
import { NextResponse, after } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { decrypt } from '@/lib/whatsapp/encryption';
import { verifyMetaWebhookSignature } from '@/lib/whatsapp/webhook-signature';
import { fetchInstagramProfile, markInstagramSeen } from '@/lib/instagram/graph-api';
import { mirrorInstagramMedia } from '@/lib/instagram/mirror-media';

export const maxDuration = 60;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null;
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );
  }
  return _adminClient;
}

interface IgAttachment {
  type: 'image' | 'video' | 'audio' | 'file' | 'share' | 'story_mention' | 'ig_reel' | 'reel';
  payload?: { url?: string };
}

interface IgMessagingEvent {
  sender: { id: string };
  recipient: { id: string };
  timestamp: number;
  message?: {
    mid: string;
    text?: string;
    attachments?: IgAttachment[];
    is_echo?: boolean;
    is_deleted?: boolean;
    is_unsupported?: boolean;
    reply_to?: { mid?: string; story?: unknown };
  };
}

interface IgWebhookEntry {
  id: string;
  time: number;
  messaging?: IgMessagingEvent[];
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get('hub.mode');
  const challenge = searchParams.get('hub.challenge');
  const verifyToken = searchParams.get('hub.verify_token');

  if (mode !== 'subscribe' || !challenge || !verifyToken) {
    return NextResponse.json({ error: 'Parâmetros de verificação ausentes' }, { status: 400 });
  }

  const { data: configs, error } = await supabaseAdmin()
    .from('instagram_config')
    .select('id, verify_token');

  if (error || !configs) {
    return NextResponse.json({ error: 'Falha na verificação' }, { status: 403 });
  }

  const matched = configs.some((c: { verify_token: string }) => {
    try {
      return decrypt(c.verify_token) === verifyToken;
    } catch {
      return false;
    }
  });

  if (!matched) {
    return NextResponse.json({ error: 'Verify token mismatch' }, { status: 403 });
  }

  return new Response(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } });
}

export async function POST(request: Request) {
  const rawBody = await request.text();
  const signature = request.headers.get('x-hub-signature-256');

  if (!verifyMetaWebhookSignature(rawBody, signature)) {
    console.warn('[instagram webhook] rejected request with invalid signature');
    return NextResponse.json({ error: 'Assinatura inválida' }, { status: 401 });
  }

  let body: { object?: string; entry?: IgWebhookEntry[] };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }

  after(async () => {
    try {
      await processWebhook(body);
    } catch (err) {
      console.error('[instagram webhook] processing error:', err);
    }
  });

  return NextResponse.json({ status: 'received' }, { status: 200 });
}

async function processWebhook(body: { object?: string; entry?: IgWebhookEntry[] }) {
  if (body.object !== 'instagram' || !body.entry) return;

  for (const entry of body.entry) {
    if (!entry.messaging) continue;
    for (const event of entry.messaging) {
      await processMessagingEvent(entry.id, event);
    }
  }
}

async function processMessagingEvent(igUserId: string, event: IgMessagingEvent) {
  // Echoes are our own outbound sends mirrored back — already persisted
  // by the send route. Deleted / unsupported events carry no content
  // worth showing; skip both so the inbox never renders empty bubbles.
  if (!event.message || event.message.is_echo || event.message.is_deleted) return;

  const { data: config, error: configError } = await supabaseAdmin()
    .from('instagram_config')
    .select('account_id, page_access_token')
    .eq('ig_user_id', igUserId)
    .maybeSingle();

  if (configError || !config) {
    console.error('[instagram webhook] no config found for ig_user_id:', igUserId);
    return;
  }

  const pageAccessToken = decrypt(config.page_access_token);
  const igsid = event.sender.id;

  const contact = await findOrCreateContact(config.account_id, igsid, pageAccessToken);
  if (!contact) return;

  const conversation = await findOrCreateConversation(config.account_id, contact.id);
  if (!conversation) return;

  const { contentType, contentText, mediaUrl } = await parseMessageContent(
    event.message,
    config.account_id,
  );

  let replyToInternalId: string | null = null;
  if (event.message.reply_to?.mid) {
    const { data: parent } = await supabaseAdmin()
      .from('instagram_messages')
      .select('id')
      .eq('ig_message_id', event.message.reply_to.mid)
      .eq('conversation_id', conversation.id)
      .maybeSingle();
    replyToInternalId = parent?.id ?? null;
  }

  const { data: insertedRows, error: insertError } = await supabaseAdmin()
    .from('instagram_messages')
    .upsert(
      {
        conversation_id: conversation.id,
        sender_type: 'customer',
        content_type: contentType,
        content_text: contentText,
        media_url: mediaUrl,
        ig_message_id: event.message.mid,
        status: 'delivered',
        reply_to_message_id: replyToInternalId,
        created_at: new Date(event.timestamp).toISOString(),
      },
      { onConflict: 'conversation_id,ig_message_id', ignoreDuplicates: true },
    )
    .select('id');

  if (insertError) {
    console.error('[instagram webhook] insert failed:', insertError);
    return;
  }
  if (!insertedRows || insertedRows.length === 0) {
    // Replayed delivery — Meta retries on a slow ack. Idempotent no-op.
    return;
  }

  const nowIso = new Date().toISOString();
  await supabaseAdmin()
    .from('instagram_conversations')
    .update({
      last_message_text: contentText ?? `[${contentType}]`,
      last_message_at: nowIso,
      last_customer_message_at: nowIso,
      unread_count: (conversation.unread_count ?? 0) + 1,
    })
    .eq('id', conversation.id);

  // Best-effort read receipt. Never let this fail the webhook.
  try {
    await markInstagramSeen({ igsid, pageAccessToken });
  } catch (err) {
    console.warn('[instagram webhook] mark_seen failed:', err instanceof Error ? err.message : err);
  }
}

async function parseMessageContent(
  message: NonNullable<IgMessagingEvent['message']>,
  accountId: string,
): Promise<{ contentType: string; contentText: string | null; mediaUrl: string | null }> {
  if (message.is_unsupported) {
    return { contentType: 'unsupported', contentText: '[Mensagem não compatível]', mediaUrl: null };
  }

  const attachment = message.attachments?.[0];
  if (attachment) {
    const typeMap: Record<string, string> = {
      image: 'image',
      video: 'video',
      audio: 'audio',
      file: 'file',
      share: 'share',
      story_mention: 'story_mention',
      ig_reel: 'share',
      reel: 'share',
    };
    const contentType = typeMap[attachment.type] ?? 'unsupported';
    let mediaUrl: string | null = attachment.payload?.url ?? null;
    if (mediaUrl) {
      const mirrored = await mirrorInstagramMedia({
        storage: supabaseAdmin().storage,
        accountId,
        sourceUrl: mediaUrl,
        stableId: `${message.mid}-${attachment.type}`,
        fallbackExtension: attachment.type === 'video' ? 'mp4' : attachment.type === 'audio' ? 'mp3' : 'jpg',
      });
      if (mirrored) mediaUrl = mirrored;
    }
    return { contentType, contentText: message.text ?? null, mediaUrl };
  }

  return { contentType: 'text', contentText: message.text ?? null, mediaUrl: null };
}

async function findOrCreateContact(accountId: string, igsid: string, pageAccessToken: string) {
  const { data: existing, error: findError } = await supabaseAdmin()
    .from('instagram_contacts')
    .select('*')
    .eq('account_id', accountId)
    .eq('igsid', igsid)
    .maybeSingle();

  if (findError) {
    console.error('[instagram webhook] contact lookup failed:', findError);
    return null;
  }
  if (existing) return existing;

  // First time we see this person — fetch their public profile.
  // Best-effort: Meta can refuse this (no consent yet) without
  // blocking the message itself from being stored.
  let name: string | null = null;
  let username: string | null = null;
  let profilePicUrl: string | null = null;
  try {
    const profile = await fetchInstagramProfile({ igsid, pageAccessToken });
    name = profile.name ?? null;
    username = profile.username ?? null;
    if (profile.profile_pic) {
      profilePicUrl = await mirrorInstagramMedia({
        storage: supabaseAdmin().storage,
        accountId,
        sourceUrl: profile.profile_pic,
        stableId: `profile-${igsid}`,
        fallbackExtension: 'jpg',
      });
    }
  } catch (err) {
    console.warn('[instagram webhook] profile fetch failed:', err instanceof Error ? err.message : err);
  }

  const { data: created, error: createError } = await supabaseAdmin()
    .from('instagram_contacts')
    .insert({ account_id: accountId, igsid, name, username, profile_pic_url: profilePicUrl })
    .select()
    .single();

  if (createError) {
    // Lost a race with a concurrent delivery for the same igsid.
    const { data: raced } = await supabaseAdmin()
      .from('instagram_contacts')
      .select('*')
      .eq('account_id', accountId)
      .eq('igsid', igsid)
      .maybeSingle();
    if (raced) return raced;
    console.error('[instagram webhook] contact creation failed:', createError);
    return null;
  }

  return created;
}

async function findOrCreateConversation(accountId: string, contactId: string) {
  const { data: existing, error: findError } = await supabaseAdmin()
    .from('instagram_conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .maybeSingle();

  if (findError) {
    console.error('[instagram webhook] conversation lookup failed:', findError);
    return null;
  }
  if (existing) return existing;

  const { data: created, error: createError } = await supabaseAdmin()
    .from('instagram_conversations')
    .insert({ account_id: accountId, contact_id: contactId })
    .select()
    .single();

  if (createError) {
    const { data: raced } = await supabaseAdmin()
      .from('instagram_conversations')
      .select('*')
      .eq('account_id', accountId)
      .eq('contact_id', contactId)
      .maybeSingle();
    if (raced) return raced;
    console.error('[instagram webhook] conversation creation failed:', createError);
    return null;
  }

  return created;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/app/api/instagram/webhook/route.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/app/api/instagram/webhook/route.ts src/app/api/instagram/webhook/route.test.ts
git commit -m "feat(instagram): add inbound webhook route"
```

---

### Task 8: Dashboard send route

**Files:**
- Create: `src/app/api/instagram/send/route.ts`
- Test: `src/app/api/instagram/send/route.test.ts`

**Interfaces:**
- Consumes: `requireRole`, `toErrorResponse` from `@/lib/auth/account`; `checkRateLimit`, `rateLimitResponse`, `RATE_LIMITS` from `@/lib/rate-limit`; `sendInstagramMessage`, `InstagramSendError` from `@/lib/instagram/send-message` (Task 6).
- Produces: `POST` route handler — consumed by Task 14 (composer, via `fetch('/api/instagram/send')`).

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it, vi, beforeEach } from 'vitest';

const requireRoleMock = vi.fn();
vi.mock('@/lib/auth/account', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/account')>('@/lib/auth/account');
  return { ...actual, requireRole: (...args: unknown[]) => requireRoleMock(...args) };
});

const sendInstagramMessageMock = vi.fn();
vi.mock('@/lib/instagram/send-message', async () => {
  const actual = await vi.importActual<typeof import('@/lib/instagram/send-message')>(
    '@/lib/instagram/send-message',
  );
  return { ...actual, sendInstagramMessage: (...args: unknown[]) => sendInstagramMessageMock(...args) };
});

import { POST } from './route';
import { InstagramSendError } from '@/lib/instagram/send-message';
import { __resetRateLimitForTests } from '@/lib/rate-limit';

beforeEach(() => {
  __resetRateLimitForTests();
  requireRoleMock.mockResolvedValue({ supabase: {}, accountId: 'acc-1', userId: 'user-1' });
});

describe('POST /api/instagram/send', () => {
  it('rejects a request missing required fields', async () => {
    const res = await POST(
      new Request('http://localhost/api/instagram/send', { method: 'POST', body: JSON.stringify({}) }),
    );
    expect(res.status).toBe(400);
  });

  it('returns the sent message id on success', async () => {
    sendInstagramMessageMock.mockResolvedValue({ messageId: 'msg-1', igMessageId: 'ig-mid-1' });
    const res = await POST(
      new Request('http://localhost/api/instagram/send', {
        method: 'POST',
        body: JSON.stringify({ conversation_id: 'conv-1', content_type: 'text', content_text: 'Hi' }),
      }),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ success: true, message_id: 'msg-1', ig_message_id: 'ig-mid-1' });
  });

  it('maps InstagramSendError to its status and message', async () => {
    sendInstagramMessageMock.mockRejectedValue(new InstagramSendError('janela fechada', 409));
    const res = await POST(
      new Request('http://localhost/api/instagram/send', {
        method: 'POST',
        body: JSON.stringify({ conversation_id: 'conv-1', content_type: 'text', content_text: 'Hi' }),
      }),
    );
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toBe('janela fechada');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/app/api/instagram/send/route.test.ts`
Expected: FAIL — `./route` has no exports yet.

- [ ] **Step 3: Write the implementation**

```typescript
import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { sendInstagramMessage, InstagramSendError } from '@/lib/instagram/send-message';

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent');

    const limit = checkRateLimit(`instagram-send:${userId}`, RATE_LIMITS.send);
    if (!limit.success) {
      return rateLimitResponse(limit);
    }

    const body = await request.json();
    const { conversation_id, content_type, content_text, media_url, reply_to_message_id } = body;

    if (!conversation_id || !content_type) {
      return NextResponse.json(
        { error: 'conversation_id e content_type são obrigatórios' },
        { status: 400 },
      );
    }

    try {
      const result = await sendInstagramMessage(supabase, accountId, {
        conversationId: conversation_id,
        contentType: content_type,
        contentText: content_text,
        mediaUrl: media_url,
        replyToMessageId: reply_to_message_id,
      });
      return NextResponse.json({
        success: true,
        message_id: result.messageId,
        ig_message_id: result.igMessageId,
      });
    } catch (err) {
      if (err instanceof InstagramSendError) {
        return NextResponse.json({ error: err.message }, { status: err.status });
      }
      throw err;
    }
  } catch (error) {
    console.error('Error in Instagram send POST:', error);
    return toErrorResponse(error);
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/app/api/instagram/send/route.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/app/api/instagram/send/route.ts src/app/api/instagram/send/route.test.ts
git commit -m "feat(instagram): add dashboard send route"
```

---

### Task 9: Config route

**Files:**
- Create: `src/app/api/instagram/config/route.ts`
- Test: `src/app/api/instagram/config/route.test.ts`

**Interfaces:**
- Consumes: `requireRole`, `toErrorResponse` from `@/lib/auth/account`; `encrypt`, `decrypt` from `@/lib/whatsapp/encryption`.
- Produces: `GET`, `POST`, `DELETE` route handlers. `POST` returns `{success: true, verify_token: string}` — consumed by Task 11 (settings panel, to display the webhook verify token to paste into the Meta App).

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it, vi, beforeEach } from 'vitest';

const requireRoleMock = vi.fn();
vi.mock('@/lib/auth/account', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/account')>('@/lib/auth/account');
  return { ...actual, requireRole: (...args: unknown[]) => requireRoleMock(...args) };
});

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ neq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }),
    }),
  }),
}));

process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';

import { POST } from './route';

function thenable(result: { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  builder.select = chain;
  builder.eq = chain;
  builder.insert = chain;
  builder.update = chain;
  builder.maybeSingle = async () => result;
  builder.then = (resolve: (v: typeof result) => unknown) => resolve(result);
  return builder;
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'ig-1' }) }));
  requireRoleMock.mockResolvedValue({
    supabase: { from: () => thenable({ data: null, error: null }) },
    accountId: 'acc-1',
    userId: 'user-1',
  });
});

describe('POST /api/instagram/config', () => {
  it('rejects a request missing required fields', async () => {
    const res = await POST(
      new Request('http://localhost/api/instagram/config', {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('rejects when the Graph API cannot verify the token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: { message: 'bad token' } }) }),
    );
    const res = await POST(
      new Request('http://localhost/api/instagram/config', {
        method: 'POST',
        body: JSON.stringify({ page_id: 'p1', ig_user_id: 'ig1', page_access_token: 'tok' }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('saves the config when verification succeeds', async () => {
    const res = await POST(
      new Request('http://localhost/api/instagram/config', {
        method: 'POST',
        body: JSON.stringify({ page_id: 'p1', ig_user_id: 'ig1', page_access_token: 'tok' }),
      }),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/app/api/instagram/config/route.test.ts`
Expected: FAIL — `./route` has no exports yet.

- [ ] **Step 3: Write the implementation**

```typescript
import { NextResponse } from 'next/server';
import { createClient as createAdminClient } from '@supabase/supabase-js';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { encrypt, decrypt } from '@/lib/whatsapp/encryption';
import crypto from 'node:crypto';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null;
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );
  }
  return _adminClient;
}

export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('viewer');
    const { data, error } = await supabase
      .from('instagram_config')
      .select('page_id, ig_user_id, ig_username, status, connected_at')
      .eq('account_id', accountId)
      .maybeSingle();

    if (error) {
      console.error('[instagram/config GET] fetch failed:', error);
      return NextResponse.json({ connected: false }, { status: 200 });
    }
    if (!data) {
      return NextResponse.json({ connected: false }, { status: 200 });
    }
    return NextResponse.json({ connected: data.status === 'connected', config: data });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('admin');
    const body = await request.json();
    const { page_id, ig_user_id, ig_username, page_access_token } = body;

    if (!page_id || !ig_user_id || !page_access_token) {
      return NextResponse.json(
        { error: 'page_id, ig_user_id e page_access_token são obrigatórios' },
        { status: 400 },
      );
    }

    // Verify the token actually works against this ig_user_id before
    // saving — catches a pasted Page token that doesn't have messaging
    // permission, or the wrong ig_user_id, up front rather than at the
    // first real webhook delivery.
    const verifyRes = await fetch(
      `https://graph.facebook.com/v21.0/${ig_user_id}?fields=id&access_token=${encodeURIComponent(page_access_token)}`,
    );
    if (!verifyRes.ok) {
      const errBody = await verifyRes.json().catch(() => ({}));
      return NextResponse.json(
        {
          error:
            errBody?.error?.message ??
            'Não foi possível verificar as credenciais com a Meta. Confira o ID da conta e o token.',
        },
        { status: 400 },
      );
    }

    // Reject if another account already claimed this ig_user_id —
    // mirrors the whatsapp_config phone_number_id check.
    const { data: claimed } = await supabaseAdmin()
      .from('instagram_config')
      .select('account_id')
      .eq('ig_user_id', ig_user_id)
      .neq('account_id', accountId)
      .maybeSingle();

    if (claimed) {
      return NextResponse.json(
        { error: 'Esta conta do Instagram já está vinculada a outra conta nesta instalação.' },
        { status: 409 },
      );
    }

    const { data: existing } = await supabase
      .from('instagram_config')
      .select('id, verify_token')
      .eq('account_id', accountId)
      .maybeSingle();

    const verifyToken = existing ? decrypt(existing.verify_token) : crypto.randomBytes(24).toString('hex');

    const row = {
      page_id,
      ig_user_id,
      ig_username: ig_username || null,
      page_access_token: encrypt(page_access_token),
      verify_token: encrypt(verifyToken),
      status: 'connected',
      connected_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    if (existing) {
      const { error } = await supabase.from('instagram_config').update(row).eq('account_id', accountId);
      if (error) {
        console.error('[instagram/config POST] update failed:', error);
        return NextResponse.json({ error: 'Não foi possível atualizar a configuração' }, { status: 500 });
      }
    } else {
      const { error } = await supabase.from('instagram_config').insert({ account_id: accountId, ...row });
      if (error) {
        console.error('[instagram/config POST] insert failed:', error);
        return NextResponse.json({ error: 'Não foi possível salvar a configuração' }, { status: 500 });
      }
    }

    return NextResponse.json({ success: true, verify_token: verifyToken });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE() {
  try {
    const { supabase, accountId } = await requireRole('admin');
    const { error } = await supabase.from('instagram_config').delete().eq('account_id', accountId);
    if (error) {
      console.error('[instagram/config DELETE] failed:', error);
      return NextResponse.json({ error: 'Não foi possível excluir a configuração' }, { status: 500 });
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/app/api/instagram/config/route.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/app/api/instagram/config/route.ts src/app/api/instagram/config/route.test.ts
git commit -m "feat(instagram): add config route"
```

---

### Task 10: i18n keys

**Files:**
- Modify: `messages/en.json`, `messages/pt.json`, `messages/ko.json`, `messages/es.json`

**Interfaces:**
- Produces: translation keys under `Settings.instagram.*`, `Inbox.channelTabs.*`, `Inbox.instagram.*` — consumed by Task 11 (settings panel) and Task 14 (message thread + composer).

- [ ] **Step 1: Add the keys to `messages/en.json`**

Open the file, find the top-level `"Settings": { ... }` object and add a new `"instagram"` key inside it (sibling to the existing `"whatsapp"` key):

```json
"instagram": {
  "title": "Instagram",
  "description": "Connect an Instagram Professional account linked to a Facebook Page to receive and reply to Direct Messages from the inbox.",
  "statusConnected": "Connected",
  "statusDisconnected": "Not connected",
  "pageId": "Facebook Page ID",
  "igUserId": "Instagram User ID",
  "igUsername": "Instagram username (optional)",
  "pageAccessToken": "Page access token",
  "tokenPlaceholderConnected": "Leave blank to keep the current token",
  "save": "Save configuration",
  "disconnect": "Disconnect",
  "loadError": "Could not load the Instagram configuration",
  "saveError": "Could not save the configuration",
  "saveSuccess": "Instagram configuration saved",
  "disconnectError": "Could not disconnect Instagram",
  "disconnectSuccess": "Instagram disconnected",
  "requiredFields": "Page ID, Instagram User ID and Page access token are required",
  "webhookSetupTitle": "Finish the webhook setup in your Meta App",
  "webhookUrlLabel": "Callback URL:",
  "verifyTokenLabel": "Verify token:"
}
```

Then find the top-level `"Inbox": { ... }` object and add two new sibling keys:

```json
"channelTabs": {
  "whatsapp": "WhatsApp",
  "instagram": "Instagram"
},
"instagram": {
  "loading": "Loading conversations…",
  "emptyList": "No Instagram conversations yet",
  "noContactName": "No name",
  "noMessages": "No messages yet",
  "selectConversation": "Select a conversation",
  "windowClosed": "The 24h window to reply has expired. Wait for a new message from the customer.",
  "windowClosedPlaceholder": "Waiting for a new message to reply…",
  "placeholder": "Type a message…",
  "attach": "Attach",
  "sendError": "Could not send the message",
  "fileTooLarge": "The file is too large",
  "attachment": "Attachment",
  "storyMention": "Story mention",
  "sharedPost": "Shared a post",
  "unsupported": "Unsupported message"
}
```

- [ ] **Step 2: Add the same keys, translated, to `messages/pt.json`**

Under `"Settings"`:

```json
"instagram": {
  "title": "Instagram",
  "description": "Conecte uma conta Instagram Profissional vinculada a uma Página do Facebook para receber e responder Direct na inbox.",
  "statusConnected": "Conectado",
  "statusDisconnected": "Não conectado",
  "pageId": "ID da Página do Facebook",
  "igUserId": "ID do usuário do Instagram",
  "igUsername": "Usuário do Instagram (opcional)",
  "pageAccessToken": "Token de acesso da Página",
  "tokenPlaceholderConnected": "Deixe em branco para manter o token atual",
  "save": "Salvar configuração",
  "disconnect": "Desconectar",
  "loadError": "Não foi possível carregar a configuração do Instagram",
  "saveError": "Não foi possível salvar a configuração",
  "saveSuccess": "Configuração do Instagram salva",
  "disconnectError": "Não foi possível desconectar o Instagram",
  "disconnectSuccess": "Instagram desconectado",
  "requiredFields": "ID da Página, ID do usuário do Instagram e token de acesso são obrigatórios",
  "webhookSetupTitle": "Finalize a configuração do webhook no seu Meta App",
  "webhookUrlLabel": "URL de callback:",
  "verifyTokenLabel": "Token de verificação:"
}
```

Under `"Inbox"`:

```json
"channelTabs": {
  "whatsapp": "WhatsApp",
  "instagram": "Instagram"
},
"instagram": {
  "loading": "Carregando conversas…",
  "emptyList": "Nenhuma conversa do Instagram ainda",
  "noContactName": "Sem nome",
  "noMessages": "Nenhuma mensagem ainda",
  "selectConversation": "Selecione uma conversa",
  "windowClosed": "A janela de 24h para responder expirou. Aguarde uma nova mensagem do cliente.",
  "windowClosedPlaceholder": "Aguardando uma nova mensagem para responder…",
  "placeholder": "Digite uma mensagem…",
  "attach": "Anexar",
  "sendError": "Não foi possível enviar a mensagem",
  "fileTooLarge": "O arquivo é grande demais",
  "attachment": "Anexo",
  "storyMention": "Menção em story",
  "sharedPost": "Compartilhou uma publicação",
  "unsupported": "Mensagem não compatível"
}
```

- [ ] **Step 3: Add the same keys, translated, to `messages/ko.json`**

Under `"Settings"`:

```json
"instagram": {
  "title": "인스타그램",
  "description": "페이스북 페이지에 연결된 인스타그램 프로페셔널 계정을 연결하면 받은편지함에서 다이렉트 메시지를 받고 답장할 수 있습니다.",
  "statusConnected": "연결됨",
  "statusDisconnected": "연결 안 됨",
  "pageId": "페이스북 페이지 ID",
  "igUserId": "인스타그램 사용자 ID",
  "igUsername": "인스타그램 사용자명 (선택)",
  "pageAccessToken": "페이지 액세스 토큰",
  "tokenPlaceholderConnected": "현재 토큰을 유지하려면 비워 두세요",
  "save": "설정 저장",
  "disconnect": "연결 해제",
  "loadError": "인스타그램 설정을 불러올 수 없습니다",
  "saveError": "설정을 저장할 수 없습니다",
  "saveSuccess": "인스타그램 설정이 저장되었습니다",
  "disconnectError": "인스타그램 연결을 해제할 수 없습니다",
  "disconnectSuccess": "인스타그램 연결이 해제되었습니다",
  "requiredFields": "페이지 ID, 인스타그램 사용자 ID, 페이지 액세스 토큰은 필수입니다",
  "webhookSetupTitle": "Meta 앱에서 웹훅 설정을 완료하세요",
  "webhookUrlLabel": "콜백 URL:",
  "verifyTokenLabel": "확인 토큰:"
}
```

Under `"Inbox"`:

```json
"channelTabs": {
  "whatsapp": "WhatsApp",
  "instagram": "인스타그램"
},
"instagram": {
  "loading": "대화 불러오는 중…",
  "emptyList": "아직 인스타그램 대화가 없습니다",
  "noContactName": "이름 없음",
  "noMessages": "아직 메시지가 없습니다",
  "selectConversation": "대화를 선택하세요",
  "windowClosed": "답장 가능한 24시간이 지났습니다. 고객의 새 메시지를 기다려 주세요.",
  "windowClosedPlaceholder": "답장하려면 새 메시지를 기다리는 중…",
  "placeholder": "메시지를 입력하세요…",
  "attach": "첨부",
  "sendError": "메시지를 보낼 수 없습니다",
  "fileTooLarge": "파일이 너무 큽니다",
  "attachment": "첨부파일",
  "storyMention": "스토리 멘션",
  "sharedPost": "게시물을 공유했습니다",
  "unsupported": "지원되지 않는 메시지"
}
```

- [ ] **Step 4: Add the same keys, translated, to `messages/es.json`**

Under `"Settings"`:

```json
"instagram": {
  "title": "Instagram",
  "description": "Conecta una cuenta de Instagram Profesional vinculada a una Página de Facebook para recibir y responder Direct desde la bandeja de entrada.",
  "statusConnected": "Conectado",
  "statusDisconnected": "No conectado",
  "pageId": "ID de la Página de Facebook",
  "igUserId": "ID de usuario de Instagram",
  "igUsername": "Usuario de Instagram (opcional)",
  "pageAccessToken": "Token de acceso de la Página",
  "tokenPlaceholderConnected": "Deja en blanco para mantener el token actual",
  "save": "Guardar configuración",
  "disconnect": "Desconectar",
  "loadError": "No se pudo cargar la configuración de Instagram",
  "saveError": "No se pudo guardar la configuración",
  "saveSuccess": "Configuración de Instagram guardada",
  "disconnectError": "No se pudo desconectar Instagram",
  "disconnectSuccess": "Instagram desconectado",
  "requiredFields": "El ID de la Página, el ID de usuario de Instagram y el token de acceso son obligatorios",
  "webhookSetupTitle": "Completa la configuración del webhook en tu Meta App",
  "webhookUrlLabel": "URL de callback:",
  "verifyTokenLabel": "Token de verificación:"
}
```

Under `"Inbox"`:

```json
"channelTabs": {
  "whatsapp": "WhatsApp",
  "instagram": "Instagram"
},
"instagram": {
  "loading": "Cargando conversaciones…",
  "emptyList": "Aún no hay conversaciones de Instagram",
  "noContactName": "Sin nombre",
  "noMessages": "Aún no hay mensajes",
  "selectConversation": "Selecciona una conversación",
  "windowClosed": "La ventana de 24h para responder expiró. Espera un nuevo mensaje del cliente.",
  "windowClosedPlaceholder": "Esperando un nuevo mensaje para responder…",
  "placeholder": "Escribe un mensaje…",
  "attach": "Adjuntar",
  "sendError": "No se pudo enviar el mensaje",
  "fileTooLarge": "El archivo es demasiado grande",
  "attachment": "Adjunto",
  "storyMention": "Mención en historia",
  "sharedPost": "Compartió una publicación",
  "unsupported": "Mensaje no compatible"
}
```

- [ ] **Step 5: Run the catalogue parity test**

Run: `npx vitest run src/i18n/messages.test.ts`
Expected: PASS — all four locales carry the same keys with matching (empty, in this case) ICU placeholder signatures.

- [ ] **Step 6: Commit**

```bash
git add messages/en.json messages/pt.json messages/ko.json messages/es.json
git commit -m "feat(instagram): add i18n strings for settings and inbox"
```

---

### Task 11: Settings panel

**Files:**
- Create: `src/components/settings/instagram-config.tsx`
- Modify: `src/components/settings/settings-sections.ts`
- Modify: `src/app/(dashboard)/settings/page.tsx`

**Interfaces:**
- Consumes: `SettingsPanelHead` from `./settings-panel-head`; `GET`/`POST`/`DELETE /api/instagram/config` from Task 9.
- Produces: `InstagramConfigPanel` component, a new `'instagram'` entry in `SettingsSection`.
- No automated test — component files follow the repo's existing convention of manual verification in the browser (Task 15 covers a combined manual-test checklist).

- [ ] **Step 1: Add the `'instagram'` section**

In `src/components/settings/settings-sections.ts`, add `PlugZap`'s sibling import and the new section. Replace:

```typescript
import {
  Coins,
  FileText,
  KeyRound,
  LayoutGrid,
  Palette,
  PlugZap,
  Shield,
  Tags,
  User,
  UsersRound,
  Zap,
  type LucideIcon,
} from 'lucide-react';
```

with:

```typescript
import {
  AtSign,
  Coins,
  FileText,
  KeyRound,
  LayoutGrid,
  Palette,
  PlugZap,
  Shield,
  Tags,
  User,
  UsersRound,
  Zap,
  type LucideIcon,
} from 'lucide-react';
```

Replace:

```typescript
export const SETTINGS_SECTIONS = [
  'overview',
  'profile',
  'security',
  'appearance',
  'whatsapp',
  'templates',
```

with:

```typescript
export const SETTINGS_SECTIONS = [
  'overview',
  'profile',
  'security',
  'appearance',
  'whatsapp',
  'instagram',
  'templates',
```

Replace:

```typescript
  whatsapp: { id: 'whatsapp', label: 'WhatsApp', icon: PlugZap, group: 'workspace' },
  templates: { id: 'templates', label: 'Templates', icon: FileText, group: 'workspace' },
```

with:

```typescript
  whatsapp: { id: 'whatsapp', label: 'WhatsApp', icon: PlugZap, group: 'workspace' },
  instagram: { id: 'instagram', label: 'Instagram', icon: AtSign, group: 'workspace' },
  templates: { id: 'templates', label: 'Templates', icon: FileText, group: 'workspace' },
```

- [ ] **Step 2: Write the panel component**

```tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2, Save, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { SettingsPanelHead } from './settings-panel-head';

interface ConfigResponse {
  connected: boolean;
  config?: {
    page_id: string;
    ig_user_id: string;
    ig_username: string | null;
    status: string;
    connected_at: string | null;
  };
}

export function InstagramConfigPanel() {
  const t = useTranslations('Settings.instagram');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [connected, setConnected] = useState(false);
  const [pageId, setPageId] = useState('');
  const [igUserId, setIgUserId] = useState('');
  const [igUsername, setIgUsername] = useState('');
  const [pageAccessToken, setPageAccessToken] = useState('');
  const [verifyToken, setVerifyToken] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/instagram/config');
      const data: ConfigResponse = await res.json();
      setConnected(data.connected);
      if (data.config) {
        setPageId(data.config.page_id);
        setIgUserId(data.config.ig_user_id);
        setIgUsername(data.config.ig_username ?? '');
      }
    } catch {
      toast.error(t('loadError'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSave = useCallback(async () => {
    if (!pageId.trim() || !igUserId.trim() || !pageAccessToken.trim()) {
      toast.error(t('requiredFields'));
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/instagram/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          page_id: pageId.trim(),
          ig_user_id: igUserId.trim(),
          ig_username: igUsername.trim() || undefined,
          page_access_token: pageAccessToken.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? t('saveError'));
        return;
      }
      setVerifyToken(data.verify_token);
      setPageAccessToken('');
      setConnected(true);
      toast.success(t('saveSuccess'));
    } catch {
      toast.error(t('saveError'));
    } finally {
      setSaving(false);
    }
  }, [pageId, igUserId, igUsername, pageAccessToken, t]);

  const handleDisconnect = useCallback(async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/instagram/config', { method: 'DELETE' });
      if (!res.ok) {
        toast.error(t('disconnectError'));
        return;
      }
      setConnected(false);
      setPageId('');
      setIgUserId('');
      setIgUsername('');
      setVerifyToken(null);
      toast.success(t('disconnectSuccess'));
    } catch {
      toast.error(t('disconnectError'));
    } finally {
      setSaving(false);
    }
  }, [t]);

  const webhookUrl =
    typeof window !== 'undefined' ? `${window.location.origin}/api/instagram/webhook` : '';

  if (loading) {
    return (
      <div className="flex h-32 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <section className="max-w-2xl animate-in fade-in-50 duration-200">
      <SettingsPanelHead title={t('title')} description={t('description')} />

      <div className="space-y-4">
        <div
          className={
            connected
              ? 'rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-400'
              : 'rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-400'
          }
        >
          {connected ? t('statusConnected') : t('statusDisconnected')}
        </div>

        <Field label={t('pageId')}>
          <input
            value={pageId}
            onChange={(e) => setPageId(e.target.value)}
            className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground outline-none focus:border-primary/50"
            placeholder="17841400000000000"
          />
        </Field>

        <Field label={t('igUserId')}>
          <input
            value={igUserId}
            onChange={(e) => setIgUserId(e.target.value)}
            className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground outline-none focus:border-primary/50"
            placeholder="17841400000000000"
          />
        </Field>

        <Field label={t('igUsername')}>
          <input
            value={igUsername}
            onChange={(e) => setIgUsername(e.target.value)}
            className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground outline-none focus:border-primary/50"
            placeholder="minhaempresa"
          />
        </Field>

        <Field label={t('pageAccessToken')}>
          <input
            type="password"
            value={pageAccessToken}
            onChange={(e) => setPageAccessToken(e.target.value)}
            className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground outline-none focus:border-primary/50"
            placeholder={connected ? t('tokenPlaceholderConnected') : ''}
          />
        </Field>

        <div className="flex gap-2">
          <Button onClick={handleSave} disabled={saving}>
            {saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Save className="mr-1 h-4 w-4" />}
            {t('save')}
          </Button>
          {connected && (
            <Button variant="outline" onClick={handleDisconnect} disabled={saving}>
              <Trash2 className="mr-1 h-4 w-4" />
              {t('disconnect')}
            </Button>
          )}
        </div>

        {verifyToken && (
          <div className="rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
            <p className="font-semibold text-foreground">{t('webhookSetupTitle')}</p>
            <p className="mt-1">{t('webhookUrlLabel')}</p>
            <code className="mt-1 block break-all rounded bg-muted px-2 py-1">{webhookUrl}</code>
            <p className="mt-2">{t('verifyTokenLabel')}</p>
            <code className="mt-1 block break-all rounded bg-muted px-2 py-1">{verifyToken}</code>
          </div>
        )}
      </div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}
```

- [ ] **Step 3: Wire the panel into the settings page**

In `src/app/(dashboard)/settings/page.tsx`, add the import next to `WhatsAppConfig`. Replace:

```typescript
import { WhatsAppConfig } from '@/components/settings/whatsapp-config';
```

with:

```typescript
import { WhatsAppConfig } from '@/components/settings/whatsapp-config';
import { InstagramConfigPanel } from '@/components/settings/instagram-config';
```

Then replace the `panel` map entry:

```typescript
    whatsapp: <WhatsAppConfig />,
    templates: <TemplateManager />,
```

with:

```typescript
    whatsapp: <WhatsAppConfig />,
    instagram: <InstagramConfigPanel />,
    templates: <TemplateManager />,
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: passes — `SettingsSection` now includes `'instagram'`, and the `panel` record and `SECTION_META` are both exhaustive over it, so a missing entry would be a type error.

- [ ] **Step 5: Manual verification**

Run `npm run dev`, open `/settings?tab=instagram`, confirm the panel renders with the "Not connected" status and the three input fields.

- [ ] **Step 6: Commit**

```bash
git add src/components/settings/instagram-config.tsx src/components/settings/settings-sections.ts "src/app/(dashboard)/settings/page.tsx"
git commit -m "feat(instagram): add settings panel"
```

---

### Task 12: Realtime hook

**Files:**
- Create: `src/hooks/use-instagram-realtime.ts`

**Interfaces:**
- Consumes: `createClient` from `@/lib/supabase/client`; `InstagramMessage`, `InstagramConversation` from `@/types/instagram` (Task 2).
- Produces: `useInstagramRealtime({channelName, onMessageEvent?, onConversationEvent?, enabled?})` returning `{isConnected, unsubscribe}` — consumed by Task 14 (top-level Instagram inbox page).
- No automated test — mirrors `src/hooks/use-realtime.ts`, which also has none; both need a live Supabase Realtime connection to exercise meaningfully.

- [ ] **Step 1: Write the hook**

```typescript
'use client';

import { useEffect, useRef, useCallback, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { InstagramMessage, InstagramConversation } from '@/types/instagram';
import type { RealtimeChannel } from '@supabase/supabase-js';

interface RealtimeEvent<T> {
  eventType: 'INSERT' | 'UPDATE' | 'DELETE';
  new: T;
  old: Partial<T>;
}

interface UseInstagramRealtimeOptions {
  channelName: string;
  onMessageEvent?: (event: RealtimeEvent<InstagramMessage>) => void;
  onConversationEvent?: (event: RealtimeEvent<InstagramConversation>) => void;
  enabled?: boolean;
}

export function useInstagramRealtime({
  channelName,
  onMessageEvent,
  onConversationEvent,
  enabled = true,
}: UseInstagramRealtimeOptions) {
  const channelRef = useRef<RealtimeChannel | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const onMessageRef = useRef(onMessageEvent);
  const onConversationRef = useRef(onConversationEvent);
  useEffect(() => {
    onMessageRef.current = onMessageEvent;
    onConversationRef.current = onConversationEvent;
  });

  useEffect(() => {
    if (!enabled) return;
    const supabase = createClient();
    const channel = supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'instagram_messages' },
        (payload) => {
          onMessageRef.current?.({
            eventType: payload.eventType as RealtimeEvent<InstagramMessage>['eventType'],
            new: payload.new as InstagramMessage,
            old: payload.old as Partial<InstagramMessage>,
          });
        },
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'instagram_conversations' },
        (payload) => {
          onConversationRef.current?.({
            eventType: payload.eventType as RealtimeEvent<InstagramConversation>['eventType'],
            new: payload.new as InstagramConversation,
            old: payload.old as Partial<InstagramConversation>,
          });
        },
      )
      .subscribe((status) => setIsConnected(status === 'SUBSCRIBED'));

    channelRef.current = channel;
    return () => {
      supabase.removeChannel(channel);
      channelRef.current = null;
      setIsConnected(false);
    };
  }, [channelName, enabled]);

  const unsubscribe = useCallback(() => {
    if (channelRef.current) {
      const supabase = createClient();
      supabase.removeChannel(channelRef.current);
      channelRef.current = null;
      setIsConnected(false);
    }
  }, []);

  return { isConnected, unsubscribe };
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add src/hooks/use-instagram-realtime.ts
git commit -m "feat(instagram): add realtime subscription hook"
```

---

### Task 13: Conversation list component

**Files:**
- Create: `src/components/inbox/instagram/instagram-conversation-list.tsx`

**Interfaces:**
- Consumes: `createClient` from `@/lib/supabase/client`; `InstagramConversation` from `@/types/instagram` (Task 2).
- Produces: `InstagramConversationList({conversations, activeConversationId, onSelect, onConversationsLoaded, resyncToken})` — consumed by Task 15.
- No automated test — visual component, verified manually in Task 15's checklist.

- [ ] **Step 1: Write the component**

```tsx
'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import type { InstagramConversation } from '@/types/instagram';

interface InstagramConversationListProps {
  conversations: InstagramConversation[];
  activeConversationId: string | null;
  onSelect: (conv: InstagramConversation) => void;
  onConversationsLoaded: (conversations: InstagramConversation[]) => void;
  resyncToken: number;
}

export function InstagramConversationList({
  conversations,
  activeConversationId,
  onSelect,
  onConversationsLoaded,
  resyncToken,
}: InstagramConversationListProps) {
  const t = useTranslations('Inbox.instagram');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      const supabase = createClient();
      const { data } = await supabase
        .from('instagram_conversations')
        .select('*, contact:instagram_contacts(*)')
        .order('last_message_at', { ascending: false, nullsFirst: false });
      if (!cancelled) {
        onConversationsLoaded((data as InstagramConversation[]) ?? []);
        setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resyncToken]);

  if (loading) {
    return (
      <div className="w-full max-w-sm border-r border-border p-4 text-sm text-muted-foreground">
        {t('loading')}
      </div>
    );
  }

  return (
    <div className="flex w-full max-w-sm flex-col overflow-y-auto border-r border-border">
      {conversations.length === 0 && (
        <p className="p-4 text-sm text-muted-foreground">{t('emptyList')}</p>
      )}
      {conversations.map((conv) => {
        const label = conv.contact?.name || conv.contact?.username || t('noContactName');
        return (
          <button
            key={conv.id}
            type="button"
            onClick={() => onSelect(conv)}
            className={cn(
              'flex items-center gap-3 border-b border-border px-4 py-3 text-left transition-colors hover:bg-muted/40',
              activeConversationId === conv.id && 'bg-muted/60',
            )}
          >
            {conv.contact?.profile_pic_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={conv.contact.profile_pic_url}
                alt={label}
                className="h-10 w-10 shrink-0 rounded-full object-cover"
              />
            ) : (
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold text-muted-foreground">
                {label.slice(0, 1).toUpperCase()}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-medium text-foreground">{label}</span>
                {conv.unread_count > 0 && (
                  <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
                    {conv.unread_count}
                  </span>
                )}
              </div>
              <p className="truncate text-xs text-muted-foreground">
                {conv.last_message_text || t('noMessages')}
              </p>
            </div>
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add src/components/inbox/instagram/instagram-conversation-list.tsx
git commit -m "feat(instagram): add conversation list component"
```

---

### Task 14: Message thread + composer component

**Files:**
- Create: `src/components/inbox/instagram/instagram-message-thread.tsx`

**Interfaces:**
- Consumes: `createClient` from `@/lib/supabase/client`; `uploadAccountMedia`, `MEDIA_MAX_BYTES_BY_KIND` from `@/lib/storage/upload-media`; `isMessagingWindowOpen` from `@/lib/instagram/messaging-window` (Task 3); `InstagramConversation`, `InstagramMessage` from `@/types/instagram` (Task 2); posts to `/api/instagram/send` (Task 8).
- Produces: `InstagramMessageThread({conversation, messages, onMessagesLoaded, onNewMessage, resyncToken})` — consumed by Task 15.
- No automated test — visual component, verified manually in Task 15's checklist.

- [ ] **Step 1: Write the component**

```tsx
'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Send, Loader2, Paperclip } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { uploadAccountMedia, MEDIA_MAX_BYTES_BY_KIND } from '@/lib/storage/upload-media';
import { isMessagingWindowOpen } from '@/lib/instagram/messaging-window';
import type { InstagramConversation, InstagramMessage } from '@/types/instagram';

interface InstagramMessageThreadProps {
  conversation: InstagramConversation | null;
  messages: InstagramMessage[];
  onMessagesLoaded: (messages: InstagramMessage[]) => void;
  onNewMessage: (message: InstagramMessage) => void;
  resyncToken: number;
}

export function InstagramMessageThread({
  conversation,
  messages,
  onMessagesLoaded,
  onNewMessage,
  resyncToken,
}: InstagramMessageThreadProps) {
  const t = useTranslations('Inbox.instagram');
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!conversation) {
      onMessagesLoaded([]);
      return;
    }
    let cancelled = false;
    async function load() {
      const supabase = createClient();
      const { data } = await supabase
        .from('instagram_messages')
        .select('*')
        .eq('conversation_id', conversation!.id)
        .order('created_at', { ascending: true });
      if (!cancelled) onMessagesLoaded((data as InstagramMessage[]) ?? []);
    }
    void load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation?.id, resyncToken]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const windowOpen = isMessagingWindowOpen(conversation?.last_customer_message_at);

  const sendText = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || !conversation || sending) return;
    setSending(true);
    try {
      const res = await fetch('/api/instagram/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversation_id: conversation.id,
          content_type: 'text',
          content_text: trimmed,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? t('sendError'));
        return;
      }
      onNewMessage({
        id: data.message_id,
        conversation_id: conversation.id,
        sender_type: 'agent',
        content_type: 'text',
        content_text: trimmed,
        status: 'sent',
        created_at: new Date().toISOString(),
      });
      setText('');
    } catch {
      toast.error(t('sendError'));
    } finally {
      setSending(false);
    }
  }, [text, conversation, sending, onNewMessage, t]);

  const sendFile = useCallback(
    async (file: File) => {
      if (!conversation) return;
      const kind = file.type.startsWith('image/')
        ? 'image'
        : file.type.startsWith('video/')
          ? 'video'
          : file.type.startsWith('audio/')
            ? 'audio'
            : 'document';
      const maxBytes = MEDIA_MAX_BYTES_BY_KIND[kind as keyof typeof MEDIA_MAX_BYTES_BY_KIND];
      if (file.size > maxBytes) {
        toast.error(t('fileTooLarge'));
        return;
      }
      setUploading(true);
      try {
        const { publicUrl } = await uploadAccountMedia('chat-media', file);
        const contentType = kind === 'document' ? 'file' : kind;
        const res = await fetch('/api/instagram/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            conversation_id: conversation.id,
            content_type: contentType,
            media_url: publicUrl,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          toast.error(data.error ?? t('sendError'));
          return;
        }
        onNewMessage({
          id: data.message_id,
          conversation_id: conversation.id,
          sender_type: 'agent',
          content_type: contentType,
          media_url: publicUrl,
          status: 'sent',
          created_at: new Date().toISOString(),
        });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t('sendError'));
      } finally {
        setUploading(false);
      }
    },
    [conversation, onNewMessage, t],
  );

  if (!conversation) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        {t('selectConversation')}
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto p-4">
        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} t={t} />
        ))}
        <div ref={bottomRef} />
      </div>

      <div className="border-t border-border bg-card p-3">
        {!windowOpen && (
          <p className="mb-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-400">
            {t('windowClosed')}
          </p>
        )}
        <div className="flex items-end gap-2">
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void sendFile(file);
              e.target.value = '';
            }}
          />
          <button
            type="button"
            disabled={!windowOpen || uploading}
            onClick={() => fileInputRef.current?.click()}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            title={t('attach')}
          >
            {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Paperclip className="h-4 w-4" />}
          </button>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void sendText();
              }
            }}
            disabled={!windowOpen}
            rows={1}
            placeholder={windowOpen ? t('placeholder') : t('windowClosedPlaceholder')}
            className="flex-1 resize-none rounded-xl border border-border bg-muted px-4 py-2.5 text-sm text-foreground placeholder-muted-foreground outline-none focus:border-primary/50 disabled:cursor-not-allowed disabled:opacity-50"
          />
          <Button
            size="sm"
            disabled={!text.trim() || !windowOpen || sending}
            onClick={() => void sendText()}
            className="h-9 w-9 shrink-0 bg-primary p-0 hover:bg-primary/90 disabled:opacity-40"
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

function MessageBubble({
  message,
  t,
}: {
  message: InstagramMessage;
  t: ReturnType<typeof useTranslations>;
}) {
  const isAgent = message.sender_type === 'agent';
  return (
    <div className={`mb-3 flex ${isAgent ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[70%] rounded-2xl px-4 py-2 text-sm ${
          isAgent ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground'
        }`}
      >
        {message.content_type === 'text' && <p className="whitespace-pre-wrap">{message.content_text}</p>}
        {message.content_type === 'image' && message.media_url && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={message.media_url} alt="" className="max-h-64 rounded-lg" />
        )}
        {message.content_type === 'video' && message.media_url && (
          <video src={message.media_url} controls className="max-h-64 rounded-lg" />
        )}
        {message.content_type === 'audio' && message.media_url && <audio src={message.media_url} controls />}
        {message.content_type === 'file' && message.media_url && (
          <a href={message.media_url} target="_blank" rel="noreferrer" className="underline">
            {t('attachment')}
          </a>
        )}
        {message.content_type === 'story_mention' && <p>{t('storyMention')}</p>}
        {message.content_type === 'share' && <p>{t('sharedPost')}</p>}
        {message.content_type === 'unsupported' && <p>{t('unsupported')}</p>}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add src/components/inbox/instagram/instagram-message-thread.tsx
git commit -m "feat(instagram): add message thread and composer component"
```

---

### Task 15: Top-level Instagram inbox page + channel tab wiring

**Files:**
- Create: `src/app/(dashboard)/inbox/instagram-inbox.tsx`
- Modify: `src/app/(dashboard)/inbox/page.tsx`

**Interfaces:**
- Consumes: `InstagramConversationList` (Task 13), `InstagramMessageThread` (Task 14), `useInstagramRealtime` (Task 12), `InstagramConversation`/`InstagramMessage` (Task 2).
- Produces: `InstagramInboxPage` component; a channel tab strip ("WhatsApp" / "Instagram") in the existing inbox route.
- No automated test — this is the final wiring step; verified with the manual checklist in Step 4 below, which is the plan's end-to-end proof that the feature works.

- [ ] **Step 1: Write the top-level Instagram inbox page**

```tsx
'use client';

import { useCallback, useState } from 'react';
import { InstagramConversationList } from '@/components/inbox/instagram/instagram-conversation-list';
import { InstagramMessageThread } from '@/components/inbox/instagram/instagram-message-thread';
import { useInstagramRealtime } from '@/hooks/use-instagram-realtime';
import type { InstagramConversation, InstagramMessage } from '@/types/instagram';

export function InstagramInboxPage() {
  const [conversations, setConversations] = useState<InstagramConversation[]>([]);
  const [activeConversation, setActiveConversation] = useState<InstagramConversation | null>(null);
  const [messages, setMessages] = useState<InstagramMessage[]>([]);
  const [resyncToken, setResyncToken] = useState(0);

  const handleSelect = useCallback((conv: InstagramConversation) => {
    setActiveConversation(conv);
    setConversations((prev) => prev.map((c) => (c.id === conv.id ? { ...c, unread_count: 0 } : c)));
  }, []);

  useInstagramRealtime({
    channelName: 'instagram-inbox-realtime',
    enabled: true,
    onMessageEvent: (event) => {
      if (event.eventType !== 'INSERT') return;
      const msg = event.new;
      setMessages((prev) => {
        if (!activeConversation || msg.conversation_id !== activeConversation.id) return prev;
        return prev.some((m) => m.id === msg.id) ? prev : [...prev, msg];
      });
      setConversations((prev) =>
        prev.map((c) =>
          c.id === msg.conversation_id
            ? {
                ...c,
                last_message_text: msg.content_text ?? '',
                last_message_at: msg.created_at,
                unread_count: activeConversation?.id === msg.conversation_id ? 0 : c.unread_count + 1,
              }
            : c,
        ),
      );
    },
    onConversationEvent: (event) => {
      if (event.eventType !== 'INSERT') return;
      setConversations((prev) =>
        prev.some((c) => c.id === event.new.id) ? prev : [...prev, event.new],
      );
    },
  });

  return (
    <div className="flex h-full flex-1 overflow-hidden">
      <InstagramConversationList
        conversations={conversations}
        activeConversationId={activeConversation?.id ?? null}
        onSelect={handleSelect}
        onConversationsLoaded={setConversations}
        resyncToken={resyncToken}
      />
      <InstagramMessageThread
        conversation={activeConversation}
        messages={messages}
        onMessagesLoaded={setMessages}
        onNewMessage={(msg) => setMessages((prev) => [...prev, msg])}
        resyncToken={resyncToken}
      />
    </div>
  );
}
```

Note: `resyncToken` is threaded through but nothing bumps it here (unlike the WhatsApp inbox's reconnect/visibility resync) — that polish is deliberately left out of v1 for simplicity. A manual page refresh always re-fetches via the `onConversationsLoaded`/`onMessagesLoaded` mount effects.

- [ ] **Step 2: Strip `InboxPageInner`'s own outer wrapper**

In `src/app/(dashboard)/inbox/page.tsx`, `InboxPageInner` currently wraps its whole return in the page-level layout div. That div needs to move up to the new tab-aware `InboxPage` (Step 3), so `InboxPageInner` must stop rendering it itself. Replace:

```tsx
  return (
    <div className="-m-4 flex h-[calc(100vh-3.5rem)] flex-col overflow-hidden sm:-m-6">
      {/* WhatsApp connection banner — in the flex column, not absolute,
          so it pushes the panels down instead of overlapping them. */}
      {whatsappConnected === false && (
```

with:

```tsx
  return (
    <>
      {/* WhatsApp connection banner — in the flex column, not absolute,
          so it pushes the panels down instead of overlapping them. */}
      {whatsappConnected === false && (
```

And replace the closing of that same return block:

```tsx
        {contactPanelOpen && (
          <div className="hidden lg:block">
            <ContactSidebar contact={activeContact} />
          </div>
        )}
      </div>
    </div>
  );
}
```

with:

```tsx
        {contactPanelOpen && (
          <div className="hidden lg:block">
            <ContactSidebar contact={activeContact} />
          </div>
        )}
      </div>
    </>
  );
}
```

(Only the outermost `</div>` becomes `</>` — the `</div>` that closes the `flex flex-1 overflow-hidden` row directly above it stays exactly as it is.)

- [ ] **Step 3: Add the channel tab strip to `InboxPage`**

Add the import next to the other top-of-file imports. Replace:

```tsx
import { toast } from "sonner";
import { WifiOff } from "lucide-react";
import { cn } from "@/lib/utils";
```

with:

```tsx
import { toast } from "sonner";
import { WifiOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { InstagramInboxPage } from "./instagram-inbox";
```

Then replace the default export:

```tsx
export default function InboxPage() {
  return (
    <Suspense fallback={null}>
      <InboxPageInner />
    </Suspense>
  );
}
```

with:

```tsx
type ChannelTab = "whatsapp" | "instagram";

export default function InboxPage() {
  const [channel, setChannel] = useState<ChannelTab>("whatsapp");

  return (
    <div className="-m-4 flex h-[calc(100vh-3.5rem)] flex-col overflow-hidden sm:-m-6">
      <div className="flex shrink-0 gap-1 border-b border-border bg-card px-4 pt-2">
        {(["whatsapp", "instagram"] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setChannel(tab)}
            className={cn(
              "rounded-t-lg px-4 py-2 text-sm font-medium transition-colors",
              channel === tab
                ? "border-b-2 border-primary text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {tab === "whatsapp" ? "WhatsApp" : "Instagram"}
          </button>
        ))}
      </div>
      {channel === "whatsapp" ? (
        <Suspense fallback={null}>
          <InboxPageInner />
        </Suspense>
      ) : (
        <InstagramInboxPage />
      )}
    </div>
  );
}
```

`useState` is already imported at the top of this file (`import { Suspense, useState, useCallback, useEffect, useRef } from "react";`), so no import change is needed for that.

- [ ] **Step 4: Full verification pass**

Run, in order:

```bash
npm run typecheck
npm run lint
npm test
```

Expected: all three pass.

Then start the dev server (`npm run dev`) and manually verify:
1. `/inbox` shows a "WhatsApp" / "Instagram" tab strip; WhatsApp tab behaves exactly as before (this is the regression check for Task 2's edit).
2. The Instagram tab renders the empty state ("No Instagram conversations yet") when nothing is connected/no conversations exist yet.
3. `/settings?tab=instagram` lets you save a Page ID / IG User ID / Page access token (a placeholder value is fine for this check — the save will fail Graph API verification, confirming the 400 path works; a real token is needed for the next step).
4. **Real end-to-end check** (needs your actual Meta App + Instagram Professional account, and a public HTTPS tunnel since Meta cannot reach `localhost`): run `ngrok http 3000` (or equivalent), set the Meta App's Instagram webhook callback URL to `https://<tunnel>/api/instagram/webhook` and the verify token to the one the settings panel showed you after saving, subscribe to the `messages` field, then send a real Instagram DM to the connected account and confirm it appears in the CRM's Instagram tab in real time, and that replying from the CRM arrives on the real Instagram app.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(dashboard)/inbox/page.tsx" "src/app/(dashboard)/inbox/instagram-inbox.tsx"
git commit -m "feat(instagram): wire Instagram tab into the inbox"
```

---

## Self-Review

**Spec coverage:** every section of `docs/superpowers/specs/2026-09-15-instagram-integration-design.md` maps onto a task — schema (Task 1), auth/config (Tasks 9, 11), webhook (Task 7), send (Tasks 6, 8), UI tabs (Task 15), i18n (Task 10), media mirroring (Task 5), 24h window (Tasks 3, 14). The spec's "fora de escopo" list (automations/flows/AI, comments/mentions, templates/broadcasts, ice breakers, moderated-conversations API) has deliberately no task — confirmed absent throughout.

**Placeholder scan:** no task contains TBD/TODO or an unshown "add error handling" instruction; every code block is complete and copy-pasteable.

**Type consistency:** `InstagramMessage`/`InstagramConversation`/`InstagramConfig` (Task 2) are the only shapes referenced by every later task; `sendInstagramMessage`'s return `{messageId, igMessageId}` (Task 6) matches what Task 8's route reads (`result.messageId`, `result.igMessageId`) and what Task 14's composer expects back (`data.message_id`, mapped manually into a local `InstagramMessage` since the route returns snake_case over the wire). `InstagramSendError.status` (Task 6) is what Task 8 reads to pick the HTTP status. `MirrorStorage`'s `upload`/`getPublicUrl` shape (Task 5) matches how Task 7 calls it via `supabaseAdmin().storage`.

## Execution

**Plan complete and saved to `docs/superpowers/plans/2026-09-15-instagram-messaging.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
