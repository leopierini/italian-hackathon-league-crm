import { randomUUID } from "node:crypto";

// Errors in the HubSpot shape: {status, message, correlationId, category, ...}.
export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly category: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }

  body(): Record<string, unknown> {
    return { status: "error", message: this.message, correlationId: randomUUID(), category: this.category, ...this.extra };
  }
}

export const notFound = (message = "Object not found.", context?: Record<string, string[]>) =>
  new ApiError(404, "OBJECT_NOT_FOUND", message, context ? { context } : {});

export const badRequest = (message: string, extra: Record<string, unknown> = {}) =>
  new ApiError(400, "VALIDATION_ERROR", message, extra);

export const conflict = (message: string, extra: Record<string, unknown> = {}) =>
  new ApiError(409, "CONFLICT", message, extra);

export type PropertyError = { name: string; error: string; message: string };

// 400 for invalid property values, with the per-property detail HubSpot returns.
export function invalidProperties(errors: PropertyError[]): ApiError {
  const details = errors.map((e) => ({
    isValid: false, message: e.message, error: e.error, name: e.name, localizedErrorMessage: e.message,
  }));
  return badRequest(`Property values were not valid: ${JSON.stringify(details)}`, {
    errors: errors.map((e) => ({ message: e.message, code: e.error, context: { propertyName: [e.name] } })),
  });
}
