// Positive overrides win; zero/missing retain the existing unlimited/fallback semantics.
export function resolveOverride(override: number | undefined | null, fallback: number): number {
  return typeof override === "number" && override > 0 ? override : fallback;
}

export function resolveRpm(override: number | undefined | null): number {
  return resolveOverride(override, Number.MAX_SAFE_INTEGER);
}

export function resolveMinTime(override: number | undefined | null): number {
  return resolveOverride(override, 0);
}

// Bottleneck needs a finite ceiling to avoid internal counter overflow.
export function resolveMaxConcurrent(override: number | undefined | null): number {
  return resolveOverride(override, 1000);
}
