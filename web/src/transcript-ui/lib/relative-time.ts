const relativeTime = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

export function formatRelativeTime(isoDate: string, now = Date.now()): string {
  const difference = new Date(isoDate).getTime() - now;
  const absolute = Math.abs(difference);

  if (absolute < 60_000) return "now";
  if (absolute < 3_600_000) {
    return relativeTime.format(Math.round(difference / 60_000), "minute");
  }
  if (absolute < 86_400_000) {
    return relativeTime.format(Math.round(difference / 3_600_000), "hour");
  }
  return relativeTime.format(Math.round(difference / 86_400_000), "day");
}

export function formatClockTime(isoDate: string): string {
  return new Intl.DateTimeFormat("en", {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(isoDate));
}
