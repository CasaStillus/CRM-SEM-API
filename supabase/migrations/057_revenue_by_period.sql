-- ============================================================
-- 057 — Faturamento por dia, semana ou mês em qualquer período
-- ============================================================
--
-- 1. `revenue_by_period(de, até, agrupamento, fuso, funil)`
--    Soma das negociações GANHAS com `closed_at` (migração 056) no
--    período, separada por dia, semana (começa na segunda) ou mês, no
--    fuso de quem está olhando. `funil` é opcional: sem ele, conta
--    todos os funis.
--    Roda com as permissões de quem chama: o vendedor só soma as
--    negociações dele; admin e dono somam todas.
--
-- 2. Arrastar o card para a etapa "Ganho" conta como venda
--    Até aqui, só o botão "Marcar como ganho" mudava o status. Agora,
--    ao entrar numa etapa cujo nome começa com Ganho/Ganha/Won/Vendido,
--    a negociação vira GANHA; numa etapa Perdido/Perdida/Lost, vira
--    PERDIDA. Ao sair de uma dessas etapas para uma etapa comum, volta
--    a ficar aberta. Só reage a mudança de etapa: os botões
--    Ganho/Perdido/Reabrir continuam funcionando como antes.
--
-- Requer a 056. Pode ser executada mais de uma vez sem problema.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Faturamento por período
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.revenue_by_period(
  p_from TIMESTAMPTZ,
  p_to TIMESTAMPTZ,
  p_bucket TEXT DEFAULT 'day',
  p_tz TEXT DEFAULT 'America/Sao_Paulo',
  p_pipeline_id UUID DEFAULT NULL
) RETURNS TABLE (
  bucket DATE,
  won BIGINT,
  revenue NUMERIC
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH cfg AS (
    SELECT
      CASE WHEN p_bucket IN ('day', 'week', 'month') THEN p_bucket ELSE 'day' END AS unit,
      COALESCE(
        (SELECT name FROM pg_timezone_names WHERE name = p_tz LIMIT 1),
        'America/Sao_Paulo'
      ) AS tz
  )
  SELECT date_trunc(cfg.unit, d.closed_at AT TIME ZONE cfg.tz)::date AS bucket,
         COUNT(*) AS won,
         COALESCE(SUM(d.value), 0) AS revenue
    FROM deals d
   CROSS JOIN cfg
   WHERE d.status = 'won'
     AND d.closed_at >= p_from
     AND d.closed_at <  p_to
     AND (p_pipeline_id IS NULL OR d.pipeline_id = p_pipeline_id)
   GROUP BY 1
   ORDER BY 1;
$$;

REVOKE ALL ON FUNCTION public.revenue_by_period(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.revenue_by_period(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, UUID)
  TO authenticated;

-- ------------------------------------------------------------
-- 2. Etapa Ganho / Perdido muda o status
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.deal_stage_outcome(p_stage_id UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
           WHEN s.name ~* '^\s*(ganh|won|vendid)' THEN 'won'
           WHEN s.name ~* '^\s*(perd|lost)'       THEN 'lost'
           ELSE NULL
         END
    FROM pipeline_stages s
   WHERE s.id = p_stage_id;
$$;

CREATE OR REPLACE FUNCTION public.sync_deal_status_from_stage()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_new TEXT;
  v_old TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.stage_id IS NOT DISTINCT FROM OLD.stage_id THEN
    RETURN NEW;
  END IF;

  v_new := deal_stage_outcome(NEW.stage_id);

  IF v_new IS NOT NULL THEN
    NEW.status := v_new;
  ELSIF TG_OP = 'UPDATE' THEN
    v_old := deal_stage_outcome(OLD.stage_id);
    -- Saiu de Ganho/Perdido para uma etapa comum: volta a ficar aberta.
    IF v_old IS NOT NULL AND NEW.status = v_old THEN
      NEW.status := 'open';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- O nome faz este gatilho rodar ANTES do que grava `closed_at` (056):
-- o PostgreSQL executa gatilhos BEFORE em ordem alfabética.
DROP TRIGGER IF EXISTS trg_sync_deal_status_from_stage ON deals;
CREATE TRIGGER trg_sync_deal_status_from_stage
  BEFORE INSERT OR UPDATE OF stage_id ON deals
  FOR EACH ROW EXECUTE FUNCTION public.sync_deal_status_from_stage();

-- ------------------------------------------------------------
-- 3. Uma vez agora: cards que já estão em Ganho/Perdido
-- ------------------------------------------------------------
-- Negociações abertas paradas numa etapa Ganho/Perdido passam a ganha/
-- perdida, com a data da última alteração delas (não a de hoje), para
-- caírem no mês certo do faturamento.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT d.id,
           deal_stage_outcome(d.stage_id) AS outcome,
           COALESCE(d.updated_at, d.created_at, NOW()) AS at
      FROM deals d
     WHERE d.status = 'open'
       AND deal_stage_outcome(d.stage_id) IS NOT NULL
  LOOP
    UPDATE deals SET status = r.outcome WHERE id = r.id;
    -- Mesmo status agora: o gatilho da 056 mantém a data informada aqui.
    UPDATE deals SET closed_at = r.at WHERE id = r.id;
  END LOOP;
END;
$$;
