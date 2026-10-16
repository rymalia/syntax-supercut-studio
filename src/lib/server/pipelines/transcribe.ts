import { randomUUID } from 'node:crypto';
import { readFile, readdir, mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { resolveBuckets, VIDEO_EXTS, AUDIO_EXTS, type Bucket } from '../paths.js';
import { runDetachedProcess } from '../engine.js';
import { runFfmpeg, throwIfAborted, CancelledError, type LogFn } from '../ffmpeg.js';

// Every extension the transcriber can accept as input. Must match the set
// the library loader uses so the UI count and the pipeline count agree.
const MEDIA_EXTS = new Set<string>([...VIDEO_EXTS, ...AUDIO_EXTS, '.opus']);

const STT_URL = 'https://api.x.ai/v1/stt';
const UPLOAD_CAP_MB = 500;

export type TranscriptionEngine = 'parakeet-mlx' | 'xai';

export interface STTWord {
	text: string;
	start: number;
	end: number;
	confidence?: number;
	speaker?: number;
}

export interface STTResponse {
	text: string;
	language?: string;
	duration: number;
	words?: STTWord[];
	confidence?: number;
	speaker?: number;
}

interface TranscriptionConfig {
	engine: 'parakeet' | 'xai';
	fallback: 'xai' | 'none';
}

interface InputMedia {
	inputPath: string;
	hasMp3: boolean;
}

interface ParakeetToken {
	text: string;
	start: number;
	end: number;
	confidence?: number;
}

interface TranscriptOutcome {
	bucket: string;
	slug: string;
	engine: TranscriptionEngine;
	fallbackReason?: string;
}

function apiKey(): string {
	const k = process.env.XAI_API_KEY;
	if (!k) throw new Error('XAI_API_KEY environment variable is not set');
	return k;
}

function config(): TranscriptionConfig {
	const engine = process.env.SYNTAX_TRANSCRIBE_ENGINE ?? 'parakeet';
	if (engine !== 'parakeet' && engine !== 'xai') {
		throw new Error('SYNTAX_TRANSCRIBE_ENGINE must be parakeet or xai');
	}
	const fallback = process.env.SYNTAX_TRANSCRIBE_FALLBACK ?? 'xai';
	if (fallback !== 'xai' && fallback !== 'none') {
		throw new Error('SYNTAX_TRANSCRIBE_FALLBACK must be xai or none');
	}
	return { engine, fallback };
}

/**
 * Passed as --model so the app doesn't inherit a shell-wide PARAKEET_MODEL (one
 * pins the English-only v2); v3 keeps non-English transcription local.
 */
export function parakeetModel(): string {
	return process.env.SYNTAX_PARAKEET_MODEL || 'mlx-community/parakeet-tdt-0.6b-v3';
}

function parakeetBin(): string {
	const configured = process.env.PARAKEET_MLX_BIN ?? join(homedir(), '.local/bin/parakeet-mlx');
	return configured.startsWith('~/') ? join(homedir(), configured.slice(2)) : configured;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function wasCancelled(err: unknown, signal?: AbortSignal): boolean {
	return err instanceof CancelledError || Boolean(signal?.aborted);
}

export async function transcribeFile(
	filePath: string,
	options: { language?: string; diarize?: boolean; signal?: AbortSignal } = {},
): Promise<STTResponse> {
	const { language = 'en', diarize = false, signal } = options;
	const buffer = await readFile(filePath);
	const filename = basename(filePath);
	const ext = extname(filePath).toLowerCase().replace('.', '') || 'mp4';

	const form = new FormData();
	form.append('language', language);
	if (diarize) form.append('diarize', 'true');
	const blob = new Blob([new Uint8Array(buffer)], { type: `audio/${ext}` });
	form.append('file', blob, filename);

	const res = await fetch(STT_URL, {
		method: 'POST',
		headers: { Authorization: `Bearer ${apiKey()}` },
		body: form,
		signal,
	});

	if (!res.ok) {
		const errText = await res.text();
		throw new Error(`STT request failed (${res.status}): ${errText}`);
	}
	return (await res.json()) as STTResponse;
}

async function extractMp3(
	sourcePath: string,
	destPath: string,
	onLog: LogFn,
	signal?: AbortSignal,
): Promise<void> {
	onLog(`Extracting mp3 -> ${basename(destPath)}`);
	await runFfmpeg(
		[
			'-i', sourcePath, '-vn', '-c:a', 'libmp3lame', '-q:a', '2', '-ar', '44100', '-ac', '2', destPath,
		],
		onLog,
		signal,
	);
}

async function extractWav(
	sourcePath: string,
	destPath: string,
	onLog: LogFn,
	signal?: AbortSignal,
): Promise<void> {
	await runFfmpeg(
		['-i', sourcePath, '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', destPath],
		onLog,
		signal,
	);
}

async function findInput(bucket: Bucket, slug: string): Promise<InputMedia> {
	const mp3Path = join(bucket.videosDir, `${slug}.mp3`);
	if (await stat(mp3Path).then(() => true, () => false)) return { inputPath: mp3Path, hasMp3: true };

	let entries: string[];
	try {
		entries = await readdir(bucket.videosDir);
	} catch {
		throw new Error(`No media file found for ${slug} in bucket ${bucket.name}`);
	}
	const match = entries.find(
		(file) => MEDIA_EXTS.has(extname(file).toLowerCase()) && basename(file, extname(file)) === slug,
	);
	if (!match) throw new Error(`No media file found for ${slug} in bucket ${bucket.name}`);
	return { inputPath: join(bucket.videosDir, match), hasMp3: false };
}

async function writeTranscriptAtomic(outFile: string, value: object): Promise<void> {
	const temp = join(dirname(outFile), `.${basename(outFile)}.${randomUUID()}.tmp`);
	try {
		await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
		await rename(temp, outFile);
	} finally {
		await rm(temp, { force: true }).catch(() => {});
	}
}

/**
 * Same grouping as the engine's `analyze.py` `load_words`, so app and engine
 * transcripts of one clip agree: a token with leading whitespace (including a
 * whitespace-only token, as before `$`) or the first token of a sentence starts
 * a word; a word with no letters or digits is attached to the previous word.
 */
function groupParakeetTokens(sentences: ParakeetToken[][]): STTWord[] {
	const grouped: { parts: ParakeetToken[] }[] = [];

	for (const tokens of sentences) {
		for (const [index, token] of tokens.entries()) {
			// A whitespace-only token opens the word and lends it its start time (numbers start this way).
			if (index === 0 || /^\s/.test(token.text) || !grouped.length) grouped.push({ parts: [token] });
			else grouped[grouped.length - 1].parts.push(token);
		}
	}

	// An attached punctuation word adds its text but not its timing, as in the engine,
	// which also drops one with nothing before it.
	const words: { parts: ParakeetToken[]; suffix: string }[] = [];
	for (const word of grouped) {
		const text = word.parts.map((part) => part.text).join('');
		if (/[\p{L}\p{N}]/u.test(text)) words.push({ parts: word.parts, suffix: '' });
		else if (words.length) words[words.length - 1].suffix += text.trim();
	}

	return words.flatMap(({ parts, suffix }) => {
		const text = (parts.map((part) => part.text).join('') + suffix).replace(/\s+/g, '').trim();
		if (!text) return [];

		const confidences = parts.filter(
			(part): part is ParakeetToken & { confidence: number } =>
				typeof part.confidence === 'number' && Number.isFinite(part.confidence),
		);
		let confidence: number | undefined;
		if (confidences.length) {
			const totalDuration = confidences.reduce((sum, part) => sum + part.end - part.start, 0);
			confidence = totalDuration > 0
				? confidences.reduce((sum, part) => sum + part.confidence * (part.end - part.start), 0) / totalDuration
				: confidences.reduce((sum, part) => sum + part.confidence, 0) / confidences.length;
		}
		return [{
			text,
			start: parts[0].start,
			end: Math.max(...parts.map((part) => part.end)),
			...(confidence === undefined ? {} : { confidence }),
		} satisfies STTWord];
	});
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
}

export function parseParakeet(value: unknown, source: string): { text: string; duration: number; words: STTWord[]; engine: 'parakeet-mlx'; model: string } {
	const root = record(value, `Parakeet output for ${source}`);
	if (typeof root.text !== 'string') throw new Error(`Parakeet output for ${source} has no text`);
	if (!Array.isArray(root.sentences)) throw new Error(`Parakeet output for ${source} has no sentences`);

	const sentences: ParakeetToken[][] = [];
	for (const [sentenceIndex, sentenceValue] of root.sentences.entries()) {
		const tokens: ParakeetToken[] = [];
		sentences.push(tokens);
		const sentence = record(sentenceValue, `Parakeet sentence ${sentenceIndex} for ${source}`);
		if (!Array.isArray(sentence.tokens)) throw new Error(`Parakeet sentence ${sentenceIndex} for ${source} has no tokens`);
		for (const [tokenIndex, tokenValue] of sentence.tokens.entries()) {
			const token = record(tokenValue, `Parakeet token ${sentenceIndex}:${tokenIndex} for ${source}`);
			if (typeof token.text !== 'string') throw new Error(`Parakeet token ${sentenceIndex}:${tokenIndex} has no text`);
			if (typeof token.start !== 'number' || !Number.isFinite(token.start) || token.start < 0) {
				throw new Error(`Invalid Parakeet start timing at ${sentenceIndex}:${tokenIndex}`);
			}
			if (typeof token.end !== 'number' || !Number.isFinite(token.end) || token.end < 0 || token.start > token.end) {
				throw new Error(`Invalid Parakeet end timing at ${sentenceIndex}:${tokenIndex}`);
			}
			tokens.push({
				text: token.text,
				start: token.start,
				end: token.end,
				...(typeof token.confidence === 'number' && Number.isFinite(token.confidence)
					? { confidence: token.confidence }
					: {}),
			});
		}
	}

	const words = groupParakeetTokens(sentences);
	const duration = words.length ? Math.round(Math.max(...words.map((word) => word.end)) * 1000) / 1000 : 0;
	return { text: root.text, duration, words, engine: 'parakeet-mlx', model: parakeetModel() };
}

function forwardLines(onLog: LogFn) {
	let pending = '';
	return {
		write(chunk: Buffer) {
			pending += chunk.toString('utf8');
			const lines = pending.split(/\r?\n/);
			// A bare \r redraws a progress bar in place: keep only its latest frame.
			pending = (lines.pop() ?? '').split('\r').pop() ?? '';
			for (const line of lines) {
				const frame = line.split('\r').pop()?.trim();
				if (frame) onLog(frame);
			}
		},
		flush() {
			const frame = pending.trim();
			if (frame) onLog(frame);
		},
	};
}

async function runParakeet(
	wavPaths: string[],
	rawDir: string,
	onLog: LogFn,
	signal?: AbortSignal,
): Promise<void> {
	await mkdir(rawDir, { recursive: true });
	const stdout = forwardLines(onLog);
	const stderr = forwardLines(onLog);
	onLog(`Starting parakeet-mlx (${parakeetModel()}) for ${wavPaths.length} file(s)...`);
	const { code, stderr: tail } = await runDetachedProcess(
		parakeetBin(),
		[...wavPaths, '--model', parakeetModel(), '--output-format', 'json', '--output-dir', rawDir],
		{
			signal,
			onStdout: (chunk) => stdout.write(chunk),
			onStderr: (chunk) => stderr.write(chunk),
		},
	);
	stdout.flush();
	stderr.flush();
	if (code !== 0) throw new Error(`parakeet-mlx exited ${code ?? 'unknown'}${tail.trim() ? `: ${tail.trim().slice(-500)}` : ''}`);
}

/** Python's json.dump writes bare NaN/Infinity (seen as a sentence `confidence`); read them as null. */
export function parseParakeetJson(raw: string): unknown {
	// Alternation skips whole string literals, so words inside transcript text are never touched.
	return JSON.parse(raw.replace(/("(?:[^"\\]|\\.)*")|-?\b(?:NaN|Infinity)\b/g, (match, string) => string ?? 'null'));
}

async function readParakeetOutput(rawPath: string, source: string) {
	let parsed: unknown;
	try {
		parsed = parseParakeetJson(await readFile(rawPath, 'utf8'));
	} catch (err) {
		throw new Error(`Invalid or missing Parakeet output for ${source}: ${errorMessage(err)}`);
	}
	return parseParakeet(parsed, source);
}

export interface TranscribeOneOptions {
	/** Bucket name the media lives in. */
	bucket: string;
	/** Media filename stem (no extension). */
	slug: string;
	language?: string;
	diarize?: boolean;
	overwrite?: boolean;
	onLog?: LogFn;
	signal?: AbortSignal;
}

export interface TranscribeOneResult {
	outFile: string;
	durationSec: number;
	words: number;
	uploadedMB: number;
	bucket: string;
	extractedMp3: boolean;
	engine: TranscriptionEngine;
	fallbackReason?: string;
}

function onLogMessage(opts: TranscribeOneOptions, message: string): void {
	(opts.onLog ?? (() => {}))(message);
}

async function transcribeWithXai(
	bucket: Bucket,
	slug: string,
	outFile: string,
	input: InputMedia,
	opts: TranscribeOneOptions,
	fallbackReason?: string,
): Promise<TranscribeOneResult> {
	apiKey(); // fail before extracting or logging an upload when no key is set
	let inputPath = input.inputPath;
	let info = await stat(inputPath);
	let sizeMb = info.size / 1024 / 1024;
	let extractedMp3 = false;

	if (sizeMb > UPLOAD_CAP_MB) {
		if (input.hasMp3) throw new Error(`${basename(inputPath)} is ${sizeMb.toFixed(1)} MB (> ${UPLOAD_CAP_MB} MB upload cap).`);
		onLogMessage(opts, `${basename(inputPath)} is ${sizeMb.toFixed(1)} MB (> ${UPLOAD_CAP_MB} MB upload cap). Extracting mp3 first...`);
		const mp3Path = join(bucket.videosDir, `${slug}.mp3`);
		await extractMp3(inputPath, mp3Path, opts.onLog ?? (() => {}), opts.signal);
		extractedMp3 = true;
		inputPath = mp3Path;
		info = await stat(inputPath);
		sizeMb = info.size / 1024 / 1024;
		onLogMessage(opts, `Extracted ${basename(mp3Path)} (${sizeMb.toFixed(1)} MB).`);
		if (sizeMb > UPLOAD_CAP_MB) throw new Error(`Even the extracted mp3 is ${sizeMb.toFixed(1)} MB (> ${UPLOAD_CAP_MB} MB). Source is too long to transcribe in one shot.`);
	}

	onLogMessage(opts, `Uploading ${basename(inputPath)} (${sizeMb.toFixed(1)} MB)...`);
	const started = Date.now();
	const result = await transcribeFile(inputPath, { language: opts.language, diarize: opts.diarize, signal: opts.signal });
	throwIfAborted(opts.signal);
	const elapsed = (Date.now() - started) / 1000;
	onLogMessage(opts, `Received ${result.duration}s of audio, ${result.words?.length ?? 0} words in ${elapsed.toFixed(1)}s`);

	const transcript = {
		...result,
		words: result.words ?? [],
		engine: 'xai' as const,
		...(fallbackReason ? { fallbackFrom: 'parakeet-mlx' as const, fallbackReason } : {}),
	};
	await writeTranscriptAtomic(outFile, transcript);
	onLogMessage(opts, `Wrote ${outFile}`);

	return {
		outFile,
		durationSec: result.duration,
		words: result.words?.length ?? 0,
		uploadedMB: Number(sizeMb.toFixed(1)),
		bucket: bucket.name,
		extractedMp3,
		engine: 'xai',
		...(fallbackReason ? { fallbackReason } : {}),
	};
}

async function fallbackOne(
	bucket: Bucket,
	slug: string,
	outFile: string,
	input: InputMedia,
	opts: TranscribeOneOptions,
	localError: unknown,
	fallback: 'xai' | 'none',
): Promise<TranscribeOneResult> {
	if (wasCancelled(localError, opts.signal)) throw new CancelledError();
	const reason = errorMessage(localError);
	if (fallback === 'none') throw localError instanceof Error ? localError : new Error(reason);
	throwIfAborted(opts.signal);
	onLogMessage(opts, `Falling back to xAI for ${bucket.name}/${slug}: ${reason}`);
	return transcribeWithXai(bucket, slug, outFile, input, opts, reason);
}

/** Transcribe a single media file by its bucket + slug. */
export async function transcribeOne(opts: TranscribeOneOptions): Promise<TranscribeOneResult> {
	const onLog = opts.onLog ?? (() => {});
	const [bucket] = await resolveBuckets([opts.bucket]);
	await mkdir(bucket.transcriptsDir, { recursive: true });
	const outFile = join(bucket.transcriptsDir, `${opts.slug}.json`);
	if (!opts.overwrite && await stat(outFile).catch(() => null)) throw new Error(`Transcript already exists for ${opts.slug}`);

	const input = await findInput(bucket, opts.slug);
	const selected = config();
	if (selected.engine === 'xai') return transcribeWithXai(bucket, opts.slug, outFile, input, opts);

	const tempDir = await mkdtemp(join(tmpdir(), 'syntax-transcribe-'));
	try {
		const wavPath = join(tempDir, `${opts.slug}.wav`);
		const rawDir = join(tempDir, 'raw');
		try {
			onLog(`Extracting local WAV for ${bucket.name}/${opts.slug}...`);
			await extractWav(input.inputPath, wavPath, onLog, opts.signal);
			onLog(`Extracted local WAV for ${bucket.name}/${opts.slug}.`);
			await runParakeet([wavPath], rawDir, onLog, opts.signal);
			throwIfAborted(opts.signal);
			const transcript = await readParakeetOutput(join(rawDir, `${opts.slug}.json`), `${bucket.name}/${opts.slug}`);
			throwIfAborted(opts.signal);
			await writeTranscriptAtomic(outFile, transcript);
			onLog(`Wrote ${outFile}`);
			return { outFile, durationSec: transcript.duration, words: transcript.words.length, uploadedMB: 0, bucket: bucket.name, extractedMp3: false, engine: 'parakeet-mlx' };
		} catch (err) {
			return await fallbackOne(bucket, opts.slug, outFile, input, opts, err, selected.fallback);
		}
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
}

export interface TranscribeAllMissingOptions {
	/** Buckets to scan. null/empty = all buckets. */
	buckets?: string[] | null;
	language?: string;
	concurrency?: number;
	onLog?: LogFn;
	signal?: AbortSignal;
}

export interface TranscribeAllMissingResult {
	attempted: number;
	succeeded: number;
	byEngine: { 'parakeet-mlx': number; xai: number };
	completed: TranscriptOutcome[];
	failed: { bucket: string; slug: string; error: string }[];
}

interface QueueItem { bucket: Bucket; slug: string }
interface PreparedLocalItem { item: QueueItem; wavPath: string; rawPath: string }

function itemKey(item: QueueItem): string { return `${item.bucket.name}\0${item.slug}`; }
function localStem(item: QueueItem, index: number): string {
	return `${index}-${`${item.bucket.name}-${item.slug}`.replace(/[^a-zA-Z0-9._-]+/g, '_')}`;
}
function emptyAllResult(attempted: number): TranscribeAllMissingResult {
	return { attempted, succeeded: 0, byEngine: { 'parakeet-mlx': 0, xai: 0 }, completed: [], failed: [] };
}

async function findMissingQueue(buckets: Bucket[]): Promise<QueueItem[]> {
	const queue: QueueItem[] = [];
	for (const bucket of buckets) {
		await mkdir(bucket.transcriptsDir, { recursive: true });
		let entries: string[] = [];
		try { entries = await readdir(bucket.videosDir); } catch { continue; }
		const slugs = new Set<string>();
		for (const file of entries) if (MEDIA_EXTS.has(extname(file).toLowerCase())) slugs.add(basename(file, extname(file)));
		let transcripts = new Set<string>();
		try {
			transcripts = new Set((await readdir(bucket.transcriptsDir)).filter((file) => file.endsWith('.json')).map((file) => basename(file, '.json')));
		} catch {
			// The directory was created above; an empty set is still the safe answer.
		}
		for (const slug of slugs) if (!transcripts.has(slug)) queue.push({ bucket, slug });
	}
	return queue;
}

async function transcribeAllXai(queue: QueueItem[], opts: TranscribeAllMissingOptions, concurrency: number, onLog: LogFn): Promise<TranscribeAllMissingResult> {
	const result = emptyAllResult(queue.length);
	let cursor = 0;
	async function worker(): Promise<void> {
		while (cursor < queue.length) {
			throwIfAborted(opts.signal);
			const item = queue[cursor++];
			try {
				const one = await transcribeOne({ bucket: item.bucket.name, slug: item.slug, language: opts.language, onLog, signal: opts.signal });
				result.completed.push({ bucket: item.bucket.name, slug: item.slug, engine: one.engine, ...(one.fallbackReason ? { fallbackReason: one.fallbackReason } : {}) });
				result.byEngine[one.engine]++;
			} catch (err) {
				if (wasCancelled(err, opts.signal)) throw new CancelledError();
				const message = errorMessage(err);
				result.failed.push({ bucket: item.bucket.name, slug: item.slug, error: message });
				onLog(`  x [${item.bucket.name}] ${item.slug}: ${message}`);
			}
		}
	}
	await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, () => worker()));
	result.succeeded = result.completed.length;
	return result;
}

async function transcribeAllParakeet(queue: QueueItem[], opts: TranscribeAllMissingOptions, concurrency: number, onLog: LogFn): Promise<TranscribeAllMissingResult> {
	const result = emptyAllResult(queue.length);
	const tempDir = await mkdtemp(join(tmpdir(), 'syntax-transcribe-'));
	const wavDir = join(tempDir, 'wav');
	const rawDir = join(tempDir, 'raw');
	const prepared: PreparedLocalItem[] = [];
	const localFailures = new Map<string, string>();
	let cursor = 0;

	try {
		await mkdir(wavDir, { recursive: true });
		async function extractWorker(): Promise<void> {
			while (cursor < queue.length) {
				throwIfAborted(opts.signal);
				const index = cursor++;
				const item = queue[index];
				const stem = localStem(item, index);
				const wavPath = join(wavDir, `${stem}.wav`);
				onLog(`Extracting local WAV [${item.bucket.name}] ${item.slug}...`);
				try {
					const input = await findInput(item.bucket, item.slug);
					await extractWav(input.inputPath, wavPath, onLog, opts.signal);
					prepared.push({ item, wavPath, rawPath: join(rawDir, `${stem}.json`) });
					onLog(`Prepared local WAV [${item.bucket.name}] ${item.slug}.`);
				} catch (err) {
					if (wasCancelled(err, opts.signal)) throw new CancelledError();
					localFailures.set(itemKey(item), errorMessage(err));
					onLog(`  Local preparation failed [${item.bucket.name}] ${item.slug}: ${errorMessage(err)}`);
				}
			}
		}
		await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, () => extractWorker()));

		if (prepared.length) {
			let batchError: string | null = null;
			try {
				await runParakeet(prepared.map((item) => item.wavPath), rawDir, onLog, opts.signal);
			} catch (err) {
				if (wasCancelled(err, opts.signal)) throw new CancelledError();
				batchError = errorMessage(err);
				onLog(`parakeet-mlx batch exited with an error; validating individual outputs: ${batchError}`);
			}
			// A batch can leave valid files even when its process exits unsuccessfully.
			// Validate every expected output independently before deciding which files fall back.
			for (const work of prepared) {
				try {
					throwIfAborted(opts.signal);
					const transcript = await readParakeetOutput(work.rawPath, `${work.item.bucket.name}/${work.item.slug}`);
					throwIfAborted(opts.signal);
					const outFile = join(work.item.bucket.transcriptsDir, `${work.item.slug}.json`);
					await writeTranscriptAtomic(outFile, transcript);
					onLog(`Validated parakeet output [${work.item.bucket.name}] ${work.item.slug}.`);
					result.completed.push({ bucket: work.item.bucket.name, slug: work.item.slug, engine: 'parakeet-mlx' });
					result.byEngine['parakeet-mlx']++;
				} catch (err) {
					if (wasCancelled(err, opts.signal)) throw new CancelledError();
					localFailures.set(itemKey(work.item), batchError ? `${batchError}; ${errorMessage(err)}` : errorMessage(err));
				}
			}
		}

		const fallbackItems = queue.filter((item) => localFailures.has(itemKey(item)));
		const selected = config();
		if (selected.fallback === 'xai') {
			let fallbackCursor = 0;
			async function fallbackWorker(): Promise<void> {
				while (fallbackCursor < fallbackItems.length) {
					throwIfAborted(opts.signal);
					const item = fallbackItems[fallbackCursor++];
					const reason = localFailures.get(itemKey(item)) ?? 'local transcription failed';
					onLog(`Falling back to xAI for ${item.bucket.name}/${item.slug}: ${reason}`);
					try {
						const input = await findInput(item.bucket, item.slug);
						const one = await transcribeWithXai(item.bucket, item.slug, join(item.bucket.transcriptsDir, `${item.slug}.json`), input, { bucket: item.bucket.name, slug: item.slug, language: opts.language, onLog, signal: opts.signal }, reason);
						result.completed.push({ bucket: item.bucket.name, slug: item.slug, engine: one.engine, fallbackReason: reason });
						result.byEngine.xai++;
					} catch (err) {
						if (wasCancelled(err, opts.signal)) throw new CancelledError();
						result.failed.push({ bucket: item.bucket.name, slug: item.slug, error: errorMessage(err) });
						onLog(`  x [${item.bucket.name}] ${item.slug}: ${errorMessage(err)}`);
					}
				}
			}
			await Promise.all(Array.from({ length: Math.min(concurrency, fallbackItems.length) }, () => fallbackWorker()));
		} else {
			for (const item of fallbackItems) {
				const error = localFailures.get(itemKey(item)) ?? 'local transcription failed';
				result.failed.push({ bucket: item.bucket.name, slug: item.slug, error });
				onLog(`  x [${item.bucket.name}] ${item.slug}: ${error}`);
			}
		}

		result.succeeded = result.completed.length;
		onLog(`Transcription complete: ${result.succeeded}/${result.attempted} succeeded (${result.byEngine['parakeet-mlx']} parakeet-mlx, ${result.byEngine.xai} xAI fallback).`);
		return result;
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
}

/** Find every media file in selected buckets that has no matching transcript. */
export async function transcribeAllMissing(opts: TranscribeAllMissingOptions = {}): Promise<TranscribeAllMissingResult> {
	const buckets = await resolveBuckets(opts.buckets);
	const concurrency = Math.max(1, Math.floor(opts.concurrency ?? 3));
	const onLog = opts.onLog ?? (() => {});
	const queue = await findMissingQueue(buckets);

	onLog(`${queue.length} missing transcript(s) across ${buckets.length} bucket(s)`);
	if (!queue.length) return emptyAllResult(0);

	const selected = config();
	const result = selected.engine === 'xai'
		? await transcribeAllXai(queue, opts, concurrency, onLog)
		: await transcribeAllParakeet(queue, opts, concurrency, onLog);
	onLog(`Final counts: ${result.byEngine['parakeet-mlx']} parakeet-mlx, ${result.byEngine.xai} xAI, ${result.failed.length} failed.`);
	return result;
}
