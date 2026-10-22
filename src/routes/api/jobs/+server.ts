import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	listJobs,
	startSupercut,
	startSentence,
	startSongify,
	startTranscribeOne,
	startTranscribeAll,
	startFilmPlan,
	startFilmRender,
	startIngest,
	startThumbs,
} from '$lib/server/jobs';

function asStringArray(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	const out: string[] = [];
	for (const v of value) {
		if (typeof v === 'string' && v.trim()) out.push(v.trim());
	}
	return out.length ? out : null;
}

function asOptionalBoolean(value: unknown, name: string): boolean | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== 'boolean') throw error(400, `${name} must be a boolean`);
	return value;
}

function asOptionalCast(value: unknown): string[] | null | undefined {
	if (value === undefined) return undefined;
	if (value === null) return null;
	if (!Array.isArray(value)) throw error(400, 'cast must be an array of person or group names');
	const cast: string[] = [];
	for (const item of value) {
		if (typeof item !== 'string' || !item.trim()) throw error(400, 'cast must contain non-empty strings');
		cast.push(item.trim());
	}
	return cast.length ? cast : null;
}

export const GET: RequestHandler = async () => {
	return json({ jobs: listJobs() });
};

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	if (!body || typeof body !== 'object') throw error(400, 'Invalid JSON body');
	const { kind } = body as { kind?: string };
	const buckets = asStringArray((body as Record<string, unknown>).buckets);

	switch (kind) {
		case 'film-plan':
		case 'film-render': {
			const { slug, draft } = body as Record<string, unknown>;
			if (typeof slug !== 'string' || !/^[a-z0-9_-]+$/.test(slug)) throw error(400, 'Invalid film slug');
			const job = kind === 'film-plan' ? startFilmPlan({ slug }) : startFilmRender({ slug, draft: draft === true });
			return json({ id: job.id });
		}
		case 'thumbs': {
			const job = startThumbs({ buckets });
			return json({ id: job.id });
		}
		case 'ingest': {
			const job = startIngest();
			return json({ id: job.id });
		}
		case 'supercut': {
			const { target, regexSource, tile, limit, debug, dryRun, cast, onscreen } = body as Record<string, unknown>;
			if (!target && !regexSource) throw error(400, 'target or regexSource required');
			if (regexSource) {
				try {
					new RegExp(String(regexSource), 'gi');
				} catch (err) {
					throw error(400, `Invalid regex: ${(err as Error).message}`);
				}
			}
			const job = startSupercut({
				target: typeof target === 'string' ? target : undefined,
				regexSource: typeof regexSource === 'string' ? regexSource : undefined,
				tile: Boolean(tile),
				limit: typeof limit === 'number' && Number.isFinite(limit) ? limit : null,
				debug: Boolean(debug),
				dryRun: Boolean(dryRun),
				cast: asOptionalCast(cast),
				onscreen: asOptionalBoolean(onscreen, 'onscreen'),
				buckets,
			});
			return json({ id: job.id });
		}
		case 'sentence': {
			const { sentence, cast, captions, speakerLabels, draft } = body as Record<string, unknown>;
			if (typeof sentence !== 'string' || !sentence.trim()) throw error(400, 'sentence required');
			const sentenceCast = asOptionalCast(cast);
			const job = startSentence({
				sentence: sentence.trim(),
				cast: sentenceCast,
				captions: asOptionalBoolean(captions, 'captions'),
				speakerLabels: asOptionalBoolean(speakerLabels, 'speakerLabels'),
				draft: asOptionalBoolean(draft, 'draft'),
			});
			return json({ id: job.id });
		}
		case 'songify': {
			const { target, melody, bpm, subdivision, singleClip, noShift, cast, onscreen } = body as Record<
				string,
				unknown
			>;
			if (typeof target !== 'string' || !target.trim()) throw error(400, 'target required');
			if (typeof melody !== 'string' || !melody.trim()) throw error(400, 'melody required');
			const job = startSongify({
				target,
				melody,
				bpm: typeof bpm === 'number' ? bpm : undefined,
				subdivision: typeof subdivision === 'number' ? subdivision : undefined,
				singleClip: Boolean(singleClip),
				noShift: Boolean(noShift),
				cast: asOptionalCast(cast),
				onscreen: asOptionalBoolean(onscreen, 'onscreen'),
				buckets,
			});
			return json({ id: job.id });
		}
		case 'transcribe-one': {
			const { slug, bucket, overwrite } = body as Record<string, unknown>;
			if (typeof slug !== 'string' || !slug) throw error(400, 'slug required');
			if (typeof bucket !== 'string' || !bucket) throw error(400, 'bucket required');
			const job = startTranscribeOne({ slug, bucket, overwrite: Boolean(overwrite) });
			return json({ id: job.id });
		}
		case 'transcribe-all': {
			const { concurrency } = body as Record<string, unknown>;
			const job = startTranscribeAll({
				concurrency: typeof concurrency === 'number' ? concurrency : undefined,
				buckets,
			});
			return json({ id: job.id });
		}
		default:
			throw error(400, `Unknown job kind: ${kind}`);
	}
};
