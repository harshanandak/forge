/** Injected time; the state owner judges expiry with this clock, never the wall clock directly. */
export interface ClockPort {
  /** Milliseconds since the Unix epoch. */
  now(): number;
}
