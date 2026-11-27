import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// 27 Nov 2026: two false triggers in the needed check. A write brief that forbids one part ("do not change the API")
// counted as read-only, which turned the dry sign off for a worker that was meant to change things; and a request that
// is itself a survey ("audit the codebase") was asked about for reading across many places, which is the work.

process.env.PI_JEV = 'off';

const root = path.resolve(import.meta.dirname, '..');
const { Needed, briefReadsOnly, isSurveyRequest } = await import(pathToFileURL(path.join(root, 'agent/extensions/lib/needed.ts')).href);

const CWD = '/work/app';
const read = (file) => ({ toolName: 'read', input: { path: file }, isError: false });
const PLACES = Array.from({ length: 8 }, (_, i) => read(`pkg${i}/src/file.ts`));

test('a brief that as a whole asks for no changes is read-only', () => {
	for (const brief of [
		'Survey the auth module and report. Do not edit anything.',
		'Read-only audit of the exports',
		'Report only: list the callers of parseConfig',
		'Find where retries are configured. Do not modify any file.',
		'Analysis only, no changes.',
		'Search the repo for TODOs without editing any files',
		"Don't change the codebase; just explain how login works.",
	]) assert.equal(briefReadsOnly(brief), true, brief);
});

test('a write brief with a scoped prohibition is not read-only', () => {
	for (const brief of [
		'Fix the login bug. Do not change the API.',
		"Add a retry to the uploader and don't touch the tests.",
		'Implement the export button, leave tests untouched.',
		'Rename the helper to buildPlan; never change the public signature.',
		'Update the docs. No changes to the CLI flags.',
		'Fix the failing test without changing the fixtures.',
		'Fix the bug. Do not edit any file outside src/auth.',
		'Fix the failing export test',
	]) assert.equal(briefReadsOnly(brief), false, brief);
});

test('a write brief with a scoped prohibition still gets the dry sign', async () => {
	let t = 1_000_000;
	const asked = [];
	const needed = new Needed({ worker: true, now: () => t, ask: async (state) => { asked.push(state.sign); return 0.1; } });
	needed.request('Fix the login bug. Do not change the API.');
	for (let i = 0; i < 25; i++) await needed.observe(read(`src/same/file.ts`), CWD);
	assert.ok(asked.some((sign) => sign.includes('nothing changed')), asked.join('|'));
});

test('a survey request is told apart from a task', () => {
	for (const request of [
		'Audit the codebase for unused exports',
		'review the auth flow',
		'Find all callers of parseConfig',
		'search across the repo for retries',
		'Explore how sessions are stored',
		'investigate why the build is slow',
		'analyse the codebase',
		'Compare the files in src/a and src/b',
		'go through the settings code',
		'Kodu incele ve sorunları söyle',
		'Tüm modülleri tara',
		'hepsini bul',
	]) assert.equal(isSurveyRequest(request), true, request);
	for (const request of ['Fix the login bug', 'Add a dark mode toggle', 'Taraftar sayfasını düzelt', 'Why is the preview blank?']) assert.equal(isSurveyRequest(request), false, request);
});

async function signsFor(request, events) {
	let t = 1_000_000;
	const signs = [];
	const needed = new Needed({ worker: false, now: () => t, ask: async (state) => { signs.push(state.sign); t += 120_000; return 0.1; } });
	needed.request(request);
	for (const event of events) await needed.observe(event, CWD);
	return signs;
}

test('reading across many places is no spread signal for a survey request', async () => {
	const signs = await signsFor('Audit the codebase for unused exports', PLACES);
	assert.deepEqual(signs, []);
});

test('reading across many places is a spread signal for a fix request', async () => {
	const signs = await signsFor('Fix the login bug', PLACES);
	assert.deepEqual(signs, ['reading across 5 separate places']);
});

test('a survey request still gets the long sign', async () => {
	const signs = await signsFor('Audit the codebase for unused exports', Array.from({ length: 20 }, (_, i) => read(`pkg${i % 4}/src/file${i}.ts`)));
	assert.deepEqual(signs, ['20 steps since the last check of direction']);
});
