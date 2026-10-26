const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;

function bangkokDateParts(now) {
  const local = new Date(now + BANGKOK_OFFSET_MS);
  return {
    year: local.getUTCFullYear(),
    month: local.getUTCMonth(),
    day: local.getUTCDate(),
    weekday: local.getUTCDay()
  };
}

function bangkokMidnightUtcMs(year, month, day) {
  return Date.UTC(year, month, day, 0, 0, 0, 0) - BANGKOK_OFFSET_MS;
}

export function nextScoreResetAt(now, serverScope) {
  if (!Number.isFinite(Number(now))) throw Error('Invalid reset clock');
  const current = Number(now);
  const parts = bangkokDateParts(current);
  if (serverScope === 'vip1') {
    return bangkokMidnightUtcMs(parts.year, parts.month, parts.day + 1);
  }
  if (serverScope !== 'free1') throw Error('Invalid reset scope');
  const daysUntilSunday = (7 - parts.weekday) % 7 || 7;
  return bangkokMidnightUtcMs(parts.year, parts.month, parts.day + daysUntilSunday);
}

export function resetLabel(serverScope) {
  return serverScope === 'vip1' ? 'daily-00:00-Asia/Bangkok' : 'weekly-Sunday-00:00-Asia/Bangkok';
}

export function isBangkokSunday(now) {
  return bangkokDateParts(Number(now)).weekday === 0;
}
