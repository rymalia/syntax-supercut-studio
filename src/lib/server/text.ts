/**
 * Turns curly and modifier apostrophes into a straight `'`, so input typed with
 * smart punctuation matches transcripts. Each character maps to one UTF-16 unit,
 * so string offsets are unchanged.
 */
export function foldApostrophes(text: string): string {
	return text.replace(/[\u2018\u2019\u02BC]/g, "'");
}

/** Lowercases and strips punctuation, keeping apostrophes: `don't` and `dont` differ. */
export function normalize(word: string): string {
	return foldApostrophes(word.toLowerCase()).replace(/[^\p{L}\p{N}']/gu, '');
}

export function slugify(phrase: string): string {
	return phrase
		.split(/\s+/)
		.map(normalize)
		.filter(Boolean)
		.join('-');
}

/**
 * Returns a short filename-safe timestamp (`YYYYMMDD-hhmmss`) used to
 * differentiate repeat renders so a second run with identical inputs doesn't
 * overwrite the first — and so the browser doesn't serve a stale cached copy
 * of an identically-named file.
 */
export function timestampSuffix(date = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	const y = date.getFullYear();
	const mo = pad(date.getMonth() + 1);
	const d = pad(date.getDate());
	const hh = pad(date.getHours());
	const mm = pad(date.getMinutes());
	const ss = pad(date.getSeconds());
	return `${y}${mo}${d}-${hh}${mm}${ss}`;
}

export interface TranscriptWord {
	text: string;
	start: number;
	end: number;
}

export interface Transcript {
	text: string;
	duration: number;
	words?: TranscriptWord[];
}

export interface Hit {
	video: string;
	start: number;
	end: number;
	word: string;
}
