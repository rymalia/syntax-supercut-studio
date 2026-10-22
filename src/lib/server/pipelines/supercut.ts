import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import { resolveBuckets } from '../paths.js';
import { runFfmpeg, atempoChain, throwIfAborted, type LogFn } from '../ffmpeg.js';
import { slugify, timestampSuffix, type Hit } from '../text.js';
import { collectHits } from '../hits.js';
import { drawTextFilter } from '../drawtext.js';
import { clipId, writeCutList, type CutClip, type CutMarker, type CutText } from '../cutlist.js';

const CANVAS_W = 1280;
const CANVAS_H = 720;

const TILE_TOLERANCE = 0.25;
const TILE_MAX = 4;
const TILE_EVERY_MIN = 4;
const TILE_EVERY_MAX = 6;
const TILE_MIN_SIZE = 3;
const TILE_MIN_DURATION = 0.35;
const TILE_MAX_DURATION = 0.9;
const TILE_MAX_SLOWDOWN = 1.8;
const TILE_MAX_SPEEDUP = 1.8;

function shuffle<T>(arr: T[]): T[] {
	for (let i = arr.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[arr[i], arr[j]] = [arr[j], arr[i]];
	}
	return arr;
}

function randInt(min: number, max: number): number {
	return Math.floor(Math.random() * (max - min + 1)) + min;
}

function bucketByDuration(hits: Hit[]): Hit[][] {
	const sorted = [...hits].sort((a, b) => a.end - a.start - (b.end - b.start));
	const buckets: Hit[][] = [];
	let current: Hit[] = [];
	let anchor = -1;
	for (const h of sorted) {
		const dur = h.end - h.start;
		if (current.length === 0) {
			current.push(h);
			anchor = dur;
			continue;
		}
		if (Math.abs(dur - anchor) <= TILE_TOLERANCE && current.length < TILE_MAX) {
			current.push(h);
		} else {
			buckets.push(current);
			current = [h];
			anchor = dur;
		}
	}
	if (current.length > 0) buckets.push(current);
	return buckets;
}

function planSegments(hits: Hit[]): Hit[][] {
	const buckets = bucketByDuration(hits).map((b) => shuffle([...b]));
	const segments: Hit[][] = [];
	let nextTileIn = randInt(TILE_EVERY_MIN, TILE_EVERY_MAX);
	const tileReady = () => buckets.some((b) => b.length >= TILE_MIN_SIZE);
	const totalRemaining = () => buckets.reduce((sum, b) => sum + b.length, 0);

	while (totalRemaining() > 0) {
		if (nextTileIn <= 0 && tileReady()) {
			const eligible = buckets.filter((b) => b.length >= TILE_MIN_SIZE);
			eligible.sort((a, b) => b.length - a.length);
			const bucket = eligible[0];
			const take = Math.min(bucket.length, TILE_MAX);
			segments.push(bucket.splice(0, take));
			nextTileIn = randInt(TILE_EVERY_MIN, TILE_EVERY_MAX);
			continue;
		}
		const flatBuckets = buckets.filter((b) => b.length > 0);
		if (flatBuckets.length === 0) break;
		const bucket = flatBuckets[Math.floor(Math.random() * flatBuckets.length)];
		const idx = Math.floor(Math.random() * bucket.length);
		const [hit] = bucket.splice(idx, 1);
		segments.push([hit]);
		nextTileIn--;
	}

	return segments;
}

function gridFor(n: number): { cols: number; rows: number } {
	const cols = Math.ceil(Math.sqrt(n));
	const rows = Math.ceil(n / cols);
	return { cols, rows };
}

/** Per-hit playback speed in a tile: fits each word to the tile duration, clamped. */
function tileSpeeds(group: Hit[], duration: number): number[] {
	return group.map((h) => {
		const wordDur = Math.max(0.05, h.end - h.start);
		return Math.min(TILE_MAX_SPEEDUP, Math.max(1 / TILE_MAX_SLOWDOWN, wordDur / duration));
	});
}

