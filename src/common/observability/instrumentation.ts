// Imported first by main.ts so it runs before Nest, Express and pg are loaded;
// instrumentations can only patch modules required after them.
import 'dotenv/config';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { BatchSpanProcessor, type SpanProcessor } from '@opentelemetry/sdk-trace';

// Polling endpoints for the telemetry UI itself would drown out real traffic
const UNTRACED_PATHS = ['/metrics', '/observability', '/health', '/api/docs'];

const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

const spanProcessors: SpanProcessor[] = [];
let metricReaders: PeriodicExportingMetricReader[] | undefined;
let logRecordProcessors: BatchLogRecordProcessor[] | undefined;

if (otlpEndpoint) {
  spanProcessors.push(
    new BatchSpanProcessor({
      exporter: new OTLPTraceExporter(),
    }),
  );
  metricReaders = [
    new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter(),
      exportIntervalMillis: 15000,
    }),
  ];
  logRecordProcessors = [
    new BatchLogRecordProcessor({
      exporter: new OTLPLogExporter(),
    }),
  ];
}

const sdk = new NodeSDK({
  serviceName: process.env.OTEL_SERVICE_NAME ?? 'libraflow-api',
  spanProcessors,
  metricReaders,
  logRecordProcessors,
  instrumentations: [
    new HttpInstrumentation({
      ignoreIncomingRequestHook: (request) =>
        UNTRACED_PATHS.some((path) => request.url?.startsWith(path)),
    }),
    // Only queries made while handling a request or job; skips the pool's own chatter
    new PgInstrumentation({ requireParentSpan: true }),
  ],
});

sdk.start();

// Flush on shutdown, but let Nest's shutdown hooks decide when the process exits
process.once('SIGTERM', () => void sdk.shutdown());
