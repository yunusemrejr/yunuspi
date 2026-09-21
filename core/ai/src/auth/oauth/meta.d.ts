/**
 * Meta Model API OAuth flow
 *
 * RFC 8628 device authorization grant against https://auth.meta.com (JSON
 * responses). The identity token is exchanged for a Model API key via the
 * Muse Code key-mint endpoint; the identity token is stored as `refresh`
 * and the minted key as `access`.
 */
import type { OAuthAuth } from "../types.ts";
export declare const metaOAuth: OAuthAuth;
