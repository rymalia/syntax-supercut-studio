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
} from '$lib/server/jobs';

function asStringArray(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	const out: string[] = [];
	for (const v of value) {
		if (typeof v === 'string' && v.trim()) out.push(v.trim());
	}
	return out.length ? out : null;
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
		case 'ingest': {
			const job = startIngest();
			return json({ id: job.id });
		}
		case 'supercut': {
			const { target, regexSource, tile, limit, debug, dryRun } = body as Record<string, unknown>;
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
				buckets,
			});
			return json({ id: job.id });
		}
		case 'sentence': {
			const { sentence, seed, debug } = body as Record<string, unknown>;
			if (typeof sentence !== 'string' || !sentence.trim()) throw error(400, 'sentence required');
			const job = startSentence({
				sentence,
				seed: typeof seed === 'number' ? seed : undefined,
				buckets,
				debug: Boolean(debug),
			});
			return json({ id: job.id });
		}
		case 'songify': {
			const { target, melody, bpm, subdivision, singleClip, noShift } = body as Record<
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
