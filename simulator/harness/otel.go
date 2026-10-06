package harness

import (
	"time"

	collectormetricv1 "go.opentelemetry.io/proto/otlp/collector/metrics/v1"
	commonv1 "go.opentelemetry.io/proto/otlp/common/v1"
	metricv1 "go.opentelemetry.io/proto/otlp/metrics/v1"
	resourcev1 "go.opentelemetry.io/proto/otlp/resource/v1"
	"hipy/simulator/telemetry"
)

const (
	metricKernelDuration    = "hipy.simulator.kernel.duration"
	metricInstructionsTotal = "hipy.simulator.instructions.total"
	metricWavesTotal        = "hipy.simulator.waves.total"
	metricCUInstructions    = "hipy.simulator.cu.instructions"
	metricSIMDInstructions  = "hipy.simulator.simd.instructions"
	metricCPI               = "hipy.simulator.cpi"
	metricCPIReason         = "hipy.simulator.cpi.reason"
	metricCacheHitRate      = "hipy.simulator.cache.hit_rate"
	metricCacheLatency      = "hipy.simulator.cache.latency"
	metricTLBHitRate        = "hipy.simulator.tlb.hit_rate"
	// Cache levels above DRAM, tagged by level. One metric rather than one per level
	// because the level set differs by device (CDNA3 has a MALL between L2 and DRAM,
	// the R9 Nano does not).
	metricMemLevelBytes        = "hipy.simulator.mem.level.bytes"
	metricMemLevelTransactions = "hipy.simulator.mem.level.transactions"
	metricDRAMBytes            = "hipy.simulator.dram.bytes"
	metricDRAMTransactions     = "hipy.simulator.dram.transactions"
	metricSimTime              = "hipy.simulator.sim.time"
	cpiUnit                    = "{cycles/instruction}"
)

// OTLPMetrics returns collected simulator metrics as a canonical OTLP metrics
// request. Call it after Drain.
func (h *Harness) OTLPMetrics() *collectormetricv1.ExportMetricsServiceRequest {
	request := &collectormetricv1.ExportMetricsServiceRequest{}
	if h.hooks == nil || h.lastKernelName == "" {
		return request
	}

	collected := h.collectMetrics()
	observedAt := uint64(time.Now().UnixNano())
	metrics := []*metricv1.Metric{
		gaugeMetric(metricKernelDuration, "ns",
			intDataPoint(observedAt, collected.kernelTimeNS,
				telemetry.StringAttribute("hipy.kernel.name", collected.kernelName))),
		sumMetric(h.startTimeUnixNano, metricInstructionsTotal, "1",
			intDataPoint(observedAt, collected.totalInstructions)),
		sumMetric(h.startTimeUnixNano, metricWavesTotal, "{wave}",
			intDataPoint(observedAt, uint64(collected.waves))),
		// The engine's clock, the only honest denominator for a traffic rate:
		// kernel.duration is host-side accounting of when the launch command was
		// outstanding, not simulated hardware time.
		gaugeMetric(metricSimTime, "ps",
			intDataPoint(observedAt, uint64(h.sim.GetEngine().CurrentTime()))),
	}

	cuInstructions := make([]*metricv1.NumberDataPoint, 0, len(collected.cus))
	cpi := make([]*metricv1.NumberDataPoint, 0, len(collected.cus))
	simdInstructions := make([]*metricv1.NumberDataPoint, 0)
	for _, cu := range collected.cus {
		cuID := telemetry.IntAttribute("hipy.cu.id", int64(cu.id))
		cuInstructions = append(cuInstructions,
			intDataPoint(observedAt, cu.instCount, cuID))
		cpi = append(cpi, doubleDataPoint(observedAt, cu.cpi,
			telemetry.StringAttribute("hipy.component.type", "compute_unit"),
			cuID))
		for _, simd := range cu.simds {
			simdInstructions = append(simdInstructions,
				intDataPoint(observedAt, simd.instCount,
					telemetry.IntAttribute("hipy.cu.id", int64(cu.id)),
					telemetry.IntAttribute("hipy.simd.id", int64(simd.id))))
			cpi = append(cpi, doubleDataPoint(observedAt, simd.cpi,
				telemetry.StringAttribute("hipy.component.type", "simd"),
				telemetry.IntAttribute("hipy.cu.id", int64(cu.id)),
				telemetry.IntAttribute("hipy.simd.id", int64(simd.id))))
		}
	}
	metrics = append(metrics,
		sumMetric(h.startTimeUnixNano, metricCUInstructions, "1", cuInstructions...),
		sumMetric(h.startTimeUnixNano, metricSIMDInstructions, "1", simdInstructions...),
		gaugeMetric(metricCPI, cpiUnit, cpi...),
	)

	cpiReasons := make([]*metricv1.NumberDataPoint, 0, len(collected.cpiStack))
	for _, entry := range collected.cpiStack {
		cpiReasons = append(cpiReasons, doubleDataPoint(observedAt, entry.cyclesPerInst,
			telemetry.StringAttribute("hipy.cpi.reason", entry.reason)))
	}
	metrics = append(metrics, gaugeMetric(metricCPIReason, cpiUnit, cpiReasons...))

	cacheHitRates := make([]*metricv1.NumberDataPoint, 0, len(collected.caches))
	cacheLatencies := make([]*metricv1.NumberDataPoint, 0, len(collected.caches))
	for _, cache := range collected.caches {
		name := telemetry.StringAttribute("hipy.cache.name", cache.name)
		cacheHitRates = append(cacheHitRates,
			doubleDataPoint(observedAt, cache.hitRate, name))
		cacheLatencies = append(cacheLatencies,
			doubleDataPoint(observedAt, cache.avgLatencyNS, name))
	}
	metrics = append(metrics,
		gaugeMetric(metricCacheHitRate, "1", cacheHitRates...),
		gaugeMetric(metricCacheLatency, "ns", cacheLatencies...),
		gaugeMetric(metricTLBHitRate, "1",
			doubleDataPoint(observedAt, collected.tlbHitRate)),
		sumMetric(h.startTimeUnixNano, metricMemLevelBytes, "By",
			memLevelDataPoints(observedAt, h.startTimeUnixNano, collected,
				func(st collectedDRAMStats) (uint64, uint64) { return st.readBytes, st.writeBytes })...),
		sumMetric(h.startTimeUnixNano, metricMemLevelTransactions, "1",
			memLevelDataPoints(observedAt, h.startTimeUnixNano, collected,
				func(st collectedDRAMStats) (uint64, uint64) {
					return st.readTransactions, st.writeTransactions
				})...),
		sumMetric(h.startTimeUnixNano, metricDRAMBytes, "By",
			intDataPoint(observedAt, collected.dram.readBytes,
				telemetry.StringAttribute("hipy.dram.direction", "read")),
			intDataPoint(observedAt, collected.dram.writeBytes,
				telemetry.StringAttribute("hipy.dram.direction", "write"))),
		sumMetric(h.startTimeUnixNano, metricDRAMTransactions, "1",
			intDataPoint(observedAt, collected.dram.readTransactions,
				telemetry.StringAttribute("hipy.dram.direction", "read")),
			intDataPoint(observedAt, collected.dram.writeTransactions,
				telemetry.StringAttribute("hipy.dram.direction", "write"))),
	)

	request.ResourceMetrics = []*metricv1.ResourceMetrics{{
		Resource: otelResource(h.deviceName),
		ScopeMetrics: []*metricv1.ScopeMetrics{{
			Scope:   otelScope(),
			Metrics: metrics,
		}},
	}}
	return request
}

