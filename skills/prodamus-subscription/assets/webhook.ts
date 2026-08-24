// ============================================================================
// Вебхук приёма платежей — референс-реализация
// ============================================================================
// Deno / Supabase Edge Functions. Портируется в Node/Express и Next.js route
// в лоб: меняются только импорт клиента БД и способ отдать Response.
//
// Это ЕДИНСТВЕННОЕ место в системе, где меняется статус подписки.
//
// Порядок шагов внутри жёсткий, менять нельзя:
//   1) распарсить тело           5) решить новый статус
//   2) проверить подпись         6) применить денежные правила
//   3) понять, ЗА ЧТО платёж     7) запереть идемпотентность (событие ДО апдейта)
//   4) найти клиента             8) обновить клиента (не вышло — снять замок, 500)
//
// ENV:
//   PAYMENT_SECRET_KEY         секрет кабинета для проверки подписи
//   PAYMENT_SECRET_KEY_2       второй кабинет (необязательно)
//   MIN_SUBSCRIPTION_AMOUNT    ниже этой суммы не активируем (по умолчанию 990)
//   SUBSCRIPTION_PERIOD_DAYS   период продления (по умолчанию 31)
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, sign',
};

const PERIOD_DAYS = parseInt(Deno.env.get('SUBSCRIPTION_PERIOD_DAYS') || '31', 10);
const MIN_AMOUNT = parseFloat(Deno.env.get('MIN_SUBSCRIPTION_AMOUNT') || '990');

// Несколько платёжных кабинетов = несколько секретов. Чей ключ сошёлся с
// подписью — от того кабинета и пришёл платёж.
const SECRET_ENVS: Record<string, string> = {
  acc1: 'PAYMENT_SECRET_KEY',
  acc2: 'PAYMENT_SECRET_KEY_2',
};

// ЗА ЧТО заплатили — определяется по plan_id тарифа, НЕ по сумме.
// Пусто — любой платёж продлевает основную подписку (годится, пока продукт один).
const PLAN_MAIN: string[] = [];   // тарифы, продлевающие ЭТУ подписку
const PLAN_OTHER: string[] = [];  // чужие продукты того же кабинета: пишем в журнал и выходим

// ───────────────────────────── Подпись ──────────────────────────────────────

/** Рекурсивная сортировка ключей + все скаляры в строку (как PHP-сторона шлюза). */
// deno-lint-ignore no-explicit-any
function sortRecursive(data: any): any {
  if (Array.isArray(data)) return data.map(sortRecursive);
  if (data !== null && typeof data === 'object') {
    const out: Record<string, unknown> = {};
    Object.keys(data).sort().forEach((k) => { out[k] = sortRecursive(data[k]); });
    return out;
  }
  if (data === null || data === undefined) return '';   // PHP-стиль: null → ""
  // Срезаем ТОЛЬКО хвостовые переводы строк: form-urlencoded может добавить \n,
  // которого не было в подписанном значении. Обычные пробелы значимы.
  return String(data).replace(/[\r\n]+$/, '');
}

/**
 * Компактный JSON + экранирование слешей.
 * `/` → `\/` — PHP json_encode так делает по умолчанию, JS JSON.stringify нет.
 * ЭТО ПРИЧИНА 90% «подпись не сходится»: в payload почти всегда есть URL.
 */
