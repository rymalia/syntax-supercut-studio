import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readBatch, ReviewError, writeDecisions, type Verdict } from '$lib/server/review';

function fail(err: unknown): never {
	if (err instanceof ReviewError) throw error(err.status, err.message);
	throw err;
}

export const GET: RequestHandler = async ({ params }) => {
	try { return json(await readBatch(params.batch)); } catch (err) { fail(err); }
};

/** `PUT {verdicts: [{clip, seg, verdict}]}` replaces the batch's decisions.json with these verdicts. */
export const PUT: RequestHandler = async ({ params, request }) => {
	const body = await request.json().catch(() => null);
	const verdicts = (body as { verdicts?: unknown } | null)?.verdicts;
	if (!Array.isArray(verdicts) || verdicts.some((v) => !v || typeof v !== 'object' || typeof v.clip !== 'string' || !Number.isInteger(v.seg) || typeof v.verdict !== 'string')) {
		throw error(400, 'verdicts must be a list of {clip, seg, verdict}');
	}
	try { return json({ ok: true, ...(await writeDecisions(params.batch, verdicts as { clip: string; seg: number; verdict: Verdict }[])) }); }
	catch (err) { fail(err); }
};
