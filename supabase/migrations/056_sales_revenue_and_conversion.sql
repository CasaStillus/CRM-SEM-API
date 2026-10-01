-- ============================================================
-- 056 — Faturamento por período e conversão por vendedor
-- ============================================================
--
-- 1. `deals.closed_at`: quando a negociação foi marcada como ganha ou
--    perdida. Faturamento = soma das negociações GANHAS com `closed_at`
--    dentro do período. Mantido por gatilho, então vale para o quadro,
--    o formulário, automações e API. Se a negociação for reaberta, a
--    data é apagada; se for fechada de novo, conta a nova data.
--    Negociações já fechadas antes desta migração recebem a data da
--    última alteração (`updated_at`), que é a melhor estimativa.
--
-- 2. `sales_by_seller(de, até)`: por vendedor, no período —
--      leads     = conversas novas (sem grupos) que estão com ele
--      won/lost  = negociações ganhas / perdidas
--      revenue   = soma das ganhas
--    Roda com as permissões de quem chama: o vendedor só enxerga os
--    próprios números; admin e dono enxergam todos.
--
-- Pode ser executada mais de uma vez sem problema.
-- ============================================================

ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_deals_closed_at
  ON deals (account_id, closed_at)
  WHERE status IN ('won', 'lost');

CREATE OR REPLACE FUNCTION public.track_deal_closed_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IN ('won', 'lost') THEN
    IF TG_OP = 'INSERT' THEN
      NEW.closed_at := COALESCE(NEW.closed_at, NOW());
    ELSIF OLD.status IS DISTINCT FROM NEW.status THEN
      -- Acabou de ser fechada (ou trocou de ganha para perdida).
      NEW.closed_at := NOW();
    ELSE
      -- Continua fechada: mantém a data (editar o valor não muda o mês).
      NEW.closed_at := COALESCE(NEW.closed_at, OLD.closed_at, NOW());
    END IF;
  ELSE
    NEW.closed_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_track_deal_closed_at ON deals;
CREATE TRIGGER trg_track_deal_closed_at
  BEFORE INSERT OR UPDATE ON deals
  FOR EACH ROW EXECUTE FUNCTION public.track_deal_closed_at();

-- Negociações que já estavam fechadas.
UPDATE deals
   SET closed_at = COALESCE(updated_at, created_at, NOW())
 WHERE status IN ('won', 'lost')
   AND closed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_account_created
  ON conversations (account_id, created_at);

-- ------------------------------------------------------------
-- Números por vendedor no período [p_from, p_to)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sales_by_seller(
  p_from TIMESTAMPTZ,
  p_to TIMESTAMPTZ
) RETURNS TABLE (
  user_id UUID,
  profile_id UUID,
  full_name TEXT,
  leads BIGINT,
  won BIGINT,
  lost BIGINT,
  revenue NUMERIC
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH me AS (
    SELECT p.account_id FROM profiles p WHERE p.user_id = auth.uid()
  ),
  members AS (
    SELECT p.id AS profile_id, p.user_id, p.full_name
      FROM profiles p
      JOIN me ON p.account_id = me.account_id
  ),
  d AS (
    SELECT dl.assigned_to,
           COUNT(*) FILTER (WHERE dl.status = 'won')  AS won,
           COUNT(*) FILTER (WHERE dl.status = 'lost') AS lost,
           COALESCE(SUM(dl.value) FILTER (WHERE dl.status = 'won'), 0) AS revenue
      FROM deals dl
      JOIN me ON dl.account_id = me.account_id
     WHERE dl.status IN ('won', 'lost')
       AND dl.closed_at >= p_from
       AND dl.closed_at <  p_to
     GROUP BY dl.assigned_to
  ),
  l AS (
    SELECT c.assigned_agent_id, COUNT(*) AS leads
      FROM conversations c
      JOIN me ON c.account_id = me.account_id
      LEFT JOIN contacts ct ON ct.id = c.contact_id
     WHERE c.created_at >= p_from
       AND c.created_at <  p_to
       AND COALESCE(ct.is_group, FALSE) = FALSE
     GROUP BY c.assigned_agent_id
  )
  SELECT m.user_id, m.profile_id, m.full_name,
         COALESCE(l.leads, 0), COALESCE(d.won, 0), COALESCE(d.lost, 0),
         COALESCE(d.revenue, 0)
    FROM members m
    LEFT JOIN d ON d.assigned_to = m.profile_id
    LEFT JOIN l ON l.assigned_agent_id = m.user_id
  UNION ALL
  -- Sem responsável (só aparece para quem enxerga tudo).
  SELECT NULL, NULL, NULL,
         COALESCE((SELECT leads FROM l WHERE assigned_agent_id IS NULL), 0),
         COALESCE((SELECT won FROM d WHERE assigned_to IS NULL), 0),
         COALESCE((SELECT lost FROM d WHERE assigned_to IS NULL), 0),
         COALESCE((SELECT revenue FROM d WHERE assigned_to IS NULL), 0);
$$;

REVOKE ALL ON FUNCTION public.sales_by_seller(TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sales_by_seller(TIMESTAMPTZ, TIMESTAMPTZ)
  TO authenticated;
