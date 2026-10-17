/**
 * Calendar-date handling. Review dates are plain ISO calendar dates
 * (YYYY-MM-DD) in the configured IANA timezone; "today" is computed in that
 * timezone, and date arithmetic is done on UTC midnights so DST changes never
 * shift a review by a day. Timestamps are ISO 8601 with the local offset.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(s: string): boolean {
	if (!ISO_DATE.test(s)) return false;
	const d = new Date(`${s}T00:00:00Z`);
	return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function parts(now: Date, timeZone: string): Record<string, string> {
	const fmt = new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
		timeZoneName: "longOffset",
	});
	const out: Record<string, string> = {};
	for (const p of fmt.formatToParts(now)) out[p.type] = p.value;
	return out;
}

/** Local calendar date (YYYY-MM-DD) of `now` in `timeZone`. */
export function localDate(now: Date, timeZone: string): string {
	const p = parts(now, timeZone);
	return `${p.year}-${p.month}-${p.day}`;
}

/** ISO 8601 timestamp with the zone's offset, e.g. 2026-10-12T14:03:00-04:00. */
export function localTimestamp(now: Date, timeZone: string): string {
	const p = parts(now, timeZone);
	let off = (p.timeZoneName ?? "GMT").replace("GMT", "");
	if (off === "") off = "+00:00";
	return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${off}`;
}

/** HHmm in local time (for file names). */
export function localHHmm(now: Date, timeZone: string): string {
	const p = parts(now, timeZone);
	return `${p.hour}${p.minute}`;
}

export function addDays(date: string, days: number): string {
	if (!isIsoDate(date)) throw new Error(`Invalid ISO date: ${date}`);
	const t = Date.parse(`${date}T00:00:00Z`) + days * 86_400_000;
	return new Date(t).toISOString().slice(0, 10);
}

/** Whole days from a to b (b - a). */
export function diffDays(a: string, b: string): number {
	return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}
