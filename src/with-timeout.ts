/**
 * Resolve with `fallback` if `p` hasn't settled within `ms`. Used to guard
 * request/response round-trips whose reply may never arrive (e.g. the host dies
 * mid-flight): the caller still gets a value instead of hanging forever. The timer
 * is cleared as soon as `p` settles so no handle dangles. A rejection still
 * propagates — a caller that must never throw should also `.catch`.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(fallback);
    }, ms);
    p.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
