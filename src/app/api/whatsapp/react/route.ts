import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { sendReactionMessage } from '@/lib/whatsapp/meta-api';
import { decrypt } from '@/lib/whatsapp/encryption';
import { resolveContactSendTarget } from '@/lib/whatsapp/wa-identity';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { resolveProviderSendTarget } from '@/lib/whatsapp/providers/resolve-send-target';
import {
  loadUazapiInstanceClient,
  type WhatsAppConfigRow,
} from '@/lib/whatsapp/providers/send-provider-message';
import { SendMessageError } from '@/lib/whatsapp/send-message-error';
import {
  isProviderNotSupportedError,
  providerCapabilityErrorResponse,
  requireAccountCapability,
} from '@/lib/whatsapp/providers/account-capability-guard';

/**
 * POST /api/whatsapp/react
 *
 * Body: { message_id: <internal UUID>, emoji: <single emoji or "" to remove> }
 *
 * Sends the reaction through the account's provider (Meta Cloud API or
 * UAZAPI) and mirrors it into `message_reactions`
 * (delete on empty emoji). Customer-side reactions are handled by the
 * webhook — this route only writes `actor_type = 'agent'` rows.
 */
export async function POST(request: Request) {
  try {
    // Reacting is a write operation (`canSendMessages`), and it pushes the
    // reaction to Meta before mirroring it locally — so, as on /send, a
    // missing role check let a read-only viewer put a visible reaction on
    // the customer's message even though RLS blocked the local mirror.
    const { supabase, accountId, userId } = await requireRole('agent');

    await requireAccountCapability(
      supabase,
      accountId,
      'reactions'
    );

    const limit = checkRateLimit(`react:${userId}`, RATE_LIMITS.react);
    if (!limit.success) {
      return rateLimitResponse(limit);
    }

    const body = await request.json();
    const { message_id, emoji } = body as {
      message_id?: string;
      emoji?: string;
    };

    if (!message_id || typeof emoji !== 'string') {
      return NextResponse.json(
        { error: "O ID da mensagem e o emoji são obrigatórios" },
        { status: 400 },
      );
    }

    // Resolve target message + its conversation; verify ownership.
    const { data: targetMessage, error: msgError } = await supabase
      .from('messages')
      .select('id, message_id, conversation_id')
      .eq('id', message_id)
      .maybeSingle();

    if (msgError || !targetMessage) {
      return NextResponse.json({ error: 'Mensagem não encontrada' }, { status: 404 });
    }

    if (!targetMessage.message_id) {
      // No Meta ID yet — usually a sending/failed agent message. We can't
      // tell Meta to react to a message it never received.
      return NextResponse.json(
        { error: "Não é possível reagir a uma mensagem que ainda não foi enviada ao WhatsApp" },
        { status: 400 },
      );
    }

    const { data: conversation, error: convError } = await supabase
      .from('conversations')
      .select('id, account_id, contact:contacts(id, phone, wa_user_id)')
      .eq('id', targetMessage.conversation_id)
      .eq('account_id', accountId)
      .maybeSingle();

    if (convError || !conversation) {
      return NextResponse.json(
        { error: "Conversa não encontrada" },
        { status: 404 },
      );
    }

    const contact = Array.isArray(conversation.contact)
      ? conversation.contact[0]
      : conversation.contact;

    // WhatsApp config. Account-scoped post-multi-user.
    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .single();

    if (configError || !config) {
      return NextResponse.json(
        { error: "O WhatsApp não está configurado." },
        { status: 400 },
      );
    }

    if (config.provider === 'uazapi') {
      try {
        const target = await resolveProviderSendTarget(
          supabase,
          accountId,
          'uazapi',
          contact
        );
        const client = await loadUazapiInstanceClient(
          config as WhatsAppConfigRow
        );
        if (!client.reactToMessage) {
          throw new Error('reactToMessage unavailable');
        }
        await client.reactToMessage({
          number: target.target,
          messageId: targetMessage.message_id,
          emoji,
        });
      } catch (err) {
        if (err instanceof SendMessageError) {
          return NextResponse.json(
            { error: err.message },
            { status: err.status },
          );
        }
        console.error(
          '[whatsapp/react] UAZAPI send failed:',
          err instanceof Error ? err.message : err
        );
        return NextResponse.json(
          { error: 'Não foi possível enviar a reação pelo WhatsApp.' },
          { status: 502 },
        );
      }
      return mirrorReaction(supabase, targetMessage, userId, emoji);
    }

    // Phone number, or the business-scoped user ID for a contact Meta
    // never gave us a number for (issue #519).
    const sendTarget = resolveContactSendTarget(contact);
    if (!sendTarget) {
      return NextResponse.json(
        { error: "O contato não tem telefone nem ID de usuário do WhatsApp" },
        { status: 400 },
      );
    }

    const accessToken = decrypt(config.access_token);

    try {
      await sendReactionMessage({
        phoneNumberId: config.phone_number_id,
        accessToken,
        to: sendTarget.target,
        targetMessageId: targetMessage.message_id,
        emoji,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Erro desconhecido na API da Meta";
      console.error('[whatsapp/react] Meta send failed:', message);
      return NextResponse.json(
        { error: `Erro na API da Meta: ${message}` },
        { status: 502 },
      );
    }

    return mirrorReaction(supabase, targetMessage, userId, emoji);
  } catch (error) {
    if (isProviderNotSupportedError(error)) {
      return providerCapabilityErrorResponse(error);
    }
    // requireRole throws Unauthorized/Forbidden; toErrorResponse maps
    // those to 401/403 and collapses anything else to a generic 500.
    console.error('Error in WhatsApp react POST:', error);
    return toErrorResponse(error);
  }
}

/**
 * Writes the agent's reaction into `message_reactions` after the provider
 * accepted it. Empty emoji = removal.
 */
async function mirrorReaction(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  targetMessage: { id: string; conversation_id: string },
  userId: string,
  emoji: string,
): Promise<NextResponse> {
  // Mirror into DB. Empty emoji = removal.
  if (emoji === '') {
    const { error: delError } = await supabase
      .from('message_reactions')
      .delete()
      .eq('message_id', targetMessage.id)
      .eq('actor_type', 'agent')
      .eq('actor_id', userId);

    if (delError) {
      console.error('[whatsapp/react] DB delete failed:', delError.message);
      return NextResponse.json(
        { error: "Reação enviada ao WhatsApp, mas não foi possível removê-la do banco de dados" },
        { status: 500 },
      );
    }
  } else {
    // Upsert. The unique constraint (message_id, actor_type, actor_id)
    // lets us swap emoji in a single statement.
    const { error: upsertError } = await supabase.from('message_reactions').upsert(
      {
        message_id: targetMessage.id,
        conversation_id: targetMessage.conversation_id,
        actor_type: 'agent',
        actor_id: userId,
        emoji,
      },
      { onConflict: 'message_id,actor_type,actor_id' },
    );

    if (upsertError) {
      console.error('[whatsapp/react] DB upsert failed:', upsertError.message);
      return NextResponse.json(
        { error: "Reação enviada ao WhatsApp, mas não foi possível salvá-la no banco de dados" },
        { status: 500 },
      );
    }
  }

  return NextResponse.json({ success: true });
}
