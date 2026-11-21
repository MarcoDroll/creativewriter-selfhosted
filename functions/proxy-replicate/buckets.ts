/**
 * Which rate-limit bucket a `proxy-replicate` request is counted in.
 *
 * **A prediction POLL gets its own bucket, for the reason `proxy-fal` gives its queue polls.** One
 * shared 30-per-60 s bucket used to count everything, so a single image loop polling every 2 s was
 * the whole budget for one render, and a video watched every 5–10 s for twenty minutes would have
 * 429'd its own generation submits and everyone else's. A poll is a cheap JSON status read at
 * Replicate — not billed inference — so it is metered like `proxy-fal`'s queue reads (500 per 60 s),
 * while the SUBMIT (a POST, real inference) and the model/collection reads stay on the tight one.
 */
export interface RateBucket {
  readonly max: number;
  readonly windowMs: number;
  /** The name the limiter keys on; two names never share a budget. */
  readonly name: string;
}

const SHARED: RateBucket = { max: 30, windowMs: 60_000, name: 'proxy-replicate' };
const POLL: RateBucket = { max: 500, windowMs: 60_000, name: 'proxy-replicate-poll' };

/** `/proxy-replicate/predictions/<id>` and nothing longer: `/cancel` is a POST and is not a poll. */
const PREDICTION_READ = /^\/proxy-replicate\/predictions\/[^/]+\/?$/;

export function rateBucketFor(method: string, pathname: string): RateBucket {
  const read = method === 'GET' || method === 'HEAD';
  return read && PREDICTION_READ.test(pathname) ? POLL : SHARED;
}
