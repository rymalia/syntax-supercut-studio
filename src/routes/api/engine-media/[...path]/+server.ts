import { error } from '@sveltejs/kit';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import type { RequestHandler } from './$types';
import { engineDir, engineMediaPath } from '$lib/server/engine';

const CONTENT_TYPES: Record<string, string> = {
	'.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
	'.png': 'image/png', '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
};

export const GET: RequestHandler = async ({ params, request }) => {
	let raw: string;
	try { raw = decodeURIComponent(params.path); } catch { throw error(404, 'Not found'); }
	if (raw.includes('\\') || raw.split('/').some((part) => !part || part === '.' || part === '..')) throw error(404, 'Not found');
	const filePath = resolve(join(engineDir(), raw));
	if (!engineMediaPath(filePath)) throw error(404, 'Not found');
	const actual = await realpath(filePath).catch(() => null);
	if (!actual || !engineMediaPath(actual)) throw error(404, 'Not found');
	const info = await stat(actual).catch(() => null);
	if (!info?.isFile()) throw error(404, 'Not found');

	const contentType = CONTENT_TYPES[extname(actual).toLowerCase()] ?? 'application/octet-stream';
	const total = info.size;
	const rangeHeader = request.headers.get('range');
	if (rangeHeader) {
		const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
		if (match) {
			const start = match[1] === '' ? Math.max(0, total - Number(match[2])) : Number(match[1]);
			const end = match[2] === '' ? total - 1 : Number(match[2]);
			if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || end >= total) {
				return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${total}` } });
			}
			return new Response(Readable.toWeb(createReadStream(actual, { start, end })) as ReadableStream, {
				status: 206,
				headers: { 'Content-Type': contentType, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${total}`, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600' },
			});
		}
	}
	return new Response(Readable.toWeb(createReadStream(actual)) as ReadableStream, {
		status: 200,
		headers: { 'Content-Type': contentType, 'Content-Length': String(total), 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600' },
	});
};
