-- ============================================================
-- 055 — Filtros da caixa de entrada e "não lida" por pessoa
-- ============================================================
--
-- 1. Aguardando resposta
--    `conversations.last_message_sender` guarda quem mandou a última
--    mensagem ('customer', 'agent' ou 'bot'). Quando é 'customer', a
--    conversa está esperando resposta. Mantido por gatilho em
--    `messages`, então vale para tudo: webhook, CRM, celular, robô,
--    importação de histórico (mensagem antiga não sobrescreve a nova).
--
-- 2. Bolinha azul separada para quem é dono e para o administrador
--    • `unread_count` continua sendo o contador do responsável pela
--      conversa (o vendedor; ou a equipe, se ainda não tem dono).
--      Zera quando o responsável abre a conversa no CRM ou lê no
--      celular.
--    • Quem olha a conversa de outra pessoa (admin, dono, visualizador)
--      tem a própria marca de leitura em `conversation_reads`. A
--      contagem dessa pessoa vem de `my_unread_counts()`.
--
-- 3. Lido no celular
--    O CRM nunca envia confirmação de leitura; então, quando o WhatsApp
--    avisa que uma mensagem do cliente foi lida, foi alguém no celular
--    da empresa. `apply_phone_read()` baixa o contador do responsável
--    para as mensagens que chegaram depois da que foi lida.
--
-- Pode ser executada mais de uma vez sem problema.
-- ============================================================

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS last_message_sender TEXT,
  ADD COLUMN IF NOT EXISTS last_message_sender_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_inbound_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
  ON messages (conversation_id, created_at);

-- ------------------------------------------------------------
-- Quem mandou a última mensagem
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.track_conversation_last_sender()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_at TIMESTAMPTZ := COALESCE(NEW.created_at, NOW());
BEGIN
  UPDATE conversations c
     SET last_message_sender = CASE
           WHEN c.last_message_sender_at IS NULL
             OR v_at >= c.last_message_sender_at
           THEN NEW.sender_type
           ELSE c.last_message_sender
         END,
         last_message_sender_at = GREATEST(
           COALESCE(c.last_message_sender_at, v_at), v_at
         ),
         last_inbound_at = CASE
           WHEN NEW.sender_type = 'customer'
           THEN GREATEST(COALESCE(c.last_inbound_at, v_at), v_at)
           ELSE c.last_inbound_at
         END
   WHERE c.id = NEW.conversation_id;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_track_conversation_last_sender ON messages;
CREATE TRIGGER trg_track_conversation_last_sender
  AFTER INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION public.track_conversation_last_sender();

-- Preenche as conversas que já existem.
UPDATE conversations c
   SET last_message_sender = m.sender_type,
       last_message_sender_at = m.created_at
  FROM (
    SELECT DISTINCT ON (conversation_id)
           conversation_id, sender_type, created_at
      FROM messages
     ORDER BY conversation_id, created_at DESC
  ) m
 WHERE m.conversation_id = c.id
   AND c.last_message_sender IS NULL;

UPDATE conversations c
   SET last_inbound_at = m.last_at
  FROM (
    SELECT conversation_id, MAX(created_at) AS last_at
      FROM messages
     WHERE sender_type = 'customer'
     GROUP BY conversation_id
  ) m
 WHERE m.conversation_id = c.id
   AND c.last_inbound_at IS NULL;

-- ------------------------------------------------------------
-- Marca de leitura por pessoa
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversation_reads (
  user_id UUID NOT NULL,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  last_read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, conversation_id)
);

ALTER TABLE conversation_reads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS conversation_reads_select ON conversation_reads;
CREATE POLICY conversation_reads_select ON conversation_reads FOR SELECT
  USING (user_id = auth.uid());
-- Escrita só pelas funções abaixo.

-- A partir de quando contar "não lidas" para quem nunca abriu a
-- conversa: a data desta migração para quem já existe, a data de
-- entrada para quem chegar depois. Evita que o admin comece com
-- centenas de mensagens antigas marcadas como não lidas.
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS unread_since TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE OR REPLACE FUNCTION public.mark_conversation_read(
  p_conversation_id UUID
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account UUID;
  v_assigned UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_allowed' USING ERRCODE = '42501';
  END IF;

  SELECT account_id, assigned_agent_id
    INTO v_account, v_assigned
    FROM conversations
   WHERE id = p_conversation_id;

  IF NOT FOUND OR NOT can_access_conversation(v_account, v_assigned) THEN
    RAISE EXCEPTION 'not_allowed' USING ERRCODE = '42501';
  END IF;

  INSERT INTO conversation_reads (user_id, conversation_id, last_read_at)
  VALUES (auth.uid(), p_conversation_id, NOW())
  ON CONFLICT (user_id, conversation_id)
  DO UPDATE SET last_read_at = GREATEST(conversation_reads.last_read_at,
                                        EXCLUDED.last_read_at);
END;
$$;

REVOKE ALL ON FUNCTION public.mark_conversation_read(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_conversation_read(UUID)
  TO authenticated;

-- Mensagens do cliente que a pessoa logada ainda não viu, por conversa.
-- Só devolve conversas com alguma não lida.
CREATE OR REPLACE FUNCTION public.my_unread_counts()
RETURNS TABLE (conversation_id UUID, unread BIGINT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH me AS (
    SELECT p.account_id, p.unread_since
      FROM profiles p
     WHERE p.user_id = auth.uid()
  )
  SELECT c.id, COUNT(m.id)
    FROM me
    JOIN conversations c
      ON c.account_id = me.account_id
    LEFT JOIN conversation_reads r
      ON r.conversation_id = c.id
     AND r.user_id = auth.uid()
    JOIN messages m
      ON m.conversation_id = c.id
     AND m.sender_type = 'customer'
     AND m.created_at > COALESCE(r.last_read_at, me.unread_since)
   WHERE c.last_inbound_at > COALESCE(r.last_read_at, me.unread_since)
     AND can_access_conversation(c.account_id, c.assigned_agent_id)
   GROUP BY c.id;
$$;

REVOKE ALL ON FUNCTION public.my_unread_counts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.my_unread_counts() TO authenticated;

-- ------------------------------------------------------------
-- Lido no celular da empresa
-- ------------------------------------------------------------
-- Recebe o id (do WhatsApp) da mensagem do cliente que foi lida e
-- deixa como não lidas só as mensagens do cliente que chegaram depois
-- dela. Nunca aumenta o contador.
CREATE OR REPLACE FUNCTION public.apply_phone_read(
  p_external_message_id TEXT,
  p_provider TEXT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r RECORD;
  v_left INTEGER;
BEGIN
  FOR r IN
    SELECT m.conversation_id, MAX(m.created_at) AS read_at
      FROM messages m
     WHERE m.message_id = p_external_message_id
       AND m.provider = p_provider
       AND m.sender_type = 'customer'
     GROUP BY m.conversation_id
  LOOP
    SELECT COUNT(*) INTO v_left
      FROM messages m
     WHERE m.conversation_id = r.conversation_id
       AND m.sender_type = 'customer'
       AND m.created_at > r.read_at;

    UPDATE conversations
       SET unread_count = LEAST(COALESCE(unread_count, 0), v_left)
     WHERE id = r.conversation_id
       AND COALESCE(unread_count, 0) > v_left;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_phone_read(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_phone_read(TEXT, TEXT) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_phone_read(TEXT, TEXT) TO service_role;
