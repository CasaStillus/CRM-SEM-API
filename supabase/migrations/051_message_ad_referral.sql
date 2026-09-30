-- ============================================================
-- 051_message_ad_referral
--
-- Guarda o anúncio que o lead clicou antes de escrever (anúncios de
-- "Enviar mensagem" no Facebook e no Instagram). O WhatsApp mostra
-- esse anúncio como um cartão com foto, título e texto em cima da
-- primeira mensagem; a caixa de entrada do CRM passa a mostrar o mesmo.
--
-- Uma coluna JSONB só, preenchida apenas nas mensagens que vieram de
-- anúncio. As demais continuam NULL. Formato:
--
--   {
--     "source":        "meta_referral" | "uazapi_external_ad_reply" | "uazapi_signal",
--     "source_type":   "ad" | "post",
--     "source_id":     "<id do anúncio>",
--     "source_url":    "https://fb.me/...",
--     "title":         "<título do anúncio>",
--     "body":          "<texto do anúncio>",
--     "media_type":    "image" | "video",
--     "thumbnail_url": "<cópia no chat-media, ou o link do provedor>",
--     "media_url":     "<link do provedor>",
--     "ctwa_clid":     "<id do clique>",
--     "raw":           { ...cópia higienizada do que o provedor mandou }
--   }
--
-- Segura de rodar mais de uma vez. Pode rodar antes ou depois do
-- deploy: o código novo só escreve a coluna quando há anúncio, e se a
-- coluna ainda não existir ele guarda a mensagem sem o cartão.
-- ============================================================

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS ad_referral JSONB;

COMMENT ON COLUMN messages.ad_referral IS
  'Anúncio de clique para o WhatsApp que originou a mensagem (título, texto, foto, link). NULL quando a mensagem não veio de anúncio. Migração 051.';

-- Para relatórios de "quais anúncios trazem leads": só as linhas que
-- têm anúncio entram no índice.
CREATE INDEX IF NOT EXISTS idx_messages_ad_referral_source_id
  ON messages ((ad_referral->>'source_id'))
  WHERE ad_referral IS NOT NULL;
