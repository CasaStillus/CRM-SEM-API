-- ============================================================
-- 053_lead_ownership_round_robin
--
-- Dono da conversa, roleta de leads e transferência.
--
-- 1. VISIBILIDADE
--    O atendente (account_role = 'agent') só enxerga as conversas
--    atribuídas a ele. Proprietário, administrador e visualizador
--    continuam enxergando todas. As mensagens e reações seguem a
--    mesma regra, porque as regras delas já consultam a tabela de
--    conversas (e o banco aplica a regra da conversa ali também).
--    Conversa sem dono fica só com o adm, até a roleta ou o adm
--    entregar para alguém.
--
-- 2. ROLETA
--    profiles.round_robin_enabled — o adm decide quem participa.
--    profiles.is_available        — o próprio usuário (ou o adm)
--                                   marca "indisponível" na folga.
--    assign_next_round_robin_agent() entrega a conversa para o
--    próximo da fila, em rodízio. Chamada pelo servidor quando chega
--    a mensagem de um lead novo (grupos não entram).
--
-- 3. TRANSFERÊNCIA
--    transfer_conversation() passa o lead para outro usuário e leva
--    junto os negócios abertos daquele contato.
--
-- Segura de rodar mais de uma vez.
-- ============================================================

-- ------------------------------------------------------------
-- Colunas da roleta
-- ------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'profiles'
       AND column_name = 'round_robin_enabled'
  ) THEN
    ALTER TABLE profiles
      ADD COLUMN round_robin_enabled BOOLEAN NOT NULL DEFAULT TRUE;
    -- Só na primeira vez: atendentes entram na roleta, adm e
    -- proprietário não. Depois disso quem decide é o adm.
    UPDATE profiles SET round_robin_enabled = (account_role = 'agent');
  END IF;
END $$;

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS is_available BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN profiles.round_robin_enabled IS
  'Participa da roleta de leads. Alterado pelo adm (set_member_round_robin). Migração 053.';
COMMENT ON COLUMN profiles.is_available IS
  'FALSE = indisponível (folga/ausente): a roleta pula este usuário. Migração 053.';

-- As duas colunas só mudam pelas funções abaixo, que conferem quem
-- pode mudar o quê. Sem isso, qualquer usuário poderia se colocar
-- ou se tirar da roleta editando o próprio perfil.
CREATE OR REPLACE FUNCTION public.enforce_profile_round_robin_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF (NEW.round_robin_enabled IS DISTINCT FROM OLD.round_robin_enabled
      OR NEW.is_available IS DISTINCT FROM OLD.is_available)
     AND current_user = 'authenticated'
  THEN
    RAISE EXCEPTION
      'round_robin_enabled and is_available change only through set_member_round_robin / set_member_availability'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_profile_round_robin_columns ON public.profiles;
CREATE TRIGGER enforce_profile_round_robin_columns
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.enforce_profile_round_robin_columns();

-- ------------------------------------------------------------
-- Quem pode ver uma conversa
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.can_access_conversation(
  p_account_id UUID,
  p_assigned_agent_id UUID
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM profiles p
     WHERE p.user_id = auth.uid()
       AND p.account_id = p_account_id
       AND (
         p.account_role IN ('owner', 'admin', 'viewer')
         OR (p_assigned_agent_id IS NOT NULL
             AND p_assigned_agent_id = auth.uid())
       )
  );
$$;

REVOKE ALL ON FUNCTION public.can_access_conversation(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_access_conversation(UUID, UUID)
  TO authenticated, service_role;

DROP POLICY IF EXISTS conversations_select ON conversations;
DROP POLICY IF EXISTS conversations_update ON conversations;
DROP POLICY IF EXISTS conversations_delete ON conversations;

CREATE POLICY conversations_select ON conversations FOR SELECT
  USING (can_access_conversation(account_id, assigned_agent_id));

-- USING: só mexe em conversa que enxerga. WITH CHECK: o resultado
-- pode ficar com outra pessoa — é isso que permite transferir.
CREATE POLICY conversations_update ON conversations FOR UPDATE
  USING (
    is_account_member(account_id, 'agent')
    AND can_access_conversation(account_id, assigned_agent_id)
  )
  WITH CHECK (is_account_member(account_id, 'agent'));

CREATE POLICY conversations_delete ON conversations FOR DELETE
  USING (
    is_account_member(account_id, 'agent')
    AND can_access_conversation(account_id, assigned_agent_id)
  );

-- Conversa aberta por um atendente (pela lista de contatos) já nasce
-- dele; sem isso ela sumiria da tela dele no mesmo instante.
CREATE OR REPLACE FUNCTION public.default_conversation_owner()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.assigned_agent_id IS NULL AND auth.uid() IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM profiles
       WHERE user_id = auth.uid()
         AND account_id = NEW.account_id
         AND account_role = 'agent'
    ) THEN
      NEW.assigned_agent_id := auth.uid();
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS default_conversation_owner ON conversations;
CREATE TRIGGER default_conversation_owner
  BEFORE INSERT ON conversations
  FOR EACH ROW EXECUTE FUNCTION public.default_conversation_owner();

