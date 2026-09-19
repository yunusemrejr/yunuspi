// Historical API compatibility: YunusPi never polls an upstream release authority.
import { compare, valid } from "semver";
export function formatVersionCheckError(error) { return error instanceof Error ? error.message : String(error); }
export function comparePackageVersions(left, right) { return valid(left.trim()) && valid(right.trim()) ? compare(left.trim(), right.trim()) : undefined; }
export function isNewerPackageVersion(candidate, current) { return (comparePackageVersions(candidate, current) ?? 0) > 0; }
export async function getLatestPiRelease() { return undefined; }
export async function getLatestPiVersion() { return undefined; }
export async function checkForNewPiVersion() { return undefined; }
