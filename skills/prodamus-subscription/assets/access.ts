// ============================================================================
// Гейт доступа: пускать или показывать пейволл
// ============================================================================
// Решение — ЧИСТАЯ функция: её видно глазами и можно покрыть тестами. Никаких
// «условий по месту» в компонентах: доступ к оплаченному продукту не то место,
// где можно однажды ошибиться в одной из десяти проверок.

export type SubscriptionStatus = 'free' | 'trial' | 'active' | 'past_due' | 'expired';

export interface AccessInfo {
  hasAccess: boolean;
  status: SubscriptionStatus;
  daysLeft: number | null;
  expiresAt: string | null;
  /** Ссылка оплаты с уже подставленным order_num. */
  paymentUrl: string;
}

/**
 * Есть ли доступ.
 *
 * free     — выдан вручную (подарок, бартер, свои): дата не проверяется.
 * active   — по дате.
 * past_due — списание не прошло, шлюз повторяет. ОТСРОЧКИ НЕТ: доступ ровно до
 *            конца оплаченного периода. Безусловный доступ в этом статусе однажды
 *            подарил клиентам месяцы бесплатной работы — шлюз не всегда присылает
 *            финальное событие, и клиент зависает в past_due навсегда.
 * trial / expired — без даты доступа нет.
 */
export function hasAccess(
  status: SubscriptionStatus,
  expiresAt: string | null,
  now: Date = new Date(),
): boolean {
  if (status === 'free') return true;

  if (status === 'active' || status === 'past_due') {
    // Активация из админки без даты — считаем открытым (ручная воля человека),
    // но только для active: past_due без даты — это сломанное состояние.
    if (!expiresAt) return status === 'active';
    const exp = new Date(expiresAt);
    if (Number.isNaN(exp.getTime())) return false;
    return now < exp;
  }

  if (status === 'trial' && expiresAt) {
    return now < new Date(expiresAt);
  }

  return false;
}

/** Сколько дней осталось (для плашки «продлится N-го»). */
export function daysLeft(expiresAt: string | null, now: Date = new Date()): number | null {
  if (!expiresAt) return null;
  const exp = new Date(expiresAt);
  if (Number.isNaN(exp.getTime())) return null;
  return Math.max(0, Math.ceil((exp.getTime() - now.getTime()) / 86_400_000));
}

/**
 * Ссылка оплаты. order_num = идентификатор клиента — ЕДИНСТВЕННАЯ надёжная
 * ниточка «платёж → клиент» на первом платеже. Без него вебхук будет угадывать
 * по email и телефону, а они дублируются и меняются.
 */
export function buildPaymentUrl(formUrl: string, orderNum?: string | null): string {
  return orderNum ? `${formUrl}?order_num=${encodeURIComponent(orderNum)}` : formUrl;
}

// ─────────────────────────── React-обвязка ──────────────────────────────────

export function useSubscription(): AccessInfo {
  // Подставьте свой источник профиля.
  const { subscriptionStatus, subscriptionExpiresAt, clientSlug } = useAuth();

  const status = (subscriptionStatus || 'expired') as SubscriptionStatus;
  const expiresAt = subscriptionExpiresAt ?? null;

  return {
    status,
    expiresAt,
    hasAccess: hasAccess(status, expiresAt),
    daysLeft: daysLeft(expiresAt),
    paymentUrl: buildPaymentUrl(PAYMENT_FORM_URL, clientSlug),
  };
}

// Использование в корне приложения:
//
//   if (loading)   return <Loader />;          // ГРУЗИМСЯ — НЕ БЛОКИРУЕМ:
//                                             // мигнувший пейволл платящий клиент
//                                             // читает как «сервис украл мои деньги»
//   if (!hasAccess) return <PaywallScreen />;
//   return <App />;
