package server

import (
	"encoding/json"
	"encoding/xml"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/yasaswinivardhireddy-png/cuepoint/adserver/internal/catalog"
	"github.com/yasaswinivardhireddy-png/cuepoint/adserver/internal/decision"
	"github.com/yasaswinivardhireddy-png/cuepoint/adserver/internal/events"
	"github.com/yasaswinivardhireddy-png/cuepoint/adserver/internal/freqcap"
)

type published struct {
	mu     sync.Mutex
	events []events.Event
}

func (p *published) Publish(e events.Event) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.events = append(p.events, e)
	return true
}

func (p *published) count() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.events)
}

type fixture struct {
	t      *testing.T
	srv    *httptest.Server
	now    time.Time
	events *published
	cat    *catalog.Catalog
}

func newFixture(t *testing.T, campaigns ...*decision.Campaign) *fixture {
	f := &fixture{t: t, now: time.Date(2026, 11, 6, 12, 0, 0, 0, time.UTC), events: &published{}, cat: catalog.New()}
	if campaigns != nil {
		f.cat.Store(&catalog.Snapshot{ETag: `"v1"`, Campaigns: campaigns})
	}
	reg := prometheus.NewRegistry()
	s := New(Config{PublicBaseURL: "http://ads.test", Secret: []byte("test-secret"), Now: func() time.Time { return f.now }},
		f.cat, freqcap.NewMemory(), f.events, reg, slog.New(slog.NewTextHandler(io.Discard, nil)))
	f.srv = httptest.NewServer(s.Handler(promhttp.HandlerFor(reg, promhttp.HandlerOpts{})))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fixture) get(path string) (*http.Response, string) {
	f.t.Helper()
	resp, err := http.Get(f.srv.URL + path)
	if err != nil {
		f.t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp, string(body)
}

func (f *fixture) pod(query string) podJSON {
	f.t.Helper()
	resp, body := f.get("/v1/pods?" + query)
	if resp.StatusCode != http.StatusOK {
		f.t.Fatalf("pod %s: %d %s", query, resp.StatusCode, body)
	}
	var out podJSON
	if err := json.Unmarshal([]byte(body), &out); err != nil {
		f.t.Fatal(err)
	}
	return out
}

// beacon fires an impression URL against the test server instead of the public host.
func (f *fixture) beacon(impressionURL string) int {
	f.t.Helper()
	u, err := url.Parse(impressionURL)
	if err != nil {
		f.t.Fatal(err)
	}
	resp, _ := f.get(u.Path + "?" + u.RawQuery)
	return resp.StatusCode
}

func sportsCampaign(id, category string, cpm int64, freqCap int) *decision.Campaign {
	return &decision.Campaign{
		ID: id, AdvertiserID: "adv-" + id, Name: "Campaign " + id, Category: category,
		StartDate: "2026-11-01", EndDate: "2026-11-30", DailyGoal: 10000, CPMCents: cpm, FrequencyCapPerDay: freqCap,
		Targeting: decision.Targeting{Genres: []string{"sports"}},
		Creatives: []decision.Creative{{ID: id + "-30", DurationSec: 30, MediaURL: "https://cdn.test/" + id + ".mp4", MimeType: "video/mp4", Width: 1920, Height: 1080}},
	}
}

func TestPodRequestBeaconAndFrequencyCapLoop(t *testing.T) {
	f := newFixture(t, sportsCampaign("motors", "auto", 3000, 1), sportsCampaign("cola", "beverage", 1000, 0))

	first := f.pod("pod=60&genre=sports&device=ctv&country=IN&uid=device-123")
	if len(first.Ads) != 2 || first.Ads[0].CampaignID != "motors" || first.Ads[1].Sequence != 2 || first.FilledSec != 60 {
		t.Fatalf("first pod %+v", first)
	}
	if !strings.HasPrefix(first.Ads[0].ImpressionURL, "http://ads.test/v1/events?") || strings.Contains(first.Ads[0].ImpressionURL, "device-123") {
		t.Fatalf("impression URL %s", first.Ads[0].ImpressionURL)
	}

	if code := f.beacon(first.Ads[0].ImpressionURL); code != http.StatusNoContent {
		t.Fatalf("beacon status %d", code)
	}
	if code := f.beacon(first.Ads[0].ImpressionURL); code != http.StatusNoContent || f.events.count() != 1 {
		t.Fatalf("replayed beacon: status %d, events %d (want it counted once)", code, f.events.count())
	}
	e := f.events.events[0]
	if e.Type != "impression" || e.CampaignID != "motors" || e.DecisionID != first.DecisionID || e.ID == "" || e.Viewer == "" {
		t.Fatalf("event %+v", e)
	}

	// The cap of 1 per day is now reached for this viewer, but not for another one.
	second := f.pod("pod=60&genre=sports&uid=device-123&debug=1")
	if len(second.Ads) != 1 || second.Ads[0].CampaignID != "cola" {
		t.Fatalf("second pod %+v", second)
	}
	if len(second.Skipped) != 1 || second.Skipped[0].Reason != "frequency cap reached: this viewer saw it 1 of 1 times today" {
		t.Fatalf("skipped %+v", second.Skipped)
	}
	if other := f.pod("pod=60&genre=sports&uid=device-456"); len(other.Ads) != 2 {
		t.Fatalf("other viewer %+v", other)
	}
}

func TestBeaconsCannotBeForgedOrReplayedLate(t *testing.T) {
	f := newFixture(t, sportsCampaign("motors", "auto", 3000, 0))
	imp := f.pod("pod=30&genre=sports").Ads[0].ImpressionURL

	tampered := strings.Replace(imp, "c=motors", "c=someone-else", 1)
	if code := f.beacon(tampered); code != http.StatusForbidden {
		t.Fatalf("tampered beacon status %d", code)
	}
	if code := f.beacon(strings.Replace(imp, "t=imp", "t=click", 1)); code != http.StatusBadRequest {
		t.Fatalf("wrong type status %d", code)
	}
	f.now = f.now.Add(2 * time.Hour)
	if code := f.beacon(imp); code != http.StatusGone {
		t.Fatalf("expired beacon status %d", code)
	}
	if f.events.count() != 0 {
		t.Fatalf("%d events from bad beacons", f.events.count())
	}
	_, metrics := f.get("/metrics")
	for _, want := range []string{
		`adserver_beacons_rejected_total{reason="bad_signature"} 1`,
		`adserver_beacons_rejected_total{reason="expired"} 1`,
		`adserver_beacons_rejected_total{reason="malformed"} 1`,
		`adserver_pod_seconds_total{kind="requested"} 30`,
		`adserver_pod_seconds_total{kind="filled"} 30`,
		`adserver_catalog_campaigns 1`,
		`adserver_http_request_duration_seconds_count{code="200",route="GET /v1/pods"} 1`,
	} {
		if !strings.Contains(metrics, want) {
			t.Errorf("metrics missing %s", want)
		}
	}
}

func TestVASTFormat(t *testing.T) {
	f := newFixture(t, sportsCampaign("motors", "auto", 3000, 0))
	resp, body := f.get("/v1/pods?pod=30&genre=sports&format=vast")
	if resp.StatusCode != http.StatusOK || resp.Header.Get("Content-Type") != "application/xml; charset=utf-8" {
		t.Fatalf("%d %s", resp.StatusCode, resp.Header.Get("Content-Type"))
	}
	var doc struct {
		Version string `xml:"version,attr"`
		Ads     []struct {
			ID         string `xml:"id,attr"`
			Impression string `xml:"InLine>Impression"`
		} `xml:"Ad"`
	}
	if err := xml.Unmarshal([]byte(body), &doc); err != nil {
		t.Fatal(err)
	}
	if doc.Version != "4.2" || len(doc.Ads) != 1 || doc.Ads[0].ID != "motors" || f.beacon(doc.Ads[0].Impression) != http.StatusNoContent {
		t.Fatalf("vast %+v", doc)
	}
}

func TestValidationAndReadiness(t *testing.T) {
	f := newFixture(t)
	if resp, _ := f.get("/readyz"); resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("ready before the first sync: %d", resp.StatusCode)
	}
	if resp, _ := f.get("/v1/pods?pod=30"); resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("pod before the first sync: %d", resp.StatusCode)
	}
	f.cat.Store(&catalog.Snapshot{})
	if resp, _ := f.get("/readyz"); resp.StatusCode != http.StatusOK {
		t.Fatalf("ready after sync: %d", resp.StatusCode)
	}
	for query, want := range map[string]string{
		"pod=3":                           "pod must be a whole number from 5 to 300",
		"pod=abc":                         "pod must be a whole number from 5 to 300",
		"max_ads=9":                       "max_ads must be a whole number from 1 to 8",
		"device=toaster":                  "device must be ctv, mobile or web",
		"country=India":                   "country must be a two-letter ISO 3166 code",
		"genre=%3Cscript%3E":              "genre must be up to 32 letters, digits, '-' or '_'",
		"format=html":                     "format must be json or vast",
		"uid=" + strings.Repeat("x", 129): "uid must be at most 128 characters",
	} {
		resp, body := f.get("/v1/pods?" + query)
		if resp.StatusCode != http.StatusBadRequest || !strings.Contains(body, want) {
			t.Errorf("%s: %d %s", query, resp.StatusCode, body)
		}
	}
	if empty := f.pod("pod=30&genre=sports"); len(empty.Ads) != 0 || empty.Ads == nil {
		t.Fatalf("no-fill response %+v", empty)
	}
}
