import { readdir, readFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { VIDEO_EXTS, resolveBuckets, type Bucket } from './paths.js';
import { foldApostrophes, normalize, type Hit, type Transcript } from './text.js';

const PAD_BEFORE = 0;
const PAD_AFTER = 0;
const MIN_HIT_DURATION = 0.08;

/**
 * Look up the source video for a transcript inside a specific bucket.
 * Transcripts are named `<slug>.json` and the video is `<slug>.<ext>` sitting
 * next to it under the bucket's videos/ folder.
 */
export async function findVideoForTranscriptInBucket(
	transcriptFile: string,
	bucket: Bucket,
): Promise<string | null> {
	const stem = basename(transcriptFile, '.json');
	let entries: string[] = [];
	try {
		entries = await readdir(bucket.videosDir);
	} catch {
		return null;
	}
	for (const f of entries) {
		if (!VIDEO_EXTS.has(extname(f).toLowerCase())) continue;
		if (basename(f, extname(f)) === stem) return join(bucket.videosDir, f);
	}
	return null;
}

export interface CollectHitsOptions {
	target?: string;
	regex?: RegExp | null;
	buckets?: string[] | null; // bucket names; null/empty = all
	onLog?: (line: string) => void;
}

/**
 * Scan every transcript in the selected buckets and return per-hit records.
 * Hits carry the bucket name so downstream code can sort/group or assemble
 * bucket-aware filenames.
 */
export async function collectHits(opts: CollectHitsOptions): Promise<Hit[]> {
	// Rebuilt with straight apostrophes so a smart-quoted `don’t` matches; the
	// joined transcript text is folded the same way below.
	const regex = opts.regex ? new RegExp(foldApostrophes(opts.regex.source), opts.regex.flags) : null;
	const target = opts.target ?? '';
	const onLog = opts.onLog ?? (() => {});

	const targetTokens = regex
		? []
		: target
				.split(/\s+/)
				.map(normalize)
				.filter((t) => t.length > 0);
	if (!regex && targetTokens.length === 0) {
		throw new Error('Target is empty after normalization');
	}

	const buckets = await resolveBuckets(opts.buckets);
	if (buckets.length === 0) throw new Error('No buckets available to search');

	const hits: Hit[] = [];

	for (const bucket of buckets) {
		let files: string[] = [];
		try {
			files = (await readdir(bucket.transcriptsDir)).filter((f) => f.endsWith('.json'));
		} catch {
			continue;
		}

		for (const f of files) {
			const videoPath = await findVideoForTranscriptInBucket(f, bucket);
			if (!videoPath) continue;

			const data: Transcript = JSON.parse(
				await readFile(join(bucket.transcriptsDir, f), 'utf8'),
			);
			if (!data.words) continue;

			const words = data.words;
			let count = 0;

			if (regex) {
				const parts: string[] = [];
				const wordStart: number[] = [];
				const wordEnd: number[] = [];
				let pos = 0;
				for (let i = 0; i < words.length; i++) {
					if (i > 0) {
						parts.push(' ');
						pos += 1;
					}
					const t = foldApostrophes(words[i].text);
					wordStart.push(pos);
					parts.push(t);
					pos += t.length;
					wordEnd.push(pos);
				}
				const joined = parts.join('');
				regex.lastIndex = 0;
				let m: RegExpExecArray | null;
				while ((m = regex.exec(joined)) !== null) {
					const matchStart = m.index;
					const matchEnd = m.index + m[0].length;

					let firstWord = -1;
					for (let i = 0; i < words.length; i++) {
						if (wordEnd[i] > matchStart) {
							firstWord = i;
							break;
						}
					}
					let lastWord = -1;
					for (let i = words.length - 1; i >= 0; i--) {
						if (wordStart[i] < matchEnd) {
							lastWord = i;
							break;
						}
					}
					if (firstWord === -1 || lastWord === -1 || lastWord < firstWord) {
						if (m[0].length === 0) regex.lastIndex++;
						continue;
					}

					const first = words[firstWord];
					const last = words[lastWord];
					if (last.end - first.start < MIN_HIT_DURATION) {
						if (m[0].length === 0) regex.lastIndex++;
						continue;
					}
					hits.push({
						video: videoPath,
						start: Math.max(0, first.start - PAD_BEFORE),
						end: Math.min(data.duration, last.end + PAD_AFTER),
						word: m[0],
					});
					count++;
					if (m[0].length === 0) regex.lastIndex++;
				}
			} else {
				const tokenCount = targetTokens.length;
				for (let i = 0; i <= words.length - tokenCount; i++) {
					let matches = true;
					for (let j = 0; j < tokenCount; j++) {
						if (normalize(words[i + j].text) !== targetTokens[j]) {
							matches = false;
							break;
						}
					}
					if (!matches) continue;
					const first = words[i];
					const last = words[i + tokenCount - 1];
					if (last.end - first.start < MIN_HIT_DURATION) continue;
					const text = words
						.slice(i, i + tokenCount)
						.map((w) => w.text)
						.join(' ');
					hits.push({
						video: videoPath,
						start: Math.max(0, first.start - PAD_BEFORE),
						end: Math.min(data.duration, last.end + PAD_AFTER),
						word: text,
					});
					count++;
				}
			}

			if (count > 0) onLog(`  [${bucket.name}] ${f}: ${count} hit(s)`);
		}
	}

	return hits;
}
