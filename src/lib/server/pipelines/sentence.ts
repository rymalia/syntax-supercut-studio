import { readdir, readFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve as resolvePath } from 'node:path';
import { resolveBuckets, type Bucket } from '../paths.js';
import { runFfmpeg, throwIfAborted, type LogFn } from '../ffmpeg.js';
import { normalize, slugify, timestampSuffix, type Hit, type Transcript } from '../text.js';
import { findVideoForTranscriptInBucket } from '../hits.js';
import { drawTextFilter } from '../drawtext.js';

const CANVAS_W = 1280;
const CANVAS_H = 720;

const PAD_BEFORE = 0.02;
const PAD_AFTER = 0.04;

function mulberry32(seed: number): () => number {
	let t = seed >>> 0;
	return () => {
		t = (t + 0x6d2b79f5) >>> 0;
		let r = t;
		r = Math.imul(r ^ (r >>> 15), r | 1);
		r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
		return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
	};
}

async function buildWordIndex(buckets: Bucket[]): Promise<Map<string, Hit[]>> {
	const index = new Map<string, Hit[]>();

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

			for (const w of data.words) {
				const key = normalize(w.text);
				if (!key) continue;
				const dur = w.end - w.start;
				if (dur <= 0 || dur > 2.0) continue;
				if (!index.has(key)) index.set(key, []);
				index.get(key)!.push({
					video: videoPath,
					start: Math.max(0, w.start - PAD_BEFORE),
					end: Math.min(data.duration, w.end + PAD_AFTER),
					word: w.text,
				});
			}
		}
	}
	return index;
}

