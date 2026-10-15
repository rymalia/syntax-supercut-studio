import { randomUUID } from 'node:crypto';
import { CancelledError } from './ffmpeg.js';
import { filmPath, runEngine, type EngineResult } from './engine.js';
import { buildSupercut, type SupercutOptions, type SupercutResult } from './pipelines/supercut.js';
import { buildSentence, type SentenceOptions, type SentenceResult } from './pipelines/sentence.js';
import { buildSong, type SongifyOptions, type SongifyResult } from './pipelines/songify.js';
import {
	transcribeOne,
	transcribeAllMissing,
	type TranscribeOneOptions,
	type TranscribeOneResult,
	type TranscribeAllMissingOptions,
	type TranscribeAllMissingResult,
} from './pipelines/transcribe.js';

export type JobKind = 'supercut' | 'sentence' | 'songify' | 'transcribe-one' | 'transcribe-all' | 'film-plan' | 'film-render' | 'ingest';

export type JobStatus = 'running' | 'done' | 'error' | 'cancelled';

export interface JobBase<Kind extends JobKind, Params, Result> {
	id: string;
	kind: Kind;
	status: JobStatus;
	params: Params;
	logs: string[];
	startedAt: number;
	finishedAt: number | null;
	error: string | null;
	result: Result | null;
}

export type Job =
	| JobBase<'supercut', SerializableSupercutParams, SupercutResult>
	| JobBase<'sentence', SentenceOptions, SentenceResult>
	| JobBase<'songify', SongifyOptions, SongifyResult>
	| JobBase<'transcribe-one', TranscribeOneOptions, TranscribeOneResult>
	| JobBase<'transcribe-all', TranscribeAllMissingOptions, TranscribeAllMissingResult>
	| JobBase<'film-plan', { slug: string }, EngineResult>
	| JobBase<'film-render', { slug: string; draft?: boolean }, EngineResult>
	| JobBase<'ingest', Record<string, never>, EngineResult>;

export interface SerializableSupercutParams {
	target?: string;
	regexSource?: string;
	tile?: boolean;
	limit?: number | null;
	debug?: boolean;
	dryRun?: boolean;
	buckets?: string[] | null;
}

/**
 * Module-scope Map is fine for a single-user local studio. Jobs live for the
 * process lifetime; restart clears them (results are on disk).
 */
const jobs = new Map<string, Job>();
const controllers = new Map<string, AbortController>();

/** Cap logs per job so long runs don't balloon memory. */
const MAX_LOG_LINES = 4000;

function addLog(job: Job, line: string) {
	job.logs.push(line);
	if (job.logs.length > MAX_LOG_LINES) {
		job.logs.splice(0, job.logs.length - MAX_LOG_LINES);
	}
}

export function getJob(id: string): Job | undefined {
	return jobs.get(id);
}

export function listJobs(): Job[] {
	return [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
}

/**
 * Ask a running job to stop. Returns false if the job doesn't exist or is
 * already finished. Kills any child processes (ffmpeg/aubiopitch) via the
 * AbortSignal we passed into the pipeline.
 */
export function cancelJob(id: string): boolean {
	const job = jobs.get(id);
	if (!job || job.status !== 'running') return false;
	const ctrl = controllers.get(id);
	if (!ctrl) return false;
	addLog(job, 'Cancel requested.');
	ctrl.abort();
	return true;
}

function baseJob<K extends JobKind, P, R>(kind: K, params: P): JobBase<K, P, R> {
	return {
		id: randomUUID(),
		kind,
		status: 'running',
		params,
		logs: [],
		startedAt: Date.now(),
		finishedAt: null,
		error: null,
		result: null,
	};
}

function runInBackground<K extends JobKind, P, R>(
	job: JobBase<K, P, R>,
	work: (onLog: (line: string) => void, signal: AbortSignal) => Promise<R>,
): void {
	const controller = new AbortController();
	controllers.set(job.id, controller);
	jobs.set(job.id, job as Job);

	work((line) => addLog(job as Job, line), controller.signal)
		.then((result) => {
			job.result = result;
			job.status = 'done';
			job.finishedAt = Date.now();
		})
		.catch((err) => {
			const msg = err instanceof Error ? err.message : String(err);
			if (err instanceof CancelledError || controller.signal.aborted) {
				job.status = 'cancelled';
				addLog(job as Job, 'Cancelled.');
			} else {
				job.error = msg;
				job.status = 'error';
				addLog(job as Job, `ERROR: ${msg}`);
			}
			job.finishedAt = Date.now();
		})
		.finally(() => {
			controllers.delete(job.id);
		});
}

export function startSupercut(params: SerializableSupercutParams): Job {
	const job = baseJob<'supercut', SerializableSupercutParams, SupercutResult>('supercut', params);
	const regex = params.regexSource ? new RegExp(params.regexSource, 'gi') : null;
	const opts: SupercutOptions = {
		target: params.target,
		regex,
		tile: params.tile ?? false,
		limit: params.limit ?? null,
		debug: params.debug ?? false,
		dryRun: params.dryRun ?? false,
		buckets: params.buckets ?? null,
	};
	runInBackground(job, (onLog, signal) => buildSupercut({ ...opts, onLog, signal }));
	return job;
}

export function startSentence(params: SentenceOptions): Job {
	const job = baseJob<'sentence', SentenceOptions, SentenceResult>('sentence', params);
	runInBackground(job, (onLog, signal) => buildSentence({ ...params, onLog, signal }));
	return job;
}

export function startSongify(params: SongifyOptions): Job {
	const job = baseJob<'songify', SongifyOptions, SongifyResult>('songify', params);
	runInBackground(job, (onLog, signal) => buildSong({ ...params, onLog, signal }));
	return job;
}

export function startTranscribeOne(params: TranscribeOneOptions): Job {
	const job = baseJob<'transcribe-one', TranscribeOneOptions, TranscribeOneResult>(
		'transcribe-one',
		params,
	);
	runInBackground(job, (onLog, signal) => transcribeOne({ ...params, onLog, signal }));
	return job;
}

export function startTranscribeAll(params: TranscribeAllMissingOptions): Job {
	const job = baseJob<
		'transcribe-all',
		TranscribeAllMissingOptions,
		TranscribeAllMissingResult
	>('transcribe-all', params);
	runInBackground(job, (onLog, signal) => transcribeAllMissing({ ...params, onLog, signal }));
	return job;
}

export function startFilmPlan(params: { slug: string }): Job {
	const job = baseJob<'film-plan', typeof params, EngineResult>('film-plan', params);
	runInBackground(job, (onLog, signal) => runEngine(['plan', '--film', filmPath(params.slug), '--sheet'], onLog, signal));
	return job;
}

export function startFilmRender(params: { slug: string; draft?: boolean }): Job {
	const job = baseJob<'film-render', typeof params, EngineResult>('film-render', params);
	runInBackground(job, async (onLog, signal) => {
		const args = ['render', '--film', filmPath(params.slug)];
		if (params.draft) args.push('--draft');
		const render = await runEngine(args, onLog, signal);
		const qa = await runEngine(['qa', '--name', params.slug], onLog, signal);
		return { ...render, qa };
	});
	return job;
}

export function startIngest(): Job {
	const job = baseJob<'ingest', Record<string, never>, EngineResult>('ingest', {});
	runInBackground(job, (onLog, signal) => runEngine(['ingest'], onLog, signal));
	return job;
}
