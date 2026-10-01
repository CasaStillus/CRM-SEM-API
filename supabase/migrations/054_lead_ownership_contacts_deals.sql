-- ============================================================
-- 054 — Vendedor vê só os próprios contatos e negociações
-- ============================================================
--
-- Continuação da 053. Lá as conversas passaram a ser de quem está
-- atendendo; aqui Contatos e Pipeline seguem a mesma regra.
--
-- Dono, administrador e visualizador continuam vendo tudo.
--
-- O atendente (vendedor) vê um CONTATO quando:
--   • tem uma conversa com esse contato atribuída a ele; ou
--   • tem uma negociação desse contato atribuída a ele; ou
--   • foi ele quem cadastrou o contato (manual ou importação).
--
-- O atendente vê uma NEGOCIAÇÃO quando:
--   • ela está atribuída a ele; ou
--   • ela não tem responsável e foi ele quem criou, ou a conversa
--     desse contato está com ele.
--
-- Para que nada "suma", negociações sem responsável passam a herdar o
-- dono da conversa:
--   • ao criar a negociação (formulário, automação ou API);
--   • quando a roleta ou alguém atribui/transfere a conversa;
--   • uma vez agora, para as negociações abertas que já existem.
--
-- Notas do contato, etiquetas e campos personalizados seguem o contato.
--
-- Pode ser executada mais de uma vez sem problema.
-- ============================================================

-- Índices para as checagens abaixo ficarem rápidas.
CREATE INDEX IF NOT EXISTS idx_conversations_contact_agent
  ON conversations (contact_id, assigned_agent_id);
CREATE INDEX IF NOT EXISTS idx_deals_contact_id
  ON deals (contact_id);

-- ------------------------------------------------------------
-- Quem pode ver um contato
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.can_access_contact(
  p_account_id UUID,
  p_contact_id UUID,
  p_created_by UUID
) RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_role TEXT;
  v_profile UUID;
BEGIN
  IF v_uid IS NULL THEN
    RETURN FALSE;
  END IF;

  SELECT p.account_role::text, p.id
    INTO v_role, v_profile
    FROM profiles p
   WHERE p.user_id = v_uid
     AND p.account_id = p_account_id;

  IF v_role IS NULL THEN
    RETURN FALSE;
  END IF;
  IF v_role IN ('owner', 'admin', 'viewer') THEN
    RETURN TRUE;
  END IF;
  IF p_created_by = v_uid THEN
    RETURN TRUE;
  END IF;

  RETURN EXISTS (
           SELECT 1 FROM conversations c
            WHERE c.contact_id = p_contact_id
              AND c.assigned_agent_id = v_uid
         )
      OR EXISTS (
           SELECT 1 FROM deals d
            WHERE d.contact_id = p_contact_id
              AND d.assigned_to = v_profile
         );
END;
$$;

