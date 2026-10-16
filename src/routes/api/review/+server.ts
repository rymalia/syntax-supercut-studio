import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listBatches } from '$lib/server/review';

export const GET: RequestHandler = async () => json({ batches: await listBatches() });
