# Integração do Instagram Direct — Design

## Objetivo

Permitir que mensagens diretas (DM) do Instagram cheguem na inbox do wacrm
e que o atendente responda pelo próprio CRM, como já acontece com o
WhatsApp — mas como um canal totalmente independente, em uma aba própria
da inbox.

## Escopo da v1

- Receber e responder Instagram Direct (texto e mídia) pela inbox do CRM.
- Aba própria "Instagram" na inbox, separada da aba "WhatsApp".
- Contatos do Instagram são registros independentes dos contatos do
  WhatsApp — nenhuma tentativa de unificar por pessoa.
- Uma conta Instagram Profissional conectada por conta wacrm (mesmo
  padrão do `whatsapp_config`: uma linha por `account_id`).
- Conta Instagram Profissional já vinculada a uma Página do Facebook, com
  Meta App já criado pelo usuário — **fora de escopo** orientar esse setup.

## Fora de escopo (v1)

- Automações, Flows (bot visual) e resposta automática com IA para
  Instagram — inbox manual apenas.
- Comentários em posts e menções em stories como itens de inbox (o
  atributo `story_mention` que chega dentro de uma DM é exibido, mas não
  há moderação de comentários).
- Templates/broadcasts (Instagram não tem equivalente aos templates
  aprovados do WhatsApp; fora da janela de 24h só existem "message tags"
  restritas a casos que não cabem num CRM genérico).
- Ice breakers, menu persistente, product template, Handover Protocol,
  API de conversas moderadas.
- Onboarding do Meta App / vínculo da conta Instagram à Página — o
  usuário já tem isso pronto.

## Por que este canal é independente do WhatsApp/UAZAPI

O WhatsApp deste deployment vai rodar via UAZAPI (API não-oficial), não
pela Cloud API oficial da Meta. O Instagram Direct só existe via API
oficial da Meta (Instagram Messaging API), então esta integração é
tecnicamente desacoplada de qual provedor o WhatsApp está usando — ela
não depende do trabalho em `.worktrees/uazapi-whatsapp-provider` nem o
modifica. As duas integrações compartilham apenas utilitários genéricos
já existentes (criptografia AES-256-GCM, verificação de assinatura HMAC
de webhook da Meta, rate limiter, `requireRole`).

## Referência da API (lida em
developers.facebook.com/documentation/business-messaging/instagram-messaging)

- **Auth**: token de usuário (Facebook Login, permissões
  `instagram_basic`, `instagram_manage_messages`, `pages_manage_metadata`)
  → Page Access Token via `GET /{page-id}?fields=access_token`. Token de
  usuário de longa duração ⇒ Page Access Token sem expiração.
- **Enviar mensagem**: `POST /me/messages?access_token=<PAGE_TOKEN>` com
  `{recipient: {id: IGSID}, message: {text | attachment}}`. Texto até
  1000 caracteres. Anexos por URL (imagem/vídeo/áudio/arquivo, limites de
  8–25MB conforme tipo). `reply_to: {mid}` para responder a uma mensagem
  específica.
- **Ações do remetente**: `POST /me/messages` com `sender_action` —
  usamos `mark_seen` ao abrir a conversa.
- **Perfil**: `GET /{IGSID}` retorna `name`, `username`, `profile_pic`
  (URL expira em poucos dias — precisa espelhar, igual já fazemos com
  mídia do WhatsApp).
- **Webhook**: mesmo handshake (`hub.mode`/`hub.challenge`/
  `hub.verify_token`) e mesma assinatura HMAC-SHA256
  (`x-hub-signature-256`) do webhook do WhatsApp, mas **payload
  diferente** — `object: "instagram"`, `entry[].id` (IGID da conta
  business), `entry[].messaging[]` (formato Messenger, não
  `entry[].changes[].value.messages`). Por isso precisa de rota própria.
- **Janela de 24h**: responder livremente só é permitido até 24h após a
  última mensagem do cliente; passado isso, `POST /me/messages` retorna
  erro 1545041. Não há template para contornar isso de forma genérica —
  a v1 mostra um aviso/bloqueia o composer quando a janela expira.

## Modelo de dados (nova migration `043_instagram_messaging.sql`)

Tabelas completamente separadas de `contacts`/`conversations`/`messages`,
formatadas de forma próxima o bastante para reaproveitar os componentes
visuais existentes da inbox (bolha de mensagem, thread) com adaptação
mínima.

```sql
instagram_config (
  id, account_id UNIQUE, page_id, ig_user_id, ig_username,
  page_access_token  -- criptografado AES-256-GCM (helper existente)
  verify_token       -- criptografado
  status ('connected'|'disconnected'), connected_at,
  created_at, updated_at
)

instagram_contacts (
  id, account_id, igsid, username, name, profile_pic_url,
  created_at, updated_at,
  UNIQUE(account_id, igsid)
)

instagram_conversations (
  id, account_id, contact_id -> instagram_contacts,
  last_message_text, last_message_at,
  last_customer_message_at,  -- base do cálculo da janela de 24h
  unread_count, created_at, updated_at,
  UNIQUE(account_id, contact_id)
)

instagram_messages (
  id, conversation_id -> instagram_conversations,
  sender_type ('customer'|'agent'), sender_id (profile id, nulo p/ customer),
  content_type ('text'|'image'|'video'|'audio'|'file'|'share'|'story_mention'|'story_reply'|'unsupported'),
  content_text, media_url, media_type,
  ig_message_id,             -- "mid" da Meta
  reply_to_message_id -> instagram_messages,
  status ('sending'|'sent'|'delivered'|'failed'), error_message,
  created_at,
  UNIQUE(conversation_id, ig_message_id)
)
```

