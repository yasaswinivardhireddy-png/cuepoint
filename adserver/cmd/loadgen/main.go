// Command loadgen sends ad-break requests to the ad server for a fixed time, fires impression
// beacons for part of the served ads, and reports throughput and latency percentiles.
//
//	go run ./cmd/loadgen -url http://localhost:8080/ads -c 32 -d 30s
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"math/rand/v2"
	"net/http"
	"net/url"
	"os"
	"slices"
	"sync"
	"sync/atomic"
	"time"
)

type summary struct {
	DurationSec     float64 `json:"durationSec"`
	Concurrency     int     `json:"concurrency"`
	Requests        int     `json:"requests"`
	Errors          int     `json:"errors"`
	RequestsPerSec  float64 `json:"requestsPerSec"`
	P50Ms           float64 `json:"p50Ms"`
	P95Ms           float64 `json:"p95Ms"`
	P99Ms           float64 `json:"p99Ms"`
	MaxMs           float64 `json:"maxMs"`
	FillRate        float64 `json:"fillRate"`
	AdsServed       int     `json:"adsServed"`
	BeaconsSent     int     `json:"beaconsSent"`
	BeaconsAccepted int     `json:"beaconsAccepted"`
	Replays         int     `json:"replays"`
	BeaconP99Ms     float64 `json:"beaconP99Ms"`
}

type workerResult struct {
	latencies, beaconLatencies        []time.Duration
	errors, ads, beacons, ok, replays int
	requested, filled                 int
}

func main() {
	base := flag.String("url", "http://localhost:8080", "ad server base URL")
	concurrency := flag.Int("c", 32, "concurrent clients")
	length := flag.Duration("d", 30*time.Second, "test duration")
	impressions := flag.Float64("impressions", 0.25, "share of served ads that fire an impression beacon")
	maxBeacons := flag.Int("max-beacons", 0, "stop firing beacons after this many (0 = no limit), to measure counting accuracy at a fixed size")
	replay := flag.Bool("replay", false, "fire every beacon twice, as a flaky player might; replays must not be counted")
	out := flag.String("out", "", "write the summary as JSON to this file")
	flag.Parse()

	var beaconBudget atomic.Int64
	beaconBudget.Store(int64(*maxBeacons))
	takeBeacon := func() bool { return *maxBeacons == 0 || beaconBudget.Add(-1) >= 0 }

	fire := func(client *http.Client, url string) (time.Duration, bool) {
		t := time.Now()
		resp, err := client.Get(url)
		if err != nil {
			return 0, false
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		return time.Since(t), resp.StatusCode == http.StatusNoContent
	}

	genres := []string{"sports", "sports", "news", "drama", "kids", "comedy"}
	devices := []string{"ctv", "ctv", "mobile", "web"}
	countries := []string{"IN", "IN", "IN", "US", "GB"}
	pods := []int{30, 60, 60, 90, 120}

	client := &http.Client{Timeout: 10 * time.Second, Transport: &http.Transport{MaxIdleConnsPerHost: *concurrency, MaxConnsPerHost: *concurrency * 2}}
	deadline := time.Now().Add(*length)
	results := make([]workerResult, *concurrency)
	var wg sync.WaitGroup
	start := time.Now()
	for w := range *concurrency {
		wg.Go(func() {
			rng := rand.New(rand.NewPCG(uint64(w), 42))
			r := &results[w]
			for time.Now().Before(deadline) {
				q := url.Values{
					"pod":     {fmt.Sprint(pods[rng.IntN(len(pods))])},
					"genre":   {genres[rng.IntN(len(genres))]},
					"device":  {devices[rng.IntN(len(devices))]},
					"country": {countries[rng.IntN(len(countries))]},
					"uid":     {fmt.Sprintf("viewer-%d", rng.IntN(5000))},
				}
				t0 := time.Now()
				resp, err := client.Get(*base + "/v1/pods?" + q.Encode())
				if err != nil {
					r.errors++
					continue
				}
				var pod struct {
					PodDurationSec int `json:"podDurationSec"`
					FilledSec      int `json:"filledSec"`
					Ads            []struct {
						ImpressionURL string `json:"impressionUrl"`
					} `json:"ads"`
				}
				decodeErr := json.NewDecoder(resp.Body).Decode(&pod)
				resp.Body.Close()
				r.latencies = append(r.latencies, time.Since(t0))
				if resp.StatusCode != http.StatusOK || decodeErr != nil {
					r.errors++
					continue
				}
				r.requested += pod.PodDurationSec
				r.filled += pod.FilledSec
				r.ads += len(pod.Ads)
				for _, ad := range pod.Ads {
					if rng.Float64() >= *impressions || !takeBeacon() {
						continue
					}
					r.beacons++
					if latency, ok := fire(client, ad.ImpressionURL); ok {
						r.ok++
						r.beaconLatencies = append(r.beaconLatencies, latency)
					}
					if *replay {
						if _, ok := fire(client, ad.ImpressionURL); ok {
							r.replays++
						}
					}
				}
			}
		})
	}
	wg.Wait()
	elapsed := time.Since(start)

	var all, beacons []time.Duration
	s := summary{DurationSec: elapsed.Seconds(), Concurrency: *concurrency}
	requested, filled := 0, 0
	for _, r := range results {
		all = append(all, r.latencies...)
		beacons = append(beacons, r.beaconLatencies...)
		s.Errors += r.errors
		s.AdsServed += r.ads
		s.BeaconsSent += r.beacons
		s.BeaconsAccepted += r.ok
		s.Replays += r.replays
		requested += r.requested
		filled += r.filled
	}
	s.Requests = len(all)
	s.RequestsPerSec = float64(s.Requests) / elapsed.Seconds()
	if requested > 0 {
		s.FillRate = float64(filled) / float64(requested)
	}
	slices.Sort(all)
	slices.Sort(beacons)
	s.P50Ms, s.P95Ms, s.P99Ms = ms(all, 0.50), ms(all, 0.95), ms(all, 0.99)
	if len(all) > 0 {
		s.MaxMs = float64(all[len(all)-1].Microseconds()) / 1000
	}
	s.BeaconP99Ms = ms(beacons, 0.99)

	fmt.Printf("| Ad requests | Errors | Requests/s | p50 | p95 | p99 | Fill rate | Beacons accepted | Replays sent |\n|---|---|---|---|---|---|---|---|---|\n")
	fmt.Printf("| %d | %d | %.0f | %.2f ms | %.2f ms | %.2f ms | %.1f%% | %d/%d | %d |\n",
		s.Requests, s.Errors, s.RequestsPerSec, s.P50Ms, s.P95Ms, s.P99Ms, s.FillRate*100, s.BeaconsAccepted, s.BeaconsSent, s.Replays)
	if *out != "" {
		data, _ := json.MarshalIndent(s, "", "  ")
		if err := os.WriteFile(*out, append(data, '\n'), 0o644); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	}
	if s.Requests == 0 || float64(s.Errors) > 0.001*float64(s.Requests) || s.BeaconsAccepted != s.BeaconsSent {
		os.Exit(1)
	}
}

func ms(sorted []time.Duration, q float64) float64 {
	if len(sorted) == 0 {
		return 0
	}
	i := int(q*float64(len(sorted))+0.5) - 1
	i = min(max(i, 0), len(sorted)-1)
	return float64(sorted[i].Microseconds()) / 1000
}
