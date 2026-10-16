// Test-only switches. In normal use none of the host/registry overrides or loopback logins are
// honoured, so an environment variable can't redirect a password or an update anywhere else.
export const testMode = (): boolean => typeof process !== "undefined" && process.env?.RUNI_TEST_MODE === "1";
export const testOverride = (name: string): string | undefined => (testMode() ? process.env[name] || undefined : undefined);
