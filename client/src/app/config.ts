// Build-time configuration. esbuild replaces these identifiers from GAME_SERVER_URL (see build.mjs).
declare const __WS_URL__: string;
declare const __HTTP_URL__: string;
export const WS_URL: string = __WS_URL__;
export const HTTP_URL: string = __HTTP_URL__;