REVOKE ALL ON FUNCTION public.can_access_contact(UUID, UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_access_contact(UUID, UUID, UUID)
  TO authenticated, service_role;

-- ------------------------------------------------------------
-- Quem pode ver uma negociação
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.can_access_deal(
  p_account_id UUID,
  p_assigned_to UUID,
  p_created_by UUID,
  p_contact_id UUID,
  p_conversation_id UUID
) RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_role TEXT;
  v_profile UUID;
BEGIN
  IF v_uid IS NULL THEN
    RETURN FALSE;
  END IF;

  SELECT p.account_role::text, p.id
    INTO v_role, v_profile
    FROM profiles p
   WHERE p.user_id = v_uid
     AND p.account_id = p_account_id;

  IF v_role IS NULL THEN
    RETURN FALSE;
  END IF;
  IF v_role IN ('owner', 'admin', 'viewer') THEN
    RETURN TRUE;
  END IF;

  -- Com responsável: só o responsável.
  IF p_assigned_to IS NOT NULL THEN
    RETURN p_assigned_to = v_profile;
  END IF;

  -- Sem responsável: quem criou, ou quem está com a conversa.
  IF p_created_by = v_uid THEN
    RETURN TRUE;
  END IF;

  RETURN EXISTS (
    SELECT 1 FROM conversations c
     WHERE c.assigned_agent_id = v_uid
       AND (c.id = p_conversation_id OR c.contact_id = p_contact_id)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.can_access_deal(UUID, UUID, UUID, UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_access_deal(UUID, UUID, UUID, UUID, UUID)
  TO authenticated, service_role;

-- ------------------------------------------------------------
-- Políticas: contatos
-- ------------------------------------------------------------
DROP POLICY IF EXISTS contacts_select ON contacts;
DROP POLICY IF EXISTS contacts_update ON contacts;
DROP POLICY IF EXISTS contacts_delete ON contacts;

CREATE POLICY contacts_select ON contacts FOR SELECT
  USING (can_access_contact(account_id, id, user_id));

CREATE POLICY contacts_update ON contacts FOR UPDATE
  USING (
    is_account_member(account_id, 'agent')
    AND can_access_contact(account_id, id, user_id)
  )
  WITH CHECK (is_account_member(account_id, 'agent'));

CREATE POLICY contacts_delete ON contacts FOR DELETE
  USING (
    is_account_member(account_id, 'agent')
    AND can_access_contact(account_id, id, user_id)
  );

-- Contato cadastrado por um atendente fica registrado no nome dele,
-- senão ele sumiria da lista dele assim que fosse salvo.
CREATE OR REPLACE FUNCTION public.default_contact_creator()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- auth.uid() só existe para quem está logado no CRM; servidor,
  -- automações e API chegam sem ele e ficam como estão.
  IF auth.uid() IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM profiles p
       WHERE p.user_id = auth.uid()
         AND p.account_id = NEW.account_id
         AND p.account_role::text = 'agent'
    ) THEN
      NEW.user_id := auth.uid();
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_default_contact_creator ON contacts;
CREATE TRIGGER trg_default_contact_creator
  BEFORE INSERT ON contacts
  FOR EACH ROW EXECUTE FUNCTION public.default_contact_creator();

-- ------------------------------------------------------------
-- Políticas: negociações
-- ------------------------------------------------------------
DROP POLICY IF EXISTS deals_select ON deals;
DROP POLICY IF EXISTS deals_update ON deals;
DROP POLICY IF EXISTS deals_delete ON deals;

CREATE POLICY deals_select ON deals FOR SELECT
  USING (can_access_deal(account_id, assigned_to, user_id, contact_id, conversation_id));

-- USING: só mexe no que enxerga. WITH CHECK: pode passar para outra
-- pessoa (trocar o responsável é uma transferência).
CREATE POLICY deals_update ON deals FOR UPDATE
  USING (
    is_account_member(account_id, 'agent')
    AND can_access_deal(account_id, assigned_to, user_id, contact_id, conversation_id)
  )
  WITH CHECK (is_account_member(account_id, 'agent'));

CREATE POLICY deals_delete ON deals FOR DELETE
  USING (
    is_account_member(account_id, 'agent')
    AND can_access_deal(account_id, assigned_to, user_id, contact_id, conversation_id)
  );

-- Trocar o responsável de uma negociação. Precisa ser uma função porque,
-- para o atendente, a negociação deixa de ser visível no mesmo instante
-- e o banco recusaria a edição comum. Quem chama precisa enxergar a
-- negociação; o novo responsável precisa ser da mesma conta (ou NULL
-- para deixar sem responsável).
CREATE OR REPLACE FUNCTION public.transfer_deal(
  p_deal_id UUID,
  p_to_profile_id UUID
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deal deals%ROWTYPE;
BEGIN
  SELECT * INTO v_deal FROM deals WHERE id = p_deal_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'deal_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF NOT is_account_member(v_deal.account_id, 'agent')
     OR NOT can_access_deal(v_deal.account_id, v_deal.assigned_to,
                            v_deal.user_id, v_deal.contact_id,
                            v_deal.conversation_id) THEN
    RAISE EXCEPTION 'not_allowed' USING ERRCODE = '42501';
  END IF;

  IF p_to_profile_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM profiles p
     WHERE p.id = p_to_profile_id
       AND p.account_id = v_deal.account_id
  ) THEN
    RAISE EXCEPTION 'target_not_member' USING ERRCODE = '22023';
  END IF;

  UPDATE deals
     SET assigned_to = p_to_profile_id,
         updated_at = NOW()
   WHERE id = p_deal_id;
END;
$$;

REVOKE ALL ON FUNCTION public.transfer_deal(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.transfer_deal(UUID, UUID)
  TO authenticated, service_role;

-- Negociação criada sem responsável:
--   • criada por um atendente → fica com ele;
--   • criada por admin, automação ou API → fica com quem está com a
--     conversa do contato, se houver.
CREATE OR REPLACE FUNCTION public.default_deal_owner()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_profile UUID;
BEGIN
  IF NEW.assigned_to IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF auth.uid() IS NOT NULL THEN
    SELECT p.id INTO v_profile
      FROM profiles p
     WHERE p.user_id = auth.uid()
       AND p.account_id = NEW.account_id
       AND p.account_role::text = 'agent';
  END IF;

  IF v_profile IS NULL THEN
    SELECT p.id INTO v_profile
      FROM conversations c
      JOIN profiles p
        ON p.user_id = c.assigned_agent_id
       AND p.account_id = NEW.account_id
     WHERE c.account_id = NEW.account_id
       AND c.assigned_agent_id IS NOT NULL
       AND (
         c.id = NEW.conversation_id
         OR (NEW.contact_id IS NOT NULL AND c.contact_id = NEW.contact_id)
       )
     ORDER BY (c.id = NEW.conversation_id) DESC NULLS LAST,
              c.last_message_at DESC NULLS LAST
     LIMIT 1;
  END IF;

  NEW.assigned_to := v_profile;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_default_deal_owner ON deals;
CREATE TRIGGER trg_default_deal_owner
  BEFORE INSERT ON deals
  FOR EACH ROW EXECUTE FUNCTION public.default_deal_owner();

-- Conversa recebeu dono (roleta, atribuição ou transferência):
-- negociações abertas e sem responsável desse contato vão junto.
CREATE OR REPLACE FUNCTION public.sync_open_deals_owner()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_profile UUID;
BEGIN
  IF NEW.assigned_agent_id IS NULL OR NEW.contact_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW.assigned_agent_id IS NOT DISTINCT FROM OLD.assigned_agent_id THEN
    RETURN NEW;
  END IF;

  SELECT p.id INTO v_profile
    FROM profiles p
   WHERE p.user_id = NEW.assigned_agent_id
     AND p.account_id = NEW.account_id;

  IF v_profile IS NOT NULL THEN
    UPDATE deals
       SET assigned_to = v_profile,
           updated_at = NOW()
     WHERE account_id = NEW.account_id
       AND contact_id = NEW.contact_id
       AND status = 'open'
       AND assigned_to IS NULL;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_open_deals_owner ON conversations;
CREATE TRIGGER trg_sync_open_deals_owner
  AFTER INSERT OR UPDATE OF assigned_agent_id ON conversations
  FOR EACH ROW EXECUTE FUNCTION public.sync_open_deals_owner();

-- Uma vez agora: negociações abertas sem responsável herdam o dono da
-- conversa mais recente do contato.
UPDATE deals d
   SET assigned_to = owner.profile_id,
       updated_at = NOW()
  FROM (
    SELECT DISTINCT ON (c.account_id, c.contact_id)
           c.account_id, c.contact_id, p.id AS profile_id
      FROM conversations c
      JOIN profiles p
        ON p.user_id = c.assigned_agent_id
       AND p.account_id = c.account_id
     WHERE c.assigned_agent_id IS NOT NULL
       AND c.contact_id IS NOT NULL
     ORDER BY c.account_id, c.contact_id, c.last_message_at DESC NULLS LAST
  ) owner
 WHERE d.account_id = owner.account_id
   AND d.contact_id = owner.contact_id
   AND d.status = 'open'
   AND d.assigned_to IS NULL;

-- ------------------------------------------------------------
-- Notas do contato seguem o contato
-- ------------------------------------------------------------
DROP POLICY IF EXISTS contact_notes_select ON contact_notes;
DROP POLICY IF EXISTS contact_notes_insert ON contact_notes;
DROP POLICY IF EXISTS contact_notes_update ON contact_notes;
DROP POLICY IF EXISTS contact_notes_delete ON contact_notes;

CREATE POLICY contact_notes_select ON contact_notes FOR SELECT
  USING (
    is_account_member(account_id)
    AND EXISTS (SELECT 1 FROM contacts c WHERE c.id = contact_notes.contact_id)
  );
CREATE POLICY contact_notes_insert ON contact_notes FOR INSERT
  WITH CHECK (
    is_account_member(account_id, 'agent')
    AND EXISTS (SELECT 1 FROM contacts c WHERE c.id = contact_notes.contact_id)
  );
CREATE POLICY contact_notes_update ON contact_notes FOR UPDATE
  USING (
    is_account_member(account_id, 'agent')
    AND EXISTS (SELECT 1 FROM contacts c WHERE c.id = contact_notes.contact_id)
  );
CREATE POLICY contact_notes_delete ON contact_notes FOR DELETE
  USING (
    is_account_member(account_id, 'agent')
    AND EXISTS (SELECT 1 FROM contacts c WHERE c.id = contact_notes.contact_id)
  );

-- Etiquetas e campos personalizados já consultam `contacts` nas próprias
-- políticas, então passam a seguir a mesma regra automaticamente.
