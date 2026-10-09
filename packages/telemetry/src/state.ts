/** Process-wide tracing switches, set once by `initTelemetry`. Immutable snapshots only. */
export interface TelemetryState {
  readonly enabled: boolean;
  readonly captureContent: boolean;
}

let current: TelemetryState = { enabled: false, captureContent: false };

export const telemetryState = (): TelemetryState => current;
export const setTelemetryState = (next: TelemetryState): void => {
  current = next;
};
