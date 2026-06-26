'use strict';

const localDateTimeRe = /^(\d{4}-\d{2}-\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?)?$/;

function normalizeLocalDateTime(value) {
  if (typeof value !== 'string') return value;

  const match = value.trim().match(localDateTimeRe);
  if (!match) return value;

  const hour = match[2] || '00';
  const minute = match[3] || '00';
  const second = match[4] || '00';
  return `${match[1]}T${hour}:${minute}:${second}`;
}

function normalizeEventDateTimes(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return event;

  for (const key of ['start_date_local', 'end_date_local', 'start_date', 'end_date']) {
    if (Object.prototype.hasOwnProperty.call(event, key)) {
      event[key] = normalizeLocalDateTime(event[key]);
    }
  }

  return event;
}

module.exports = {
  normalizeLocalDateTime,
  normalizeEventDateTimes,
};
