const otlpForwardTimeoutMS = 5000;

export async function forwardOtlp(
  endpoint: string,
  body: unknown,
  fetcher: typeof fetch = fetch,
  timeoutMS: number = otlpForwardTimeoutMS,
): Promise<void> {
  if (!endpoint) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMS);
  let response: Response;
  try {
    response = await fetcher(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error: unknown) {
    if (controller.signal.aborted) throw new Error(`OTLP forwarding to ${endpoint} timed out after ${timeoutMS} ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw new Error(`OTLP forwarding failed with HTTP ${response.status}`);
}
