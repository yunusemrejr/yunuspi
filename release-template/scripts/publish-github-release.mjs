#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const commitSha = /^[a-f0-9]{40}$/;
const repositoryName = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export function releasePlan({ version, ref, sha, repository, changelog }) {
  if (!stableVersion.test(version)) throw Error('Expected a stable release version');
  const tag = `v${version}`;
  if (ref !== `refs/tags/${tag}`) throw Error('Release tag and product version disagree');
  if (!commitSha.test(sha ?? '')) throw Error('Expected an exact commit SHA');
  if (!repositoryName.test(repository ?? '')) throw Error('Invalid repository');
  const lines = changelog.split('\n');
  const start = lines.findIndex(line => line.startsWith(`## ${version} — `));
  if (start < 0) throw Error('Release changelog section is missing');
  let end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  if (end < 0) end = lines.length;
  const notes = lines.slice(start + 1, end).join('\n').trim();
  if (!notes || notes.length > 50000) throw Error('Release notes are empty or too large');
  // Relative document links must keep working in GitHub's release page.
  const body = notes.replace(/\]\((docs\/[^)]+|CHANGELOG\.md(?:#[^)]*)?)\)/g,
    (_, target) => `](https://github.com/${repository}/blob/${sha}/${target})`) + `\n\nSource commit: \`${sha}\`.\n`;
  return { tag_name: tag, target_commitish: sha, name: `YunusPi ${tag}`, body, draft: false, prerelease: false, make_latest: 'legacy' };
}

export async function publishRelease(plan, repository, token, request = fetch) {
  if (!token) throw Error('The release job requires GITHUB_TOKEN');
  if (!repositoryName.test(repository ?? '')) throw Error('Invalid repository');
  if (!plan?.tag_name?.startsWith('v') || !stableVersion.test(plan.tag_name.slice(1)) || !commitSha.test(plan.target_commitish ?? '')) throw Error('Expected an exact version tag and commit SHA');
  const repositoryEndpoint = `https://api.github.com/repos/${repository}`;
  const endpoint = `${repositoryEndpoint}/releases`;
  const send = (url, options = {}) => request(url, {
    ...options, redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
  });
  // GitHub ignores target_commitish when a tag exists. Resolve that tag ourselves,
  // including annotated tags, and never follow URLs supplied in an API response.
  const verifyTag = async () => {
    const response = await send(`${repositoryEndpoint}/git/ref/tags/${encodeURIComponent(plan.tag_name)}`);
    if (response.status !== 200) throw Error(`Release tag lookup failed (${response.status}); the tested tag must already exist`);
    const ref = await response.json();
    if (ref.ref !== `refs/tags/${plan.tag_name}`) throw Error('Release tag reference disagrees with the requested version');
    let object = ref.object;
    const visited = new Set();
    while (object?.type === 'tag') {
      if (!commitSha.test(object.sha ?? '') || visited.has(object.sha) || visited.size >= 8) throw Error('Invalid or excessively nested annotated release tag');
      visited.add(object.sha);
      const tagResponse = await send(`${repositoryEndpoint}/git/tags/${object.sha}`);
      if (tagResponse.status !== 200) throw Error(`Annotated release tag lookup failed (${tagResponse.status})`);
      const tag = await tagResponse.json();
      if (tag.sha !== object.sha) throw Error('Annotated release tag identity disagrees');
      object = tag.object;
    }
    if (object?.type !== 'commit' || object.sha !== plan.target_commitish) throw Error('Release tag does not point to the exact tested commit');
  };
  const verifyRelease = (release) => {
    if (release.tag_name !== plan.tag_name || release.name !== plan.name || release.body !== plan.body || release.draft !== false || release.prerelease !== false) throw Error('Existing release differs; refusing to overwrite it');
    return release;
  };
  const releaseByTag = () => send(`${endpoint}/tags/${encodeURIComponent(plan.tag_name)}`);
  await verifyTag();
  const previous = await releaseByTag();
  if (previous.status === 200) {
    const release = verifyRelease(await previous.json());
    await verifyTag();
    return { status: 'already-published', url: release.html_url };
  }
  if (previous.status !== 404) throw Error(`Release lookup failed (${previous.status})`);
  await verifyTag();
  const response = await send(endpoint, { method: 'POST', body: JSON.stringify(plan) });
  // Two successful workflow runs can race after the same 404. Reconcile once;
  // neither retry the POST nor overwrite a release whose content differs.
  if (response.status === 422) {
    const concurrent = await releaseByTag();
    if (concurrent.status === 200) {
      const release = verifyRelease(await concurrent.json());
      await verifyTag();
      return { status: 'already-published', url: release.html_url };
    }
  }
  if (response.status !== 201) throw Error(`Release creation failed (${response.status}); inspect the workflow permissions and tag`);
  const release = verifyRelease(await response.json());
  await verifyTag();
  return { status: 'published', url: release.html_url };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_EVENT_NAME !== 'push') throw Error('Run only from the checked version-tag push workflow');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const plan = releasePlan({ version, ref: process.env.GITHUB_REF, sha: process.env.GITHUB_SHA,
    repository: process.env.GITHUB_REPOSITORY, changelog: fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8') });
  console.log(JSON.stringify(await publishRelease(plan, process.env.GITHUB_REPOSITORY, process.env.GITHUB_TOKEN)));
}
