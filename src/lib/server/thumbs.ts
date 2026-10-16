import { execFile } from 'node:child_process';
import { lstat, mkdir, readdir, rename, stat, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, extname, join } from 'node:path';
import { promisify } from 'node:util';
import { VIDEO_EXTS, type Bucket } from './paths.js';
import { runFfmpeg } from './ffmpeg.js';

const execFileAsync = promisify(execFile);

/** Frames sampled for the hover strip, as fractions of the runtime. */
const STRIP_POINTS = [0.2, 0.4, 0.6, 0.8];
// Both even: pad rounds 4:2:0 frame sizes down to even, so an odd tile
// (e.g. 240x135) ends up smaller than the scaled frame and pad fails.
const TILE_W = 256;
const TILE_H = 144;

/** Thumbnail strips are cached per bucket in `<bucket>/thumbs/<slug>.jpg`. */
export function thumbsDir(bucket: Bucket): string {
	return join(bucket.dir, 'thumbs');
}

function stripPath(bucket: Bucket, slug: string): string {
	return join(thumbsDir(bucket), `${slug}.jpg`);
}

/** A strip is current when it is a real file (not a symlink) newer than its video. */
async function isCurrent(out: string, video: string): Promise<boolean> {
	const [thumb, source] = await Promise.all([lstat(out).catch(() => null), stat(video)]);
	return Boolean(thumb?.isFile() && thumb.mtimeMs >= source.mtimeMs);
}

/** Create thumbs/, refusing a symlinked dir so writes can't leave the bucket. */
async function ensureThumbsDir(bucket: Bucket): Promise<void> {
	const dir = thumbsDir(bucket);
	const info = await lstat(dir).catch(() => null);
	if (!info) await mkdir(dir, { recursive: true });
	else if (!info.isDirectory()) throw new Error(`${dir} is not a real directory`);
}

export async function findVideoBySlug(bucket: Bucket, slug: string): Promise<string | null> {
	const entries = await readdir(bucket.videosDir).catch(() => [] as string[]);
	for (const f of entries) {
		// Match the Library loader, which keeps the extension's original case.
		if (VIDEO_EXTS.has(extname(f).toLowerCase()) && basename(f, extname(f)) === slug) {
			return join(bucket.videosDir, f);
		}
	}
	return null;
}

async function probeDuration(video: string): Promise<number> {
	const { stdout } = await execFileAsync('ffprobe', [
		'-v',
		'error',
		'-show_entries',
		'format=duration',
		'-of',
		'default=noprint_wrappers=1:nokey=1',
		video,
	]);
	const duration = Number(stdout.trim());
	if (!Number.isFinite(duration) || duration <= 0) throw new Error('Could not read video duration');
	return duration;
}

async function renderStrip(video: string, out: string): Promise<void> {
	const duration = await probeDuration(video);
	const inputs = STRIP_POINTS.flatMap((p) => ['-ss', (duration * p).toFixed(2), '-i', video]);
	// Letterbox each frame into a 16:9 tile so mixed aspect ratios line up.
	const tiles = STRIP_POINTS.map(
		(_, i) =>
			`[${i}:v]scale=${TILE_W}:${TILE_H}:force_original_aspect_ratio=decrease,` +
			`pad=${TILE_W}:${TILE_H}:(ow-iw)/2:(oh-ih)/2,setsar=1[t${i}]`,
	);
	const stack = `${STRIP_POINTS.map((_, i) => `[t${i}]`).join('')}hstack=inputs=${STRIP_POINTS.length}[out]`;
	await runFfmpeg([
		...inputs,
		'-filter_complex',
		[...tiles, stack].join(';'),
		'-map',
		'[out]',
		'-frames:v',
		'1',
		'-q:v',
		'4',
		out,
	]);
}

// Hovering down the table can request many strips at once: share in-flight
// work per file and cap concurrent ffmpeg runs.
const inFlight = new Map<string, Promise<string>>();
const MAX_CONCURRENT = 2;
let running = 0;
const waiting: (() => void)[] = [];

async function withSlot<T>(work: () => Promise<T>): Promise<T> {
	if (running >= MAX_CONCURRENT) await new Promise<void>((r) => waiting.push(r));
	running++;
	try {
		return await work();
	} finally {
		running--;
		waiting.shift()?.();
	}
}

/**
 * Return the path of a 4-frame strip for `video`, generating it if missing,
 * stale, or a symlink. Not cancellable: one render may be shared by a hover
 * request and the ingest backfill, so no single caller may abort it.
 */
export function ensureThumbStrip(bucket: Bucket, slug: string, video: string): Promise<string> {
	const out = stripPath(bucket, slug);
	const pending = inFlight.get(out);
	if (pending) return pending;

	const job = (async () => {
		if (await isCurrent(out, video)) return out;

		await ensureThumbsDir(bucket);
		// Render to a temp name so a half-written file is never served; rename
		// also replaces a symlink rather than writing through it.
		const temp = join(thumbsDir(bucket), `.${slug}.${randomUUID()}.jpg`);
		try {
			await withSlot(() => renderStrip(video, temp));
			await rename(temp, out);
		} finally {
			await unlink(temp).catch(() => {});
		}
		return out;
	})().finally(() => inFlight.delete(out));

	inFlight.set(out, job);
	return job;
}

/**
 * Pre-generate strips for every video that lacks a current one. Run after
 * ingest so new clips have previews before anyone hovers them; already-current
 * strips cost only a stat. Cancellation is checked between videos.
 */
export async function generateMissingThumbs(
	buckets: Bucket[],
	onLog: (line: string) => void = () => {},
	signal?: AbortSignal,
): Promise<{ generated: number; failed: number }> {
	const queue: { bucket: Bucket; slug: string; video: string }[] = [];
	for (const bucket of buckets) {
		const entries = await readdir(bucket.videosDir).catch(() => [] as string[]);
		for (const f of entries) {
			if (!VIDEO_EXTS.has(extname(f).toLowerCase())) continue;
			queue.push({ bucket, slug: basename(f, extname(f)), video: join(bucket.videosDir, f) });
		}
	}

	let generated = 0;
	let failed = 0;
	async function worker() {
		for (let item = queue.shift(); item && !signal?.aborted; item = queue.shift()) {
			const { bucket, slug, video } = item;
			try {
				if (await isCurrent(stripPath(bucket, slug), video)) continue;
				await ensureThumbStrip(bucket, slug, video);
				generated++;
			} catch (err) {
				failed++;
				onLog(`thumb failed: ${bucket.name}/${slug}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	}
	await Promise.all(Array.from({ length: MAX_CONCURRENT }, worker));
	onLog(`Thumbnails: ${generated} generated, ${failed} failed.`);
	return { generated, failed };
}
