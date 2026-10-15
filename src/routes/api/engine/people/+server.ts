import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { runEngine } from '$lib/server/engine';

export const GET: RequestHandler = async () => json(await runEngine(['people']));
