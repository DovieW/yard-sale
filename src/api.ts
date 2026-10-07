export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export async function readApiResponse<T>(response: Response): Promise<T> {
  if (!response.headers.get("content-type")?.includes("application/json")) {
    throw new ApiError("Your sign-in may have expired. Reload the app to sign in again.", response.status);
  }
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new ApiError(body.error || `Request failed (${response.status}). Try again.`, response.status);
  return body;
}
