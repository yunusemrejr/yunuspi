import { readFileSync } from "node:fs";
import { isJsonObject, parseJsonText, type JsonObject } from "./common.js";

// Local package identity only. YunusPi never checks upstream extension releases.

export interface PackageInfo {
  name?: string;
  version?: string;
}

function asPayload(value: unknown): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined;
}

function readNonEmptyString(
  record: JsonObject,
  key: string,
): string | undefined {
  const value = record[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Narrow a parsed `package.json` payload to the fields this extension needs. */
export function parsePackageInfo(payload: unknown): PackageInfo {
  const record = asPayload(payload);
  if (!record) return {};
  const info: PackageInfo = {};
  const name = readNonEmptyString(record, "name");
  const version = readNonEmptyString(record, "version");
  if (name !== undefined) info.name = name;
  if (version !== undefined) info.version = version;
  return info;
}

/** Read `name`/`version` from a local `package.json`, returning `{}` on every failure. */
export function readPackageInfo(
  packageJsonUrl: URL | string,
  onError?: (error: Error) => void,
): PackageInfo {
  try {
    return parsePackageInfo(
      parseJsonText(readFileSync(packageJsonUrl, "utf8")),
    );
  } catch (error) {
    if (onError)
      onError(error instanceof Error ? error : new Error(String(error)));
    return {};
  }
}
