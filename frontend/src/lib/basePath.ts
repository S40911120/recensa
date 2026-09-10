/// <reference types="vite/client" />

/** Join an app-relative URL to Vite's configured base path. */
export function joinBasePath(basePath: string, urlPath: string): string {
  const base = basePath.endsWith('/') ? basePath : `${basePath}/`;
  return `${base}${urlPath.replace(/^\/+/, '')}`;
}

/** Build a URL for an API, websocket, or public asset served by this app. */
export function appPath(urlPath: string): string {
  return joinBasePath(import.meta.env.BASE_URL, urlPath);
}
