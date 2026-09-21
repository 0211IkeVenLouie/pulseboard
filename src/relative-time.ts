/** "3 minutes ago", "yesterday", "on 14 Sept" — how people read timestamps. */
export function relativeTime(when: Date, now: Date = new Date()): string {
  const seconds = Math.round((now.getTime() - when.getTime()) / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  // Past a week, a date is more useful than a count.
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: when.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  }).format(when);
}

export function absoluteTime(when: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short', day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }).format(when);
}

export function initialsOf(name: string): string {
  return name.split(/\s+/).slice(0, 2).map((part) => part[0] ?? '').join('').toUpperCase();
}
