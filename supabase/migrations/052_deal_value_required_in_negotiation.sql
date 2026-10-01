-- ============================================================
-- 052_deal_value_required_in_negotiation
--
-- Um negócio só pode entrar (ou ficar) na etapa de negociação com
-- valor maior que zero. O vendedor precisa informar o preço.
--
-- A regra vale pelo NOME da etapa: qualquer etapa cujo nome contenha
-- "negocia" (Negociação, Em negociação, Negociacao...). Assim ela vale
-- para todos os funis, inclusive os criados depois, sem configuração.
--
-- A tela já pede o valor antes de mover o card; esta trava no banco
-- garante o mesmo para a API pública e para as automações.
--
-- Negócios que JÁ estão em negociação sem valor não são alterados nem
-- bloqueados: a trava só age quando o negócio entra na etapa ou quando
-- alguém tenta zerar o valor dele lá dentro.
--
-- Segura de rodar mais de uma vez.
-- ============================================================

CREATE OR REPLACE FUNCTION stage_requires_deal_value(p_stage_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM pipeline_stages
     WHERE id = p_stage_id
       AND name ILIKE '%negocia%'
  );
$$;

CREATE OR REPLACE FUNCTION enforce_deal_value_in_negotiation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF COALESCE(NEW.value, 0) > 0 THEN
    RETURN NEW;
  END IF;

  -- Só quando o negócio entra na etapa ou o valor muda. Editar outro
  -- campo de um negócio antigo sem valor continua permitido.
  IF TG_OP = 'UPDATE'
     AND NEW.stage_id IS NOT DISTINCT FROM OLD.stage_id
     AND NEW.value IS NOT DISTINCT FROM OLD.value THEN
    RETURN NEW;
  END IF;

  IF stage_requires_deal_value(NEW.stage_id) THEN
    RAISE EXCEPTION 'deal_value_required'
      USING ERRCODE = 'check_violation',
            HINT = 'Informe o valor do negócio antes de colocá-lo em negociação.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_deal_value_in_negotiation ON deals;
CREATE TRIGGER trg_deal_value_in_negotiation
  BEFORE INSERT OR UPDATE OF stage_id, value ON deals
  FOR EACH ROW
  EXECUTE FUNCTION enforce_deal_value_in_negotiation();
