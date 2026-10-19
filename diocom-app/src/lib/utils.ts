import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDuration(seconds: number): string {
  if (!seconds || !isFinite(seconds)) return '0:00';

  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 Bytes';

  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

export function formatTimestamp(date: Date): string {
  const now = new Date();
  const diff = now.getTime() - date.getTime();

  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;

  return date.toLocaleTimeString();
}

/** Transfer rate, e.g. "4.2 MB/s". */
export function formatSpeed(bytesPerSecond: number): string {
  if (!isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '—';
  return `${formatFileSize(Math.round(bytesPerSecond))}/s`;
}

/** Compact duration for ETAs and countdowns: "45 s", "3 min", "2 h 5 min", "3 d 4 h". */
export function formatDurationShort(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '—';
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(s / 3600);
  if (h < 48) {
    const rm = Math.floor((s % 3600) / 60);
    return rm ? `${h} h ${rm} min` : `${h} h`;
  }
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d} d ${rh} h` : `${d} d`;
}

/** Human label for a link lifetime given in hours: "1 hour", "24 hours", "7 days". */
export function formatHours(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)} minutes`;
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const d = Math.round(hours / 24);
  return `${d} day${d === 1 ? '' : 's'}`;
}