RLS em todas: reaproveita `is_account_member(account_id, min_role)`
(migration 017). Leitura para qualquer membro da conta; escrita de
`instagram_config` restrita a `admin`+; mensagens/conversas/contatos
legíveis por qualquer membro, gravação normal por `agent`+. A rota de
webhook usa o cliente admin (service role), que ignora RLS — mesmo padrão
do webhook do WhatsApp.

Realtime: habilitar `instagram_messages` e `instagram_conversations` na
publicação `supabase_realtime`, igual às tabelas do WhatsApp.

## Módulos de backend (`src/lib/instagram/`)

- `encryption.ts` — **reaproveita** `@/lib/whatsapp/encryption`
  diretamente (é genérico, não específico do WhatsApp apesar do caminho).
- `webhook-signature.ts` — **reaproveita**
  `@/lib/whatsapp/webhook-signature` (`verifyMetaWebhookSignature`),
  mesmo mecanismo HMAC/`META_APP_SECRET`.
- `graph-api.ts` — chamadas HTTP para a Graph API: enviar mensagem,
  `mark_seen`, buscar perfil por IGSID.
- `mirror-media.ts` — baixa anexo recebido e a foto de perfil e copia
  para o bucket `chat-media` (reaproveita `buildMediaPath` de
  `@/lib/storage/upload-media`), com fallback best-effort igual ao
  `mirrorInboundMedia` do WhatsApp.
- `send-message.ts` — núcleo de envio: valida payload, checa janela de
  24h, chama a Graph API, persiste em `instagram_messages`, atualiza
  `instagram_conversations`.

## Rotas

- `GET/POST /api/instagram/webhook` — mesmo padrão da rota do WhatsApp:
  `GET` faz handshake contra todos os `instagram_config.verify_token`;
  `POST` verifica assinatura HMAC sobre o corpo bruto, responde 200
  imediatamente e processa via `after()` (mesma razão: Meta reenvia se
  demorar, e o processamento precisa sobreviver ao fim da resposta em
  runtime serverless). Roteia pela `account_id` cujo `ig_user_id` bate
  com `entry[].id`. Insere mensagem de forma idempotente via
  `UNIQUE(conversation_id, ig_message_id)` (`upsert` + `ignoreDuplicates`,
  igual ao WhatsApp).
- `POST /api/instagram/send` — rota autenticada do dashboard
  (`requireRole('agent')`, rate limit reaproveitando `RATE_LIMITS.send`),
  aceita `conversation_id` ou `contact_id`, delega ao
  `send-message.ts`.
- `GET/POST/DELETE /api/instagram/config` — salvar/consultar/remover a
  conexão (Page ID, IG User ID, Page Access Token, verify token).

## UI

- **Settings**: novo painel "Instagram" (ao lado do de WhatsApp) para
  colar Page ID, IG User ID e Page Access Token, gerar/mostrar verify
  token e a URL do webhook a cadastrar no Meta App, e testar a conexão.
- **Inbox**: nova aba "Instagram" ao lado de "WhatsApp" no topo da
  inbox. Componentes próprios e simples —
  `InstagramConversationList`, `InstagramMessageThread`,
  `InstagramComposer` — deliberadamente **não** reaproveitando o código
  de `components/inbox/*` (que tem lógica de realtime/dedupe afinada
  especificamente para as tabelas do WhatsApp); a UI visual (bolha de
  mensagem, layout) é copiada/adaptada, mas o estado é independente.
  Composer mostra aviso e desabilita o envio de texto livre quando a
  janela de 24h está fechada.

## Variáveis de ambiente novas

Nenhuma nova obrigatória — reaproveita `ENCRYPTION_KEY` e
`META_APP_SECRET` já existentes (o mesmo App Secret assina webhooks do
Instagram e do WhatsApp; o usuário deve garantir que o Meta App usado
para o Instagram tem seu secret na lista de `META_APP_SECRET`).

## Testes

Seguir a convenção do repo (`vitest`, arquivo `*.test.ts` ao lado do
código): assinatura de webhook, parsing de payload de mensagem/anexo,
idempotência de inserção, cálculo da janela de 24h, validação de envio.
Sem E2E automatizado do lado da Meta (impossível sem credenciais reais).

## Plano de teste local

A Meta só entrega webhooks para uma URL pública HTTPS — `localhost` não
funciona. Para testar localmente, será necessário um túnel (ex.: ngrok)
apontando para `npm run dev` e cadastrar essa URL temporária como
callback do webhook no Meta App durante o teste. Vou avisar quando
chegarmos nessa etapa; a criação do túnel e o cadastro no Meta App
dependem do painel do usuário.

## Riscos / observações

- Se o usuário futuramente mesclar a branch `uazapi-whatsapp-provider`,
  o número de migration `043` pode colidir com o `043_uazapi_provider.sql`
  daquela branch — renumerar uma das duas na hora do merge.
- `profile_pic` do IGSID expira em poucos dias — mirror necessário, mas
  como é best-effort, uma falha nunca deve travar o webhook.
- Sem token de longa duração corretamente configurado, o Page Access
  Token pode expirar em 1h — a tela de configuração deve deixar claro
  que o token deve vir de um User Access Token de longa duração.
