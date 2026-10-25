// One catalog supplies the existing Worker and client object shapes.
// Keep ordinary mutable objects and their property insertion order.
export const PAYMENT_CATALOG = {
  speed: {
    price: 10,
    column: 'speed_expires',
    duration: 24 * 60 * 60 * 1000,
    title: 'เพิ่มความเร็วเคลื่อนที่ x2 (24 ช.ม.)'
  },
  coin: {
    price: 20,
    column: 'coin_expires',
    duration: 24 * 60 * 60 * 1000,
    title: 'เหรียญตามแมพ x2 (24 ช.ม.)'
  },
  vip1: {
    price: 50,
    column: 'vip1_expires',
    duration: 30 * 24 * 60 * 60 * 1000,
    title: 'สิทธิ์ VIP Server 1 (30 วัน)'
  }
};

export const PAYMENT_CONFIG = Object.fromEntries(
  Object.entries(PAYMENT_CATALOG).map(([item, { price, column, duration }]) =>
    [item, { price, column, duration }])
);

export const PAYMENT_PRICES = Object.fromEntries(
  Object.entries(PAYMENT_CATALOG).map(([item, { price }]) => [item, price])
);

export const CLIENT_PAYMENT_ITEMS = Object.fromEntries(
  Object.entries(PAYMENT_CATALOG).map(([item, { price, title }]) =>
    [item, { price, title }])
);

// Preserve the server's exact comparison thresholds rather than summing weights.
export const LUCKY_REWARDS = [
  { label: '100 เหรียญ', value: 100, weight: 50, color: '#3b82f6', upperBound: 50 },
  { label: '500 เหรียญ', value: 500, weight: 30, color: '#10b981', upperBound: 80 },
  { label: '1,000 เหรียญ', value: 1000, weight: 19, color: '#8b5cf6', upperBound: 99 },
  { label: '5,000 เหรียญ', value: 5000, weight: 0.9, color: '#f59e0b', upperBound: 99.9 },
  { label: '9,999 เหรียญ', value: 9999, weight: 0.1, color: '#ef4444', upperBound: 100 }
];

export const WHEEL_ITEMS = LUCKY_REWARDS.map(({ label, value, weight, color }) =>
  ({ label, value, weight, color })
);
