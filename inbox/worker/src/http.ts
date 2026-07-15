// Uniforme fout-afhandeling: gooi `ApiError(status, code, message)`; de globale
// onError-handler (index.ts) zet 'm om naar `{ error: { code, message } }`.

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message)
  }
}

export function fail(status: number, code: string, message: string): never {
  throw new ApiError(status, code, message)
}
