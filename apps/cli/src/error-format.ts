function errorSummary(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

/**
 * Keeps the top-level stack while exposing nested AggregateError and cause
 * messages that Node otherwise omits from CLI output.
 */
export function formatCliError(
  error: unknown,
  seen: Set<unknown> = new Set(),
): string {
  if (typeof error === "object" && error !== null) {
    if (seen.has(error)) {
      return "[circular error]";
    }
    seen.add(error);
  }

  const primary =
    error instanceof Error ? error.stack ?? errorSummary(error) : String(error);
  const nested: unknown[] =
    error instanceof AggregateError
      ? [...error.errors]
      : error instanceof Error && error.cause !== undefined
        ? [error.cause]
        : [];
  if (nested.length === 0) {
    return primary;
  }

  const causes = nested.map(
    (cause, index) =>
      `Cause ${index + 1}: ${formatCliError(cause, seen)}`,
  );
  return [primary, ...causes].join("\n");
}
