export function formatDate(date) {
  return date.toISOString();
}

export function parseDate(str) {
  return new Date(str);
}