func otelResource(gpuName string) *resourcev1.Resource {
	return &resourcev1.Resource{Attributes: []*commonv1.KeyValue{
		telemetry.StringAttribute("service.name", "hipy/simulator"),
		telemetry.StringAttribute("service.version", "v1"),
		telemetry.StringAttribute("telemetry.sdk.name", "mgpusim"),
		telemetry.StringAttribute("telemetry.sdk.language", "go"),
		telemetry.StringAttribute("telemetry.sdk.version", "v5"),
		telemetry.StringAttribute("hipy.simulator.mgpusim.version", "v5"),
		telemetry.StringAttribute("hipy.simulator.gpu", gpuName),
		telemetry.StringAttribute("hipy.simulator.scenario", "custom"),
	}}
}

func otelScope() *commonv1.InstrumentationScope {
	return &commonv1.InstrumentationScope{
		Name:    "hipy/simulator",
		Version: "v1",
	}
}

func sumMetric(startTimeUnixNano uint64, name, unit string, points ...*metricv1.NumberDataPoint) *metricv1.Metric {
	for _, point := range points {
		point.StartTimeUnixNano = startTimeUnixNano
	}
	return &metricv1.Metric{
		Name: name,
		Unit: unit,
		Data: &metricv1.Metric_Sum{Sum: &metricv1.Sum{
			DataPoints:             points,
			AggregationTemporality: metricv1.AggregationTemporality_AGGREGATION_TEMPORALITY_CUMULATIVE,
			IsMonotonic:            true,
		}},
	}
}

func gaugeMetric(name, unit string, points ...*metricv1.NumberDataPoint) *metricv1.Metric {
	return &metricv1.Metric{
		Name: name,
		Unit: unit,
		Data: &metricv1.Metric_Gauge{Gauge: &metricv1.Gauge{
			DataPoints: points,
		}},
	}
}

func intDataPoint(observedAt, value uint64, attributes ...*commonv1.KeyValue) *metricv1.NumberDataPoint {
	point := &metricv1.NumberDataPoint{
		Attributes:   attributes,
		TimeUnixNano: observedAt,
	}
	if value <= uint64(1<<63-1) {
		point.Value = &metricv1.NumberDataPoint_AsInt{AsInt: int64(value)}
	} else {
		point.Value = &metricv1.NumberDataPoint_AsDouble{AsDouble: float64(value)}
	}
	return point
}

func doubleDataPoint(observedAt uint64, value float64, attributes ...*commonv1.KeyValue) *metricv1.NumberDataPoint {
	return &metricv1.NumberDataPoint{
		Attributes:   attributes,
		TimeUnixNano: observedAt,
		Value: &metricv1.NumberDataPoint_AsDouble{
			AsDouble: value,
		},
	}
}

// memLevelDataPoints renders one read and one write data point per cache level the
// device actually built. Absent levels are skipped rather than reported as zero,
// which would assert that the hardware exists and did nothing.
func memLevelDataPoints(
	observedAt, startTime uint64,
	collected collectedMetrics,
	pick func(collectedDRAMStats) (uint64, uint64),
) []*metricv1.NumberDataPoint {
	points := make([]*metricv1.NumberDataPoint, 0, memLevelCount*2)
	for level := 0; level < memLevelCount; level++ {
		if !collected.memLevelPresent[level] {
			continue
		}
		name := telemetry.StringAttribute("hipy.mem.level", memLevelNames[level])
		readValue, writeValue := pick(collected.memLevels[level])
		points = append(points,
			intDataPoint(observedAt, readValue,
				name, telemetry.StringAttribute("hipy.mem.direction", "read")),
			intDataPoint(observedAt, writeValue,
				name, telemetry.StringAttribute("hipy.mem.direction", "write")))
	}
	return points
}
