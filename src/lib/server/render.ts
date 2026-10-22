import { writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { runFfmpeg, throwIfAborted, CancelledError, type LogFn } from './ffmpeg.js';

const SEGMENT_FPS = 30;
export const SEGMENT_AUDIO_RATE = 48000;
const AUDIO_CHANNELS = 2;
const AUDIO_SAMPLES_PER_FRAME = SEGMENT_AUDIO_RATE / SEGMENT_FPS;
const DEFAULT_CONCURRENCY = 4;

export interface RenderSegment {
	path: string;
	frameCount: number;
}

export type RenderTask<T> = (signal: AbortSignal, onLog: LogFn, index: number) => Promise<T>;

export interface RenderSegmentsOptions {
	concurrency?: number;
	signal?: AbortSignal;
	onLog?: LogFn;
}

export function frameCountForDuration(duration: number): number {
	return Math.max(1, Math.round(duration * SEGMENT_FPS));
}

/** How long a segment of this planned duration really runs in the render (whole frames). */
export function renderedDuration(duration: number): number {
	return frameCountForDuration(duration) / SEGMENT_FPS;
}

export function segmentAudioFilter(frameCount: number): string {
	const sampleCount = frameCount * AUDIO_SAMPLES_PER_FRAME;
	return `aformat=sample_rates=${SEGMENT_AUDIO_RATE}:channel_layouts=stereo,apad=whole_len=${sampleCount},atrim=end_sample=${sampleCount},asetpts=PTS-STARTPTS`;
}

export function segmentEncodeArgs(frameCount: number): string[] {
	return [
		'-frames:v',
		String(frameCount),
		'-c:v',
		'libx264',
		'-preset',
		'veryfast',
		'-crf',
		'20',
		'-pix_fmt',
		'yuv420p',
		'-r',
		String(SEGMENT_FPS),
		'-fps_mode',
		'cfr',
		'-video_track_timescale',
		'15360',
		'-c:a',
		'pcm_s16le',
		'-ar',
		String(SEGMENT_AUDIO_RATE),
		'-ac',
		String(AUDIO_CHANNELS),
	];
}

function configuredConcurrency(value: number | undefined): number {
	if (value !== undefined && Number.isFinite(value)) return Math.max(1, Math.floor(value));
	const fromEnv = Number.parseInt(process.env.SYNTAX_RENDER_CONCURRENCY ?? '', 10);
	return Number.isFinite(fromEnv) ? Math.max(1, fromEnv) : DEFAULT_CONCURRENCY;
}

/** Render indexed tasks in parallel while preserving their result order. */
export async function renderSegments<T>(
	tasks: readonly RenderTask<T>[],
	options: RenderSegmentsOptions = {},
): Promise<T[]> {
	throwIfAborted(options.signal);
	if (tasks.length === 0) return [];

	const controller = new AbortController();
	const onExternalAbort = () => controller.abort();
	options.signal?.addEventListener('abort', onExternalAbort, { once: true });

	const results: T[] = new Array(tasks.length);
	let nextIndex = 0;
	let firstError: unknown;
	let hasFirstError = false;
	const concurrency = Math.min(tasks.length, configuredConcurrency(options.concurrency));

	const worker = async () => {
		while (!controller.signal.aborted) {
			const index = nextIndex++;
			if (index >= tasks.length) return;
			const taskLog: LogFn = (line) => options.onLog?.(`[${index + 1}/${tasks.length}] ${line}`);
			try {
				results[index] = await tasks[index](controller.signal, taskLog, index);
			} catch (err) {
				if (!hasFirstError) {
					firstError = err;
					hasFirstError = true;
				}
				controller.abort();
				return;
			}
		}
	};

	try {
		await Promise.all(Array.from({ length: concurrency }, () => worker()));
	} finally {
		options.signal?.removeEventListener('abort', onExternalAbort);
	}

	if (options.signal?.aborted) throw new CancelledError();
	if (hasFirstError) throw firstError;
	return results;
}

/** Join PCM-audio MOV segments without re-encoding their H.264 video. */
export async function concatSegments(
	segments: readonly RenderSegment[],
	outFile: string,
	workDir: string,
	onLog: LogFn = () => {},
	signal?: AbortSignal,
): Promise<void> {
	throwIfAborted(signal);
	const listFile = join(workDir, 'concat.ffconcat');
	const list = [
		'ffconcat version 1.0',
		...segments.flatMap(({ path, frameCount }) => [
			`file '${basename(path)}'`,
			`duration ${(frameCount / SEGMENT_FPS).toFixed(9)}`,
		]),
		'',
	].join('\n');
	await writeFile(listFile, list);

	await runFfmpeg(
		[
			'-f',
			'concat',
			'-safe',
			'0',
			'-i',
			listFile,
			'-map',
			'0:v:0',
			'-map',
			'0:a:0',
			'-c:v',
			'copy',
			'-c:a',
			'aac',
			'-b:a',
			'192k',
			'-ar',
			String(SEGMENT_AUDIO_RATE),
			'-ac',
			String(AUDIO_CHANNELS),
			'-avoid_negative_ts',
			'disabled',
			'-video_track_timescale',
			'15360',
			'-movflags',
			'+faststart',
			outFile,
		],
		onLog,
		signal,
	);
}
