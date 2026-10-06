// Package otlpcmp renders OTLP payloads so two runs of the same workload compare
// equal. Only wall-clock artifacts and floating-point noise are normalized; nothing
// simulated is touched.
package otlpcmp

import (
	"regexp"
	"strconv"
)

// unixNanoField matches the JSON encoding of an OTLP timestamp field.
var unixNanoField = regexp.MustCompile(`"(?:time_unix_nano|start_time_unix_nano|end_time_unix_nano)":([0-9]+)`)

// doubleValueField matches the JSON encoding of a floating-point metric value.
var doubleValueField = regexp.MustCompile(`"AsDouble":(-?[0-9][^,}]*)`)

// Metrics renders an OTLP metrics payload so two runs of the same workload produce
// the same string. Normalized: data point timestamps (wall-clock, moving by
// milliseconds between identical runs) and floating-point values (the CPI gauges
// accumulate by ranging over a Go map, so the additions land on a different last bit
// each run). Nine significant digits is far finer than any real perturbation: a bank
// conflict moves duration and CPI by whole cycles, not 1e-13.
func Metrics(payload []byte) string {
	stripped := unixNanoField.ReplaceAllString(string(payload),
		`"unix_nano":"<wall-clock, not simulated>"`)
	stripped = doubleValueField.ReplaceAllStringFunc(stripped, func(field string) string {
		parts := doubleValueField.FindStringSubmatch(field)
		value, err := strconv.ParseFloat(parts[1], 64)
		if err != nil {
			return field
		}
		return `"AsDouble":` + strconv.FormatFloat(value, 'g', 9, 64)
	})
	return stripped
}
