-- ============================================================================
-- Подписка: минимальная схема
-- ============================================================================
-- Postgres 13+ / Supabase. Миграция идемпотентная: повторный накат чинит, а не
-- ломает. Имена таблиц под свой проект замените (clients → tenants/accounts).
--
-- Применять до выкладки вебхука: он пишет в payment_events.event_key, и без
-- колонки первая же доставка платежа упадёт.
-- ============================================================================

-- ─────────────────────────── 1. Поля подписки ───────────────────────────────

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS subscription_status      text,
  ADD COLUMN IF NOT EXISTS subscription_expires_at  timestamptz,
  -- id подписки в шлюзе: по нему находится клиент при рекуррентном списании
  ADD COLUMN IF NOT EXISTS gateway_subscription_id  text,
  -- какой платёжный кабинет обслуживает клиента (если их несколько)
  ADD COLUMN IF NOT EXISTS gateway_account          text,
  ADD COLUMN IF NOT EXISTS billing_email            text,
  -- только цифры, без + и пробелов — иначе не совпадёт с тем, что пришлёт шлюз
  ADD COLUMN IF NOT EXISTS billing_phone            text,
  -- старые адреса клиента: люди меняют почту, а шлюз помнит прежнюю
  ADD COLUMN IF NOT EXISTS known_emails             text[];

UPDATE public.clients SET subscription_status = 'expired'
 WHERE subscription_status IS NULL;

ALTER TABLE public.clients
  ALTER COLUMN subscription_status SET DEFAULT 'expired',
  ALTER COLUMN subscription_status SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'clients_subscription_status_check') THEN
    ALTER TABLE public.clients ADD CONSTRAINT clients_subscription_status_check
      CHECK (subscription_status IN ('free','trial','active','past_due','expired'));
  END IF;
END $$;

COMMENT ON COLUMN public.clients.subscription_status IS
  'free (выдан вручную) | trial | active (оплачен до expires_at) | past_due (списание не прошло, доступ до expires_at) | expired';

-- Рекуррент ищет клиента по id подписки — без индекса это seq scan на каждом платеже.
CREATE INDEX IF NOT EXISTS idx_clients_gateway_subscription
  ON public.clients (gateway_subscription_id) WHERE gateway_subscription_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_clients_billing_phone
  ON public.clients (billing_phone) WHERE billing_phone IS NOT NULL;

-- ────────────────────── 2. Журнал платёжных событий ─────────────────────────
-- Пишется ВСЕГДА: и при неверной подписи, и когда клиент не найден. По этому
-- журналу потом разбирают жалобы «я оплатил, а доступа нет».

CREATE TABLE IF NOT EXISTS public.payment_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_slug   text,                    -- NULL, если клиента не нашли
  event_type    text NOT NULL,           -- payment_success_first | payment_fail_<code> | ...
  payment_status text,                   -- как прислал шлюз
  amount        numeric,
  gateway_account text,                  -- какой кабинет прислал платёж
  gateway_order_num text,                -- order_num из ссылки оплаты
  -- Детерминированный ключ идемпотентности: slug|order|status|amount|date.
  -- NULL у служебных строк (invalid_signature, duplicate_skipped, client_not_found).
  event_key     text,
  raw_payload   jsonb,                   -- сырое тело вебхука целиком
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ГЛАВНЫЙ ЗАМОК. Повторная доставка того же события упирается сюда (код 23505)
-- и не двигает подписку. Индекс частичный — служебных строк может быть сколько угодно.
CREATE UNIQUE INDEX IF NOT EXISTS payment_events_event_key_uniq
  ON public.payment_events (event_key) WHERE event_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payment_events_client
  ON public.payment_events (client_slug, created_at DESC);

-- ─────────────── 3. Второй контур: оплата дочерних единиц ───────────────────
-- Нужен, только если платят не за организацию целиком, а за каждый филиал /
-- проект / рабочее пространство сверх первого. Не нужен — не накатывайте.

ALTER TABLE public.branches
  ADD COLUMN IF NOT EXISTS subscription_status      text,
  ADD COLUMN IF NOT EXISTS subscription_expires_at  timestamptz,
  ADD COLUMN IF NOT EXISTS gateway_subscription_id  text,
  -- «оплата по счёту», «подарок за отзыв» — чтобы через полгода помнить, почему free
  ADD COLUMN IF NOT EXISTS billing_note             text;

-- Grandfathering ДО установки дефолта: всё, что создано до перехода на платность,
-- получает доступ навсегда. Иначе завтра утром часть работающих клиентов увидит
-- пейволл — и это будет ваш худший день.
UPDATE public.branches
   SET subscription_status = CASE WHEN is_default THEN 'included' ELSE 'free' END,
       billing_note = COALESCE(billing_note,
         'Создан до перехода на пофилиальную оплату — доступ сохранён')
 WHERE subscription_status IS NULL;

ALTER TABLE public.branches
  ALTER COLUMN subscription_status SET DEFAULT 'expired',
  ALTER COLUMN subscription_status SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'branches_subscription_status_check') THEN
    ALTER TABLE public.branches ADD CONSTRAINT branches_subscription_status_check
      CHECK (subscription_status IN ('included','free','active','expired'));
  END IF;
END $$;

COMMENT ON COLUMN public.branches.subscription_status IS
  'included (главный, покрыт подпиской организации) | free (по счёту/подарок) | active (оплачен до даты) | expired';

-- Платёж за филиал: order_num = branch_slug. Чтобы в админке было видно, ЗА ЧТО деньги.
ALTER TABLE public.payment_events
  ADD COLUMN IF NOT EXISTS branch_slug text;

CREATE INDEX IF NOT EXISTS idx_branches_gateway_subscription
  ON public.branches (gateway_subscription_id) WHERE gateway_subscription_id IS NOT NULL;
