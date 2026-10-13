export const appBase = (import.meta.env?.BASE_URL || '/').replace(/\/$/, '');

export const appPath = path => `${appBase}${path}`;