function findHitsForWord(
	target: string,
	index: Map<string, Hit[]>,
): { key: string; hits: Hit[] } | null {
	const norm = normalize(target);
	if (!norm) return null;
	const variants = [
		norm,
		norm.replace(/'s$/, ''),
		norm.replace(/s$/, ''),
		norm.replace(/es$/, ''),
		norm.replace(/ies$/, 'y'),
		norm.replace(/ing$/, ''),
		norm.replace(/ing$/, 'e'),
		norm.replace(/ed$/, ''),
		norm.replace(/ed$/, 'e'),
		norm + 's',
	];
	for (const v of variants) {
		const hits = index.get(v);
		if (hits && hits.length > 0) return { key: v, hits };
	}
	return null;
}

async function renderWord(
	hit: Hit,
	outPath: string,
	onLog: LogFn,
	signal?: AbortSignal,
	debug = false,
): Promise<void> {
	const duration = hit.end - hit.start;
	const scaleChain = `scale=${CANVAS_W}:${CANVAS_H}:force_original_aspect_ratio=decrease,pad=${CANVAS_W}:${CANVAS_H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30`;
	const vf = debug ? `${scaleChain},${drawTextFilter(hit.word)}` : scaleChain;
	await runFfmpeg(
		[
			'-ss',
			hit.start.toFixed(3),
			'-i',
			hit.video,
			'-t',
			duration.toFixed(3),
			'-vf',
			vf,
			'-c:v',
			'libx264',
			'-preset',
			'veryfast',
			'-crf',
			'20',
			'-pix_fmt',
			'yuv420p',
			'-c:a',
			'aac',
			'-ar',
			'48000',
			'-ac',
			'2',
			'-b:a',
			'192k',
			outPath,
		],
		onLog,
		signal,
	);
}

export interface SentenceOptions {
	sentence: string;
	seed?: number;
	buckets?: string[] | null;
	outDir?: string;
	/** When true, burn the spoken word onto each clip in big bold text. */
	debug?: boolean;
	onLog?: LogFn;
	signal?: AbortSignal;
}

export interface SentenceResult {
	outFile: string;
	picks: { token: string; matchedAs: string; word: string; video: string }[];
	missing: string[];
}

export async function buildSentence(opts: SentenceOptions): Promise<SentenceResult> {
	const onLog = opts.onLog ?? (() => {});
	const signal = opts.signal;
	const debug = opts.debug ?? false;

	const buckets = await resolveBuckets(opts.buckets);
	if (buckets.length === 0) throw new Error('No buckets available');
	const outDir = opts.outDir ?? buckets[0].supercutsDir;
	onLog(`Buckets: ${buckets.map((b) => b.name).join(', ')}`);

	const sentence = opts.sentence.trim();
	if (!sentence) throw new Error('Sentence is empty');

	const seed = opts.seed ?? Math.floor(Math.random() * 2 ** 31);
	const rand = mulberry32(seed);
	onLog(`Seed: ${seed}`);

	onLog('Indexing transcripts...');
	const index = await buildWordIndex(buckets);
	onLog(`Indexed ${index.size} unique words.`);

	const tokens = sentence.split(/\s+/).filter(Boolean);
	onLog(`Building sentence: "${sentence}" (${tokens.length} words)`);

	const picks: { token: string; hit: Hit; matchedAs: string }[] = [];
	const missing: string[] = [];
	let lastVideo: string | null = null;

	for (const token of tokens) {
		const result = findHitsForWord(token, index);
		if (!result) {
			onLog(`  x no clip for "${token}"`);
			missing.push(token);
			continue;
		}
		const { key, hits } = result;
		const fromOther = hits.filter((h) => h.video !== lastVideo);
		const pool = fromOther.length > 0 ? fromOther : hits;
		const hit = pool[Math.floor(rand() * pool.length)];
		picks.push({ token, hit, matchedAs: key });
		lastVideo = hit.video;
		const keyNote = key === normalize(token) ? '' : ` (matched "${key}")`;
		onLog(`  ok ${token.padEnd(16)} -> "${hit.word}"${keyNote}`);
	}

	if (picks.length === 0) throw new Error('No words could be matched');

	await mkdir(outDir, { recursive: true });
	const slug = slugify(sentence).slice(0, 80);
	const workDir = join(outDir, `.tmp-sentence-${slug}-${Date.now()}`);
	await rm(workDir, { recursive: true, force: true });
	await mkdir(workDir, { recursive: true });

	try {
		const clipPaths: string[] = [];
		for (let i = 0; i < picks.length; i++) {
			throwIfAborted(signal);
			const clipPath = join(workDir, `word-${String(i).padStart(4, '0')}.mp4`);
			await renderWord(picks[i].hit, clipPath, onLog, signal, debug);
			clipPaths.push(clipPath);
		}

		const stamp = timestampSuffix();
		const bucketTag = buckets.length > 1 ? 'mixed' : buckets[0].name;
		const debugTag = debug ? '-debug' : '';
		const outFile = join(outDir, `sentence-${slug}-${bucketTag}${debugTag}-${stamp}.mp4`);
		onLog(`Concatenating -> ${outFile}`);

		const inputArgs: string[] = [];
		for (const p of clipPaths) inputArgs.push('-i', p);
		const labels = clipPaths.map((_, i) => `[${i}:v:0][${i}:a:0]`).join('');
		const filterScript = `${labels}concat=n=${clipPaths.length}:v=1:a=1[outv][outa]`;
		const filterFile = join(workDir, 'concat-filter.txt');
		await writeFile(filterFile, filterScript);

		await runFfmpeg(
			[
				...inputArgs,
				'-/filter_complex',
				filterFile,
				'-map',
				'[outv]',
				'-map',
				'[outa]',
				'-c:v',
				'libx264',
				'-preset',
				'veryfast',
				'-crf',
				'20',
				'-pix_fmt',
				'yuv420p',
				'-r',
				'30',
				'-fps_mode',
				'cfr',
				'-c:a',
				'aac',
				'-ar',
				'48000',
				'-ac',
				'2',
				'-b:a',
				'192k',
				'-movflags',
				'+faststart',
				outFile,
			],
			onLog,
			signal,
		);

		onLog(`Done: ${outFile}`);
		return {
			outFile: resolvePath(outFile),
			picks: picks.map((p) => ({
				token: p.token,
				matchedAs: p.matchedAs,
				word: p.hit.word,
				video: basename(p.hit.video),
			})),
			missing,
		};
	} finally {
		await rm(workDir, { recursive: true, force: true });
	}
}
