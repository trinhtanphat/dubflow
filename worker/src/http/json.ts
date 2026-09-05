export type ErrorBody = { error: true; code: string; message: string };
export function errorBody(code: string, message: string): ErrorBody {
  return { error: true, code, message };
}
