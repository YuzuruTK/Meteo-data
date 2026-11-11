import {
  DRY_CONFIRM_MS,
  FRESH_MS,
  fresh,
  timestamp,
  RAIN_THRESHOLD_MM_H,
} from "../../shared/weather";
export interface RainState {
  raining: number;
  last_processed_observed_at: string | null;
  last_valid_observed_at: string | null;
  dry_since_observed_at: string | null;
  dry_sample_count: number;
  episode_started_observed_at: string | null;
  last_event_id: string | null;
  version: number;
}
export interface RainSample {
  stationId: string;
  stationName: string;
  observedAt?: string;
  rainRateMmH: number | null;
}
export function evaluateRainTransition(
  previous: RainState | null,
  sample: RainSample,
  now: number,
) {
  const time = sample.observedAt ?? "";
  if (!fresh(time, now))
    return { state: previous, event: false, reason: "invalid-time" };
  const ms = timestamp(time),
    observed = new Date(ms).toISOString();
  if (
    previous?.last_processed_observed_at &&
    ms <= timestamp(previous.last_processed_observed_at)
  )
    return { state: previous, event: false, reason: "duplicate-or-older" };
  const state: RainState = {
    raining: 0,
    last_processed_observed_at: null,
    last_valid_observed_at: null,
    dry_since_observed_at: null,
    dry_sample_count: 0,
    episode_started_observed_at: null,
    last_event_id: null,
    version: 0,
    ...previous,
  };
  state.version++;
  state.last_processed_observed_at = observed;
  const rate = sample.rainRateMmH;
  if (rate === null || !Number.isFinite(rate) || rate < 0) {
    state.dry_since_observed_at = null;
    state.dry_sample_count = 0;
    return { state, event: false, reason: "invalid-rate" };
  }
  const wet = rate >= RAIN_THRESHOLD_MM_H;
  let event = false;
  if (
    !state.last_valid_observed_at ||
    ms - timestamp(state.last_valid_observed_at) > FRESH_MS
  ) {
    state.raining = Number(wet);
    state.episode_started_observed_at = null;
    state.last_event_id = null;
    state.dry_since_observed_at = null;
    state.dry_sample_count = 0;
  } else if (wet) {
    event = state.raining === 0;
    if (event) {
      state.episode_started_observed_at = observed;
      state.last_event_id = `rain-start:${sample.stationId}:${observed}`;
    }
    state.raining = 1;
    state.dry_since_observed_at = null;
    state.dry_sample_count = 0;
  } else if (state.raining) {
    state.dry_since_observed_at ??= observed;
    state.dry_sample_count++;
    if (
      state.dry_sample_count >= 2 &&
      ms - timestamp(state.dry_since_observed_at) >= DRY_CONFIRM_MS
    ) {
      state.raining = 0;
      state.episode_started_observed_at = null;
      state.dry_since_observed_at = null;
      state.dry_sample_count = 0;
    }
  }
  state.last_valid_observed_at = observed;
  return { state, event, reason: event ? "rain-start" : "reference" };
}
