import type { TraceSpan, Tracer } from './types.js'

const NOOP_SPAN: TraceSpan = {
  setAttribute: () => undefined,
  addEvent: () => undefined,
  end: () => undefined,
  recordException: () => undefined,
}

export function createNoopTracer(): Tracer {
  return {
    startSpan: () => NOOP_SPAN,
  }
}

export interface OtelTracerConfig {
  serviceName: string
  endpoint?: string
  sampler: 'always_on' | 'parent' | { ratio: number }
}

export async function createOtelTracer(config: OtelTracerConfig): Promise<Tracer> {
  const { NodeTracerProvider, BatchSpanProcessor } = await import('@opentelemetry/sdk-trace-node')
  const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http')
  const { resourceFromAttributes } = await import('@opentelemetry/resources')
  const { SpanStatusCode, trace } = await import('@opentelemetry/api')

  const exporter = new OTLPTraceExporter({
    url: config.endpoint ?? 'http://localhost:4318/v1/traces',
  })

  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ 'service.name': config.serviceName }),
    spanProcessors: [new BatchSpanProcessor(exporter)],
  })
  provider.register()

  const innerTracer = trace.getTracer(config.serviceName)

  return {
    startSpan(name: string, attrs?: Record<string, string | number>): TraceSpan {
      const span = innerTracer.startSpan(name)
      if (attrs) {
        for (const [k, v] of Object.entries(attrs)) span.setAttribute(k, v)
      }
      return {
        setAttribute(key, value) {
          span.setAttribute(key, value)
        },
        addEvent(eventName, eventAttrs) {
          span.addEvent(eventName, eventAttrs)
        },
        end(endTime) {
          span.end(endTime)
        },
        recordException(err) {
          span.recordException(err instanceof Error ? err : new Error(String(err)))
          span.setStatus({ code: SpanStatusCode.ERROR })
        },
      }
    },
  }
}
