// Package telemetry owns the simulator's OpenTelemetry wire boundary: the OTLP
// JSON encoding of export requests and the typed OTLP attribute constructors.
//
// It deliberately depends on nothing in the harness so the WASM export layer
// and any native caller share one serialization behavior.
package telemetry

import (
	"errors"
	"fmt"

	collectormetricv1 "go.opentelemetry.io/proto/otlp/collector/metrics/v1"
	commonv1 "go.opentelemetry.io/proto/otlp/common/v1"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

// marshaler is the shared OTLP/JSON encoder: lowerCamelCase field names, enums as
// symbolic names, and AllowPartial false so a malformed request fails loudly.
// Output is compact; the bodies are parsed by the browser worker.
var marshaler = protojson.MarshalOptions{
	Multiline:       false,
	UseProtoNames:   false,
	UseEnumNumbers:  false,
	AllowPartial:    false,
	EmitUnpopulated: false,
}

// MarshalMetricsRequest serializes an OTLP metrics request body, i.e. a
// {"resourceMetrics": [...]} document ready to POST to /v1/metrics.
func MarshalMetricsRequest(request *collectormetricv1.ExportMetricsServiceRequest) ([]byte, error) {
	if request == nil {
		return nil, errors.New("telemetry: nil OTLP metrics request")
	}
	return marshal(request)
}

func marshal(message proto.Message) ([]byte, error) {
	data, err := marshaler.Marshal(message)
	if err != nil {
		return nil, fmt.Errorf("telemetry: marshal OTLP request: %w", err)
	}
	return data, nil
}

// StringAttribute builds an OTLP attribute holding text: kernel names, cache labels
// and CPI reasons.
func StringAttribute(key, value string) *commonv1.KeyValue {
	return &commonv1.KeyValue{
		Key:   key,
		Value: &commonv1.AnyValue{Value: &commonv1.AnyValue_StringValue{StringValue: value}},
	}
}

// IntAttribute builds an OTLP attribute holding a 64-bit integer. OTLP/JSON encodes
// int64 as a JSON string, which consumers must expect.
func IntAttribute(key string, value int64) *commonv1.KeyValue {
	return &commonv1.KeyValue{
		Key:   key,
		Value: &commonv1.AnyValue{Value: &commonv1.AnyValue_IntValue{IntValue: value}},
	}
}

// DoubleAttribute builds an OTLP attribute holding a double: rates (cache and
// TLB hit rates) and cycles-per-instruction values.
func DoubleAttribute(key string, value float64) *commonv1.KeyValue {
	return &commonv1.KeyValue{
		Key:   key,
		Value: &commonv1.AnyValue{Value: &commonv1.AnyValue_DoubleValue{DoubleValue: value}},
	}
}
