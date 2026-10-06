import { forwardOtlp } from "./otel";
import type { SimResponse, TelemetryBundle } from "./protocol";

type ErrorResponse = Extract<SimResponse, { type: "error" }>;

type ForwardingEndpoints = {
  metrics?: string;
};

type Forwarder = typeof forwardOtlp;

export function errorWithTelemetry(message: string, telemetry: TelemetryBundle | null): ErrorResponse {
  const response: ErrorResponse = { type: "error", message };
  if (telemetry) response.telemetry = telemetry;
  return response;
}

export function simulationResponse(status: number, bridgeError: string | null, telemetry: TelemetryBundle | null, telemetryErrors: string[] = []): SimResponse {
  const telemetrySuffix = telemetryErrors.length > 0 ? `; telemetry export failed: ${telemetryErrors.join("; ")}` : "";
  if (status !== 0) return errorWithTelemetry(`host main returned ${status}${telemetrySuffix}`, telemetry);
  if (bridgeError) return errorWithTelemetry(`${bridgeError}${telemetrySuffix}`, telemetry);
  if (telemetryErrors.length > 0) return errorWithTelemetry(`telemetry export failed: ${telemetryErrors.join("; ")}`, telemetry);
  if (!telemetry) throw new Error("telemetry serialization returned no data");
  return { type: "result", telemetry };
}

export async function simulationResponseWithForwarding(
  response: SimResponse,
  telemetry: TelemetryBundle | null,
  endpoints: ForwardingEndpoints,
  forwarder: Forwarder = forwardOtlp,
): Promise<SimResponse> {
  if (!telemetry) return response;
  const errors: string[] = [];
  if (endpoints.metrics) {
    try {
      await forwarder(endpoints.metrics, telemetry.metrics);
    } catch (error: unknown) {
      errors.push(`metrics: ${String(error)}`);
    }
  }
  if (errors.length === 0) return response;
  const forwardingError = errors.join("; ");
  if (response.type === "error") return { ...response, forwardingError };
  if (response.type === "result") return { ...response, forwardingError };
  return response;
}