// deno-lint-ignore no-explicit-any
function compactJson(data: any): string {
  return JSON.stringify(data).replace(/\//g, '\\/');
}

async function hmacSha256(secret: string, payload: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Возвращает имя кабинета, чей ключ сошёлся, или null. */
async function verifySignature(
  data: Record<string, unknown>,
  signature: string,
): Promise<string | null> {
  const payload = compactJson(sortRecursive(data));
  for (const [account, envName] of Object.entries(SECRET_ENVS)) {
    const secret = Deno.env.get(envName);
    if (!secret) continue;
    if (await hmacSha256(secret, payload) === signature) return account;
  }
  return null;
}

// ─────────────────────────── Разбор тела ────────────────────────────────────

/** Шлюз шлёт form-urlencoded с PHP-нотацией: subscription[id], products[0][name]. */
async function parseBody(req: Request): Promise<Record<string, unknown>> {
  const contentType = req.headers.get('content-type') || '';
  const text = await req.text();
  if (contentType.includes('application/json')) return JSON.parse(text);

  const result: Record<string, unknown> = {};
  for (const [key, value] of new URLSearchParams(text).entries()) {
    const arrayMatch = key.match(/^(\w+)\[(\d+)\]\[(\w+)\]$/);
    if (arrayMatch) {
      const [, parent, idx, field] = arrayMatch;
      if (!Array.isArray(result[parent])) result[parent] = [];
      const arr = result[parent] as Record<string, string>[];
      const i = parseInt(idx, 10);
      if (!arr[i]) arr[i] = {};
      arr[i][field] = value;
      continue;
    }
    const objMatch = key.match(/^(\w+)\[(\w+)\]$/);
    if (objMatch) {
      const [, parent, field] = objMatch;
      if (!result[parent] || Array.isArray(result[parent])) result[parent] = {};
      (result[parent] as Record<string, string>)[field] = value;
      continue;
    }
    result[key] = value;
  }

  // Уплотняем разреженные массивы: пришли products[0] и products[2] без [1] —
  // JSON.stringify вставит null на месте дырки, и подпись не сойдётся.
  for (const [k, v] of Object.entries(result)) {
    if (Array.isArray(v)) result[k] = v.filter(Boolean);
  }
  return result;
}

const normalizePhone = (p: string) => p.replace(/\D/g, '');

// ────────────────────────────── Обработчик ──────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status, headers: { ...cors, 'Content-Type': 'application/json' },
    });

  const db = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  try {
    const body = await parseBody(req);
    const data = (body.submit ?? body) as Record<string, unknown>;
    const signature = req.headers.get('sign') || req.headers.get('Sign') || '';

    // ── 2. Подпись ──────────────────────────────────────────────────────────
    // Событие пишем ДАЖЕ при провале: разбирать жалобы по логам контейнера,
    // которые ротируются через сутки, невозможно.
    if (!signature) {
      await db.from('payment_events').insert({
        event_type: 'missing_signature', payment_status: 'missing_signature', raw_payload: body,
      });
      return json({ error: 'Missing signature' }, 400);
    }

    const account = await verifySignature(data, signature);
    if (!account) {
      await db.from('payment_events').insert({
        event_type: 'invalid_signature', payment_status: 'invalid_signature', raw_payload: body,
      });
      return json({ error: 'Invalid signature' }, 401);
    }

    // ── Поля платежа ────────────────────────────────────────────────────────
    const orderNum = String(data.order_num ?? '').trim();
    const email = String(data.customer_email ?? '').toLowerCase().trim();
    const phone = normalizePhone(String(data.customer_phone ?? ''));
    const amount = parseFloat(String(data.sum ?? '0')) || null;
    const paymentStatus = String(data.payment_status ?? '');

    const sub = data.subscription as Record<string, unknown> | undefined;
    // ⚠️ id = ТАРИФ (общий для всех подписчиков), profile_id = ПОДПИСЧИК.
    // Кажется наоборот. Продукт определяем по id, клиента ищем по profile_id.
    const planId = sub?.id ? String(sub.id) : '';
    const subscriptionId = sub?.profile_id ? String(sub.profile_id) : '';
    const eventKind = String(sub?.type ?? data.type ?? '');
    const actionCode = String(sub?.action_code ?? data.action_code ?? '');
    const notifyCode = String(sub?.notification_code ?? data.notification_code ?? '');
    const errorCode = String(sub?.error_code ?? data.error_code ?? '');
    const lastAttempt = String(sub?.last_attempt ?? data.last_attempt ?? '');

    // ── 3. Чужой продукт того же кабинета ───────────────────────────────────
    if (planId && PLAN_OTHER.includes(planId)) {
      await db.from('payment_events').insert({
        event_type: 'foreign_product', payment_status: paymentStatus, amount,
        gateway_account: account, gateway_order_num: orderNum, raw_payload: body,
      });
      return json({ ok: true, note: 'foreign product' });
    }
    if (PLAN_MAIN.length && planId && !PLAN_MAIN.includes(planId)) {
      // Неизвестный тариф ЛУЧШЕ засчитать, чем потерять платёж клиента,
      // но в журнале он должен быть виден отдельно.
      console.warn(`unknown plan ${planId} — засчитываем как основную подписку`);
    }

    // ── 4. Поиск клиента: четыре попытки по очереди ─────────────────────────
    type Client = { slug: string; subscription_status: string; subscription_expires_at: string | null };
    let client: Client | null = null;
    let lookupError: unknown = null;
    const COLS = 'slug, subscription_status, subscription_expires_at';

    // deno-lint-ignore no-explicit-any
    const tryFind = async (q: any) => {
      if (client) return;                  // запрос ленивый: до await он не уходит в БД
      const { data: row, error } = await q;
      if (error) lookupError = error;      // ошибку НЕЛЬЗЯ глотать (см. ниже)
      if (row) client = row as Client;
    };

    if (orderNum) {
      await tryFind(db.from('clients').select(COLS).eq('slug', orderNum).maybeSingle());
    }
    if (subscriptionId) {
      await tryFind(db.from('clients').select(COLS)
        .eq('gateway_subscription_id', subscriptionId).limit(1).maybeSingle());
    }
    if (email) {
      // limit(1): один email может оказаться у двух организаций. Запрос «ровно
      // одна строка» вернёт null, и клиент «потеряется» на каждом рекурренте.
      await tryFind(db.from('clients').select(COLS).ilike('billing_email', email)
        .eq('subscription_status', 'active').limit(1).maybeSingle());
      await tryFind(db.from('clients').select(COLS).ilike('billing_email', email)
        .limit(1).maybeSingle());
      // Клиент мог сменить почту — старый адрес остаётся в known_emails.
      await tryFind(db.from('clients').select(COLS)
        .contains('known_emails', [email]).limit(1).maybeSingle());
    }
    if (phone) {
      await tryFind(db.from('clients').select(COLS)
        .eq('billing_phone', phone).limit(1).maybeSingle());
    }

    // Сбой БД — это НЕ «клиента нет». Ответим 200 — шлюз посчитает доставку
    // успешной и больше не повторит: платёж исчезнет, а деньги у клиента списаны.
    if (!client && lookupError) {
      console.error('client lookup failed:', lookupError);
      return json({ error: 'lookup failed' }, 500);
    }

    if (!client) {
      // Клиента правда нет. Ретрай не поможет — отвечаем 200, но след оставляем:
      // по этой строке платёж потом привяжут руками.
      await db.from('payment_events').insert({
        event_type: 'client_not_found', payment_status: paymentStatus, amount,
        gateway_account: account, gateway_order_num: orderNum || phone, raw_payload: body,
      });
      return json({ ok: true, note: 'client not found' });
    }
    const found: Client = client;

    // Дозаполняем пустые поля — следующий рекуррент найдётся с первой попытки.
    const backfill: Record<string, string> = {};
    if (subscriptionId) backfill.gateway_subscription_id = subscriptionId;
    if (email) backfill.billing_email = email;
    if (phone) backfill.billing_phone = phone;
    if (Object.keys(backfill).length) {
      // Не перетираем уже заполненное: обновляем только там, где пусто.
      for (const [col, val] of Object.entries(backfill)) {
        await db.from('clients').update({ [col]: val }).eq('slug', found.slug).is(col, null);
      }
    }

    // ── 5-6. Новый статус и денежные правила ────────────────────────────────
    const paidUntil = found.subscription_expires_at ? new Date(found.subscription_expires_at) : null;
    const stillPaid = !!paidUntil && !Number.isNaN(paidUntil.getTime()) && paidUntil > new Date();

    /** Закрывающее событие НЕ отбирает оплаченный вперёд период. */
    const closingStatus = () => (stillPaid ? found.subscription_status : 'expired');
    const keptSuffix = stillPaid ? '_kept_paid_period' : '';

    const nextExpiry = () => {
      const exp = new Date();
      exp.setDate(exp.getDate() + PERIOD_DAYS);
      return exp.toISOString();
    };

    let newStatus = found.subscription_status;
    let expiresAt: string | null = null;
    let eventType: string;

    if (eventKind === 'action') {
      if (actionCode === 'first_payment' || actionCode === 'auto_payment') {
        newStatus = 'active';
        expiresAt = nextExpiry();
        eventType = actionCode === 'first_payment' ? 'payment_success_first' : 'payment_success_recurring';
      } else if (['cancel', 'deactivation', 'subscription_expired'].includes(actionCode)
                 || String(sub?.active ?? '') === '0') {
        // Отмена автопродления = «не продлевать в следующий раз», а НЕ «забрать
        // оплаченное». Безусловный expired здесь однажды сжёг клиентам по 13-30
        // оплаченных дней.
        newStatus = closingStatus();
        eventType = `${actionCode || 'subscription_cancelled'}${keptSuffix}`;
      } else {
        eventType = `action_${actionCode}`;
      }
    } else if (eventKind === 'notification' && errorCode) {
      if (lastAttempt === 'yes') {
        // Финальный провал по СТАРОЙ подписке приходит уже после оплаты по новой —
        // то же правило спасает от блокировки только что заплатившего клиента.
        newStatus = closingStatus();
        eventType = `payment_fail_final_${errorCode}${keptSuffix}`;
      } else {
        newStatus = found.subscription_status === 'active' ? 'past_due' : found.subscription_status;
        eventType = `payment_fail_${errorCode}`;
      }
    } else if (eventKind === 'notification') {
      if (['user_deactivated', 'manager_deactivated'].includes(notifyCode)) {
        newStatus = closingStatus();
        eventType = `notification_${notifyCode}${keptSuffix}`;
      } else if (['user_activated', 'manager_activated'].includes(notifyCode)) {
        newStatus = 'active';
        expiresAt = nextExpiry();
        eventType = `notification_${notifyCode}`;
      } else {
        eventType = `notification_${notifyCode}`;
      }
    } else if (paymentStatus === 'success') {
      newStatus = 'active';
      expiresAt = nextExpiry();
      eventType = String(data.payment_init ?? '') === 'manual'
        ? 'payment_success_first' : 'payment_success_recurring';
    } else if (paymentStatus === 'fail') {
      newStatus = found.subscription_status === 'active' ? 'past_due' : closingStatus();
      eventType = `payment_fail${keptSuffix}`;
    } else {
      eventType = `unknown_${paymentStatus || actionCode || notifyCode}`;
    }

    // Не понижаем оплаченный срок: у клиента может быть ручной период на полгода,
    // и активация не должна срезать его до месяца.
    if (expiresAt && found.subscription_expires_at) {
      const existing = new Date(found.subscription_expires_at);
      if (!Number.isNaN(existing.getTime()) && existing > new Date(expiresAt)) {
        expiresAt = found.subscription_expires_at;
      }
    }

    // Второй рубеж после подписи: поддельный вебхук на 1 ₽ не должен открыть месяц.
    if (newStatus === 'active' && expiresAt && amount !== null && amount < MIN_AMOUNT) {
      await db.from('payment_events').insert({
        client_slug: found.slug, event_type: 'rejected_low_amount',
        payment_status: paymentStatus, amount, gateway_account: account,
        gateway_order_num: orderNum || phone, raw_payload: body,
      });
      return json({ ok: false, error: 'amount below minimum', amount, min: MIN_AMOUNT }, 400);
    }

    // ── 7. Атомарный замок идемпотентности ──────────────────────────────────
    // Событие пишем ДО применения статуса. Повторная доставка (шлюзы ретраят
    // часами, бывают две одновременно) упирается в UNIQUE и ничего не двигает.
    // Проверка «не было ли такого события минуту назад» здесь НЕ работает.
    const eventKey = [
      found.slug, orderNum || phone,
      paymentStatus || actionCode || notifyCode,
      String(amount ?? ''), String(data.date ?? ''),
    ].join('|');

    const { data: event, error: evErr } = await db.from('payment_events').insert({
      client_slug: found.slug, event_type: eventType, payment_status: paymentStatus || actionCode,
      amount, gateway_account: account, gateway_order_num: orderNum || phone,
      raw_payload: body, event_key: eventKey,
    }).select('id').single();

    if (evErr) {
      if ((evErr as { code?: string }).code === '23505') {
        await db.from('payment_events').insert({   // служебная строка, без event_key
          client_slug: found.slug, event_type: 'duplicate_skipped',
          payment_status: paymentStatus || actionCode, amount, raw_payload: body,
        });
        return json({ ok: true, note: 'duplicate skipped' });
      }
      return json({ error: 'event insert failed' }, 500);   // пусть ретраит
    }

    // ── 8. Применяем статус ─────────────────────────────────────────────────
    const update: Record<string, unknown> = { subscription_status: newStatus };
    if (expiresAt) update.subscription_expires_at = expiresAt;

    const { error: updErr } = await db.from('clients').update(update).eq('slug', found.slug);
    if (updErr) {
      // СНИМАЕМ ЗАМОК. Иначе ретрай упрётся в event_key, статус не применится
      // никогда, и клиент навсегда останется оплатившим без доступа.
      if (event?.id) await db.from('payment_events').delete().eq('id', event.id);
      return json({ error: 'client update failed' }, 500);
    }

    // ── 9. Побочные эффекты — только await ──────────────────────────────────
    // В serverless воркер сносится сразу после ответа: void fn() молча не
    // выполнится. Таймаут + try/catch обязательны: сторонний сервис не должен
    // уронить обработку платежа.
    // await notifyOwner(found.slug, eventType, amount);

    return json({ ok: true, slug: found.slug, status: newStatus });
  } catch (err) {
    console.error('payment webhook error:', err);
    return json({ error: 'internal error' }, 500);
  }
});