async function renderSingle(
	hit: Hit,
	outPath: string,
	debug: boolean,
	onLog: LogFn,
	signal?: AbortSignal,
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

async function renderTile(
	group: Hit[],
	outPath: string,
	debug: boolean,
	onLog: LogFn,
	signal?: AbortSignal,
): Promise<void> {
	const n = group.length;
	const { cols, rows } = gridFor(n);
	const tileW = Math.floor(CANVAS_W / cols);
	const tileH = Math.floor(CANVAS_H / rows);

	const duration = tileDuration(group);

	const inputs: string[] = [];
	const speeds = tileSpeeds(group, duration);
	for (const h of group) {
		const preRoll = Math.min(0.25, h.start);
		inputs.push('-ss', (h.start - preRoll).toFixed(3), '-i', h.video);
	}

	const videoParts: string[] = [];
	const audioLabels: string[] = [];
	for (let i = 0; i < n; i++) {
		const h = group[i];
		const speed = speeds[i];
		const preRoll = Math.min(0.25, h.start);
		const wordStart = preRoll;
		const wordEnd = preRoll + (h.end - h.start);

		const tileFontSize = Math.max(28, Math.round(tileH / 5));
		const debugFilter = debug ? `,${drawTextFilter(h.word, tileFontSize)}` : '';
		videoParts.push(
			`[${i}:v]trim=start=${wordStart.toFixed(3)}:end=${wordEnd.toFixed(3)},setpts=(PTS-STARTPTS)/${speed.toFixed(6)},scale=${tileW}:${tileH}:force_original_aspect_ratio=decrease,pad=${tileW}:${tileH}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,trim=duration=${duration.toFixed(3)},setpts=PTS-STARTPTS${debugFilter}[v${i}]`,
		);
		audioLabels.push(
			`[${i}:a]atrim=start=${wordStart.toFixed(3)}:end=${wordEnd.toFixed(3)},asetpts=PTS-STARTPTS,${atempoChain(speed)},atrim=duration=${duration.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`,
		);
	}

	const layoutParts: string[] = [];
	for (let i = 0; i < n; i++) {
		const col = i % cols;
		const row = Math.floor(i / cols);
		const x = col === 0 ? '0' : Array.from({ length: col }, (_, k) => `w${k}`).join('+');
		const y = row === 0 ? '0' : Array.from({ length: row }, (_, k) => `h${k * cols}`).join('+');
		layoutParts.push(`${x}_${y}`);
	}
	const vInputs = Array.from({ length: n }, (_, i) => `[v${i}]`).join('');
	const aInputs = audioLabels.map((_, i) => `[a${i}]`).join('');

	let videoChain: string;
	if (n === 1) {
		videoChain = `[v0]pad=${CANVAS_W}:${CANVAS_H}:(ow-iw)/2:(oh-ih)/2:color=black[vout]`;
	} else {
		videoChain = `${vInputs}xstack=inputs=${n}:layout=${layoutParts.join('|')}:fill=black[vstack];[vstack]pad=${CANVAS_W}:${CANVAS_H}:(ow-iw)/2:(oh-ih)/2:color=black[vout]`;
	}

	const audioChain =
		n === 1
			? `[a0]acopy[aout]`
			: `${aInputs}amix=inputs=${n}:duration=shortest:normalize=0[aout]`;

	const filter = [...videoParts, ...audioLabels, videoChain, audioChain].join(';');

	await runFfmpeg(
		[
			...inputs,
			'-filter_complex',
			filter,
			'-map',
			'[vout]',
			'-map',
			'[aout]',
			'-t',
			duration.toFixed(3),
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

export interface SupercutOptions {
	target?: string;
	regex?: RegExp | null;
	tile?: boolean;
	limit?: number | null;
	debug?: boolean;
	/** Bucket names to search. null or empty = all buckets. */
	buckets?: string[] | null;
	/**
	 * Where to write the output. Defaults to the first selected bucket's
	 * supercuts/ folder.
	 */
	outDir?: string;
	/**
	 * When true, skip all ffmpeg work and return an estimate (hit count,
	 * segment count, estimated duration) instead of rendering anything.
	 */
	dryRun?: boolean;
	onLog?: LogFn;
	signal?: AbortSignal;
}

export interface SupercutResult {
	outFile: string;
	/** Cut list v1 beside the mp4 (`<render>.cuts.json`); null on dry runs or if writing failed. */
	cutsFile?: string | null;
	totalHits: number;
	segments: number;
	tiledSegments: number;
	/** Estimated or actual final video duration (seconds). */
	estimatedDurationSec: number;
	dryRun: boolean;
}

/** Tile duration matches renderTile(): clamp(median word duration, MIN, MAX). */
function tileDuration(group: Hit[]): number {
	const durs = group.map((h) => h.end - h.start).sort((a, b) => a - b);
	const median = durs[Math.floor(durs.length / 2)];
	return Math.min(TILE_MAX_DURATION, Math.max(TILE_MIN_DURATION, median));
}

/** Predict the total output duration without rendering. */
function estimateTotalDuration(groups: Hit[][]): number {
	let total = 0;
	for (const g of groups) {
		if (g.length === 1) total += g[0].end - g[0].start;
		else total += tileDuration(g);
	}
	return total;
}

/** Cut list v1 for a render: a solo hit is one clip; a tile is one clip per hit at the same `rec`, placed at its cell. */
function cutListFor(groups: Hit[][]): { clips: CutClip[]; captions: CutText[]; markers: CutMarker[] } {
	const clips: CutClip[] = [];
	const captions: CutText[] = [];
	const markers: CutMarker[] = [];
	let rec = 0;
	for (let i = 0; i < groups.length; i++) {
		const g = groups[i];
		const duration = g.length === 1 ? g[0].end - g[0].start : tileDuration(g);
		const speeds = g.length === 1 ? [1] : tileSpeeds(g, duration);
		// Mirror renderTile's xstack layout: equal cells, the grid centred by the final pad.
		const { cols, rows } = gridFor(g.length);
		const tileW = Math.floor(CANVAS_W / cols);
		const tileH = Math.floor(CANVAS_H / rows);
		const padX = Math.floor((CANVAS_W - cols * tileW) / 2);
		const padY = Math.floor((CANVAS_H - rows * tileH) / 2);
		for (let j = 0; j < g.length; j++) {
			const h = g[j];
			const col = j % cols;
			const row = Math.floor(j / cols);
			clips.push({
				video: h.video,
				track: j + 1,
				rec,
				in: h.start,
				// renderTile trims each source at the word's end, so a word clamped at the
				// slowdown limit ends before the tile does; the cut ends where the render does.
				out: g.length === 1 ? h.end : Math.min(h.end, h.start + duration * speeds[j]),
				speed: speeds[j],
				rect:
					g.length === 1
						? null
						: [(padX + col * tileW) / CANVAS_W, (padY + row * tileH) / CANVAS_H, tileW / CANVAS_W, tileH / CANVAS_H],
				name: h.word,
			});
		}
		captions.push({ start: rec, end: rec + duration, text: [...new Set(g.map((h) => h.word))].join(' / ') });
		markers.push({
			t: rec,
			name: g.length === 1 ? `hit ${i + 1}/${groups.length}` : `tile x${g.length} ${i + 1}/${groups.length}`,
			note: g.map((h) => `${clipId(h.video)} ${h.start.toFixed(2)}`).join(', '),
		});
		rec += duration;
	}
	return { clips, captions, markers };
}

export async function buildSupercut(opts: SupercutOptions): Promise<SupercutResult> {
	const target = opts.target ?? '';
	const regex = opts.regex ?? null;
	const tile = opts.tile ?? false;
	const limit = opts.limit ?? null;
	const debug = opts.debug ?? false;
	const dryRun = opts.dryRun ?? false;
	const onLog = opts.onLog ?? (() => {});
	const signal = opts.signal;

	// Resolve buckets so we can (a) search only the selected ones and
	// (b) figure out where to write the output.
	const buckets = await resolveBuckets(opts.buckets);
	if (buckets.length === 0) throw new Error('No buckets available');
	const outDir = opts.outDir ?? buckets[0].supercutsDir;
	onLog(`Buckets: ${buckets.map((b) => b.name).join(', ')}`);

	if (regex) onLog(`Searching for regex ${regex}`);
	else onLog(`Searching for "${target}"`);

	const hits = await collectHits({
		target,
		regex,
		buckets: buckets.map((b) => b.name),
		onLog,
	});
	onLog(`Total hits: ${hits.length}`);
	if (hits.length === 0) throw new Error('No hits found');

	let groups: Hit[][];
	let tiledSegments = 0;
	if (tile) {
		groups = planSegments(hits);
		tiledSegments = groups.filter((g) => g.length > 1).length;
		onLog(
			`Tile mode: ${groups.length} segments (${tiledSegments} tiled, ${groups.length - tiledSegments} solo)`,
		);
	} else {
		shuffle(hits);
		groups = hits.map((h) => [h]);
		onLog('Shuffled clip order.');
	}

	if (limit != null && groups.length > limit) {
		onLog(`Limiting to ${limit} of ${groups.length} segments.`);
		groups = groups.slice(0, limit);
	}

	// Estimate the final runtime without touching ffmpeg. For dry-run this IS
	// the final answer; for real runs it's logged as a preview up front.
	const estimatedDurationSec = estimateTotalDuration(groups);
	const mins = Math.floor(estimatedDurationSec / 60);
	const secs = (estimatedDurationSec - mins * 60).toFixed(1);
	onLog(`Estimated output: ${groups.length} segments, ~${mins}m ${secs}s`);

	if (dryRun) {
		onLog('Dry run — skipping render.');
		return {
			outFile: '',
			totalHits: hits.length,
			segments: groups.length,
			tiledSegments,
			estimatedDurationSec,
			dryRun: true,
		};
	}

	const slug = regex
		? `regex-${slugify(regex.source) || 'pattern'}`.slice(0, 60)
		: slugify(target);

	await mkdir(outDir, { recursive: true });
	const workDir = join(outDir, `.tmp-${slug}-${Date.now()}`);
	await rm(workDir, { recursive: true, force: true });
	await mkdir(workDir, { recursive: true });

	const clipPaths: string[] = [];
	try {
		for (let i = 0; i < groups.length; i++) {
			throwIfAborted(signal);
			const g = groups[i];
			const clipPath = join(workDir, `clip-${String(i).padStart(4, '0')}.mp4`);
			onLog(`[${i + 1}/${groups.length}] ${g.length === 1 ? 'solo' : `tile x${g.length}`}`);
			if (g.length === 1) {
				await renderSingle(g[0], clipPath, debug, onLog, signal);
			} else {
				await renderTile(g, clipPath, debug, onLog, signal);
			}
			clipPaths.push(clipPath);
		}

		// Append a YYYYMMDD-hhmmss timestamp so re-runs with the same target/flags
		// don't overwrite earlier versions (and the browser doesn't serve the
		// cached copy of the same URL either).
		const stamp = timestampSuffix();
		const suffix = `${tile ? '-tiled' : ''}${debug ? '-debug' : ''}`;
		const bucketTag = buckets.length > 1 ? 'mixed' : buckets[0].name;
		const outFile = join(outDir, `${slug}-supercut${suffix}-${bucketTag}-${stamp}.mp4`);
		onLog(`Concatenating ${clipPaths.length} segments -> ${outFile}`);

		const inputArgs: string[] = [];
		for (const p of clipPaths) inputArgs.push('-i', p);
		const filterParts: string[] = [];
		for (let i = 0; i < clipPaths.length; i++) filterParts.push(`[${i}:v:0][${i}:a:0]`);
		const filterScript = `${filterParts.join('')}concat=n=${clipPaths.length}:v=1:a=1[outv][outa]`;
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

		// The cut list sits beside the mp4 so the render can be exported to an
		// editor later. A failure here shouldn't lose the finished render.
		// The cut list sits beside the mp4 so the render can be exported to an
		// editor later. A failure here shouldn't lose the finished render.
		let cutsFile: string | null = null;
		try {
			const cuts = cutListFor(groups);
			cutsFile = resolvePath(await writeCutList(outFile, 'supercut', cuts.clips, cuts.captions, cuts.markers));
			onLog(`Cut list: ${cutsFile}`);
		} catch (err) {
			onLog(`Warning: could not write the cut list: ${err instanceof Error ? err.message : err}`);
		}

		onLog(`Done: ${outFile}`);
		return {
			outFile: resolvePath(outFile),
			cutsFile,
			totalHits: hits.length,
			segments: groups.length,
			tiledSegments,
			estimatedDurationSec,
			dryRun: false,
		};
	} finally {
		await rm(workDir, { recursive: true, force: true });
	}
}
