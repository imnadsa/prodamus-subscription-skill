#!/usr/bin/env node
// ============================================================================
// Проверка алгоритма подписи ДО того, как ловить живые платежи
// ============================================================================
//   node sign-check.mjs
//
// Считает подпись по эталонному телу платежа и сверяет с ожидаемой. Если ваша
// реализация даёт другое число — вы поймаете это здесь, а не на первом клиенте,
// который заплатил и не получил доступ.
//
// Эталон специально содержит три ловушки, на которых спотыкаются все:
//   • URL со слешами  — PHP json_encode пишет \/, JS JSON.stringify пишет /
//   • кириллицу       — должна остаться как есть, не \uXXXX
//   • число и null    — должны стать "1490" и ""
// ============================================================================

import { createHmac } from 'node:crypto';

const SECRET = 'demo-secret-key';

const PAYLOAD = {
  order_num: 'tenant-42',
  sum: 1490,
  customer_phone: '79001234567',
  customer_email: 'owner@example.com',
  payment_status: 'success',
  payment_init: 'manual',
  demo_flag: null,
  link: 'https://example.com/pay/success',
  products: [{ name: 'Подписка на сервис', price: '1490', quantity: '1' }],
  subscription: { id: '111111', profile_id: '222222', type: 'action', action_code: 'first_payment' },
};

const EXPECTED = '903c7bc6e4d2d50b6bae95e5288246623c39ea3aa5b732af9ef954355719f358';

// ── Алгоритм ────────────────────────────────────────────────────────────────

function sortRecursive(data) {
  if (Array.isArray(data)) return data.map(sortRecursive);
  if (data !== null && typeof data === 'object') {
    const out = {};
    Object.keys(data).sort().forEach((k) => { out[k] = sortRecursive(data[k]); });
    return out;
  }
  if (data === null || data === undefined) return '';        // PHP: null → ""
  return String(data).replace(/[\r\n]+$/, '');               // все скаляры → строка
}

const compactJson = (data) => JSON.stringify(data).replace(/\//g, '\\/');   // ← ключевая строка

const sign = (secret, payload) => createHmac('sha256', secret).update(payload, 'utf8').digest('hex');

// ── Проверка ────────────────────────────────────────────────────────────────

const canonical = compactJson(sortRecursive(PAYLOAD));
const computed = sign(SECRET, canonical);

console.log('Канонический payload:\n' + canonical + '\n');
console.log('Подпись:  ' + computed);
console.log('Ожидание: ' + EXPECTED);

// Та же подпись БЕЗ экранирования слешей — чтобы увидеть, насколько всё разъезжается
const withoutEscape = sign(SECRET, JSON.stringify(sortRecursive(PAYLOAD)));
console.log('\nБез экранирования "/" получилось бы: ' + withoutEscape);
console.log('Совпадает с правильной? ' + (withoutEscape === computed ? 'да' : 'НЕТ — вот вам и «подпись не сходится»'));

if (computed === EXPECTED) {
  console.log('\n✅ Алгоритм подписи верный.');
  process.exit(0);
}
console.log('\n❌ Не сошлось. Проверьте по порядку:');
console.log('   1) сортировка ключей рекурсивная, включая вложенные объекты');
console.log('   2) все скаляры приведены к строкам, null → "" (не "null")');
console.log('   3) JSON компактный, без пробелов, кириллица не экранирована');
console.log('   4) слеши экранированы: "/" → "\\/"');
console.log('   5) срезаны только ХВОСТОВЫЕ \\r\\n, обычные пробелы не тронуты');
process.exit(1);
