export function apiError(code: string, message: string) {
  return { error: { code, message } };
}
