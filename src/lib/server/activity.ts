import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { engineDir } from './engine.js';

const ACTIVITY_FILE = 'activity.jsonl';
const TAIL_BYTES = 64 * 1024;
const MAX_FIELD_LENGTH = 200;

export type ActivityActor = 'app' | 'desktop' | 'code';

export interface ActivityEntry {
	ts: string;
	actor: ActivityActor;
	action: string;
	target: string;
	result: string;
}

function activityPath(): string {
	return join(engineDir(), ACTIVITY_FILE);
}

function cap(value: string): string {
	return value.slice(0, MAX_FIELD_LENGTH);
}

/** Append one app-authored activity record. Logging must never affect callers. */
export async function logActivity(action: string, target: string, result: string): Promise<void> {
	let file;
	try {
		// O_NOFOLLOW refuses a symlinked log, and the fstat checks the file we actually opened.
		file = await open(activityPath(), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o644);
		if (!(await file.stat()).isFile()) return;

		const entry: ActivityEntry = {
			ts: new Date().toISOString(),
			actor: 'app',
			action,
			target: cap(target),
			result: cap(result),
		};
		await file.appendFile(`${JSON.stringify(entry)}\n`, 'utf8');
	} catch (err) {
		console.warn('Could not write activity log:', err);
	} finally {
		await file?.close().catch(() => {});
	}
}

// The ISO-8601 shape `Date.toISOString()` and Python's `isoformat()` produce; the
// round-trip check rejects dates that Date.parse would roll over, like Feb 30.
const ISO_TS = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function isIsoTimestamp(ts: string): boolean {
	const m = ISO_TS.exec(ts);
	if (!m) return false;
	const ms = Date.parse(ts);
	if (Number.isNaN(ms)) return false;
	const [y, mo, d] = m[1].split('-').map(Number);
	const day = new Date(Date.UTC(y, mo - 1, d));
	return day.getUTCFullYear() === y && day.getUTCMonth() === mo - 1 && day.getUTCDate() === d;
}

function isActivityEntry(value: unknown): value is ActivityEntry {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const entry = value as Record<string, unknown>;
	return (
		typeof entry.ts === 'string' &&
		isIsoTimestamp(entry.ts) &&
		(entry.actor === 'app' || entry.actor === 'desktop' || entry.actor === 'code') &&
		typeof entry.action === 'string' &&
		typeof entry.target === 'string' &&
		typeof entry.result === 'string'
	);
}

/** Read valid entries from the tail of the shared append-only log, newest first. */
export async function readActivity(limit: number): Promise<ActivityEntry[]> {
	if (!Number.isFinite(limit) || limit <= 0) return [];
	const wanted = Math.floor(limit);

	let file;
	try {
		file = await open(activityPath(), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const info = await file.stat();
		if (!info.isFile()) return [];
		const size = info.size;
		const start = Math.max(0, size - TAIL_BYTES);
		const buffer = Buffer.alloc(size - start);
		if (buffer.length > 0) await file.read(buffer, 0, buffer.length, start);

		let text = buffer.toString('utf8');
		if (start > 0) {
			const firstNewline = text.indexOf('\n');
			if (firstNewline === -1) return [];
			text = text.slice(firstNewline + 1);
		}

		const entries: ActivityEntry[] = [];
		const lines = text.split(/\r?\n/);
		for (let i = lines.length - 1; i >= 0 && entries.length < wanted; i--) {
			if (!lines[i].trim()) continue;
			try {
				const parsed: unknown = JSON.parse(lines[i]);
				if (isActivityEntry(parsed)) entries.push(parsed);
			} catch {
				// Other writers share this file; malformed lines are ignored.
			}
		}
		return entries;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
		console.warn('Could not read activity log:', err);
		return [];
	} finally {
		await file?.close().catch(() => {});
	}
}