-- ------------------------------------------------------------
-- Roleta
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lead_rotation_state (
  account_id UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  last_user_id UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE lead_rotation_state ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE lead_rotation_state IS
  'Último usuário que recebeu lead pela roleta, por conta. Sem policies: só o servidor lê e grava. Migração 053.';

/**
 * Entrega a conversa ao próximo usuário da roleta.
 *
 * Devolve o user_id escolhido, ou NULL quando a conversa já tem dono,
 * é de um grupo, ou ninguém está disponível (aí ela fica com o adm).
 * A trava na linha de estado da conta garante que dois leads chegando
 * juntos não caiam na mesma pessoa por engano.
 */
CREATE OR REPLACE FUNCTION public.assign_next_round_robin_agent(
  p_conversation_id UUID
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
  v_assigned UUID;
  v_is_group BOOLEAN;
  v_last UUID;
  v_last_created TIMESTAMPTZ;
  v_next UUID;
BEGIN
  SELECT c.account_id, c.assigned_agent_id, COALESCE(ct.is_group, FALSE)
    INTO v_account_id, v_assigned, v_is_group
    FROM conversations c
    LEFT JOIN contacts ct ON ct.id = c.contact_id
   WHERE c.id = p_conversation_id
   FOR UPDATE OF c;

  IF v_account_id IS NULL OR v_assigned IS NOT NULL OR v_is_group THEN
    RETURN NULL;
  END IF;

  INSERT INTO lead_rotation_state (account_id)
  VALUES (v_account_id)
  ON CONFLICT (account_id) DO NOTHING;

  SELECT last_user_id INTO v_last
    FROM lead_rotation_state
   WHERE account_id = v_account_id
   FOR UPDATE;

  SELECT created_at INTO v_last_created
    FROM profiles
   WHERE user_id = v_last AND account_id = v_account_id;

  -- O próximo depois do último que recebeu; se ninguém vier depois,
  -- volta para o primeiro da fila.
  SELECT p.user_id INTO v_next
    FROM profiles p
   WHERE p.account_id = v_account_id
     AND p.round_robin_enabled
     AND p.is_available
     AND p.account_role IN ('owner', 'admin', 'agent')
   ORDER BY
     CASE
       WHEN v_last_created IS NULL THEN 0
       WHEN (p.created_at, p.user_id) > (v_last_created, v_last) THEN 0
       ELSE 1
     END,
     p.created_at,
     p.user_id
   LIMIT 1;

  IF v_next IS NULL THEN
    RETURN NULL;
  END IF;

  UPDATE conversations
     SET assigned_agent_id = v_next,
         updated_at = NOW()
   WHERE id = p_conversation_id;

  UPDATE lead_rotation_state
     SET last_user_id = v_next,
         updated_at = NOW()
   WHERE account_id = v_account_id;

  RETURN v_next;
END;
$$;

REVOKE ALL ON FUNCTION public.assign_next_round_robin_agent(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assign_next_round_robin_agent(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.assign_next_round_robin_agent(UUID) TO service_role;

-- ------------------------------------------------------------
-- Disponibilidade e participação na roleta
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_member_availability(
  p_user_id UUID,
  p_available BOOLEAN
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
BEGIN
  SELECT account_id INTO v_account_id FROM profiles WHERE user_id = p_user_id;
  IF v_account_id IS NULL THEN
    RAISE EXCEPTION 'member_not_found' USING ERRCODE = 'no_data_found';
  END IF;

  -- A própria pessoa, ou um adm da mesma conta.
  IF p_user_id IS DISTINCT FROM auth.uid()
     AND NOT is_account_member(v_account_id, 'admin') THEN
    RAISE EXCEPTION 'not_allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE profiles SET is_available = p_available WHERE user_id = p_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.set_member_availability(UUID, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_member_availability(UUID, BOOLEAN)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.set_member_round_robin(
  p_user_id UUID,
  p_enabled BOOLEAN
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
BEGIN
  SELECT account_id INTO v_account_id FROM profiles WHERE user_id = p_user_id;
  IF v_account_id IS NULL THEN
    RAISE EXCEPTION 'member_not_found' USING ERRCODE = 'no_data_found';
  END IF;

  IF NOT is_account_member(v_account_id, 'admin') THEN
    RAISE EXCEPTION 'not_allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE profiles SET round_robin_enabled = p_enabled WHERE user_id = p_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.set_member_round_robin(UUID, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_member_round_robin(UUID, BOOLEAN)
  TO authenticated, service_role;

-- ------------------------------------------------------------
-- Transferência
-- ------------------------------------------------------------
/**
 * Passa a conversa para outro usuário (ou devolve para o adm, com
 * p_to_user_id NULL) e leva junto os negócios abertos do contato.
 *
 * Quem chama precisa enxergar a conversa: o atendente só transfere o
 * que é dele; o adm transfere qualquer uma.
 */
CREATE OR REPLACE FUNCTION public.transfer_conversation(
  p_conversation_id UUID,
  p_to_user_id UUID
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
  v_assigned UUID;
  v_contact_id UUID;
  v_target_profile_id UUID;
BEGIN
  SELECT account_id, assigned_agent_id, contact_id
    INTO v_account_id, v_assigned, v_contact_id
    FROM conversations
   WHERE id = p_conversation_id
   FOR UPDATE;

  IF v_account_id IS NULL
     OR NOT is_account_member(v_account_id, 'agent')
     OR NOT can_access_conversation(v_account_id, v_assigned) THEN
    RAISE EXCEPTION 'conversation_not_found' USING ERRCODE = 'no_data_found';
  END IF;

  IF p_to_user_id IS NOT NULL THEN
    SELECT id INTO v_target_profile_id
      FROM profiles
     WHERE user_id = p_to_user_id AND account_id = v_account_id;
    IF v_target_profile_id IS NULL THEN
      RAISE EXCEPTION 'target_not_member' USING ERRCODE = 'no_data_found';
    END IF;
  END IF;

  UPDATE conversations
     SET assigned_agent_id = p_to_user_id,
         updated_at = NOW()
   WHERE id = p_conversation_id;

  -- Os negócios abertos do mesmo contato acompanham o lead.
  UPDATE deals
     SET assigned_to = v_target_profile_id,
         updated_at = NOW()
   WHERE account_id = v_account_id
     AND status = 'open'
     AND (conversation_id = p_conversation_id
          OR (v_contact_id IS NOT NULL AND contact_id = v_contact_id));
END;
$$;

REVOKE ALL ON FUNCTION public.transfer_conversation(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.transfer_conversation(UUID, UUID)
  TO authenticated, service_role;

-- ------------------------------------------------------------
-- Aviso de lead recebido, em português
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION notify_conversation_assigned()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_contact_name TEXT;
  v_actor_name TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.assigned_agent_id IS NULL THEN
      RETURN NEW;
    END IF;
  ELSE
    IF NEW.assigned_agent_id IS NULL
       OR NEW.assigned_agent_id IS NOT DISTINCT FROM OLD.assigned_agent_id THEN
      RETURN NEW;
    END IF;
  END IF;

  IF auth.uid() IS NOT NULL AND auth.uid() = NEW.assigned_agent_id THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(NULLIF(name, ''), phone) INTO v_contact_name
    FROM contacts WHERE id = NEW.contact_id;

  IF auth.uid() IS NOT NULL THEN
    SELECT full_name INTO v_actor_name
      FROM profiles WHERE user_id = auth.uid();
  END IF;

  INSERT INTO notifications (
    account_id, user_id, type, conversation_id, contact_id,
    actor_user_id, title, body
  ) VALUES (
    NEW.account_id,
    NEW.assigned_agent_id,
    'conversation_assigned',
    NEW.id,
    NEW.contact_id,
    auth.uid(),
    CASE WHEN auth.uid() IS NULL THEN 'Novo lead para você'
         ELSE 'Lead transferido para você' END,
    CASE WHEN auth.uid() IS NULL
         THEN 'A roleta enviou o lead ' || COALESCE(v_contact_name, 'sem nome') || ' para você.'
         ELSE COALESCE(v_actor_name, 'Alguém') || ' passou o lead '
              || COALESCE(v_contact_name, 'sem nome') || ' para você.'
    END
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to create assignment notification for conversation %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;
