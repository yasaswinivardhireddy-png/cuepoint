// Package server serves ad requests and impression beacons over HTTP, plus health and metrics.
package server

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/yasaswinivardhireddy-png/cuepoint/adserver/internal/catalog"
	"github.com/yasaswinivardhireddy-png/cuepoint/adserver/internal/decision"
	"github.com/yasaswinivardhireddy-png/cuepoint/adserver/internal/events"
	"github.com/yasaswinivardhireddy-png/cuepoint/adserver/internal/freqcap"
	"github.com/yasaswinivardhireddy-png/cuepoint/adserver/internal/vast"
)

type Config struct {
	// PublicBaseURL prefixes the beacon URLs that players call, such as https://ads.example.com.
	PublicBaseURL string
	// Secret signs beacons and keys the viewer-ID hash. Keep it out of source control.
	Secret       []byte
	BeaconMaxAge time.Duration
	Now          func() time.Time
}

type Publisher interface {
	Publish(events.Event) bool
}

type Server struct {
	cfg       Config
	catalog   *catalog.Catalog
	caps      freqcap.Store
	events    Publisher
	log       *slog.Logger
	m         metrics
	beaconKey []byte
	viewerKey []byte
	draining  atomic.Bool
}

type metrics struct {
	duration    *prometheus.HistogramVec
	podSeconds  *prometheus.CounterVec
	ads         prometheus.Counter
	impressions prometheus.Counter
	duplicates  prometheus.Counter
	rejected    *prometheus.CounterVec
	capErrors   prometheus.Counter
}

func New(cfg Config, cat *catalog.Catalog, caps freqcap.Store, pub Publisher, reg prometheus.Registerer, log *slog.Logger) *Server {
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.BeaconMaxAge <= 0 {
		cfg.BeaconMaxAge = time.Hour
	}
	s := &Server{
		cfg: cfg, catalog: cat, caps: caps, events: pub, log: log,
		beaconKey: derive(cfg.Secret, "beacon"),
		viewerKey: derive(cfg.Secret, "viewer"),
		m: metrics{
			duration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
				Name:    "adserver_http_request_duration_seconds",
				Help:    "Request latency by route and status.",
				Buckets: []float64{.0005, .001, .0025, .005, .01, .025, .05, .1, .25, .5, 1},
			}, []string{"route", "code"}),
			podSeconds:  prometheus.NewCounterVec(prometheus.CounterOpts{Name: "adserver_pod_seconds_total", Help: "Ad break seconds requested and filled; filled/requested is the fill rate."}, []string{"kind"}),
			ads:         prometheus.NewCounter(prometheus.CounterOpts{Name: "adserver_ads_served_total", Help: "Ads returned in ad breaks."}),
			impressions: prometheus.NewCounter(prometheus.CounterOpts{Name: "adserver_impressions_total", Help: "Valid impression beacons."}),
			duplicates:  prometheus.NewCounter(prometheus.CounterOpts{Name: "adserver_impressions_duplicate_total", Help: "Replayed impression beacons that were not counted again."}),
			rejected:    prometheus.NewCounterVec(prometheus.CounterOpts{Name: "adserver_beacons_rejected_total", Help: "Beacons rejected, by reason."}, []string{"reason"}),
			capErrors:   prometheus.NewCounter(prometheus.CounterOpts{Name: "adserver_frequency_cap_errors_total", Help: "Frequency cap store errors; ads are served without caps meanwhile."}),
		},
	}
	reg.MustRegister(s.m.duration, s.m.podSeconds, s.m.ads, s.m.impressions, s.m.duplicates, s.m.rejected, s.m.capErrors,
		prometheus.NewGaugeFunc(prometheus.GaugeOpts{Name: "adserver_catalog_campaigns", Help: "Campaigns in the current snapshot."}, func() float64 {
			if snap := cat.Snapshot(); snap != nil {
				return float64(len(snap.Campaigns))
			}
			return 0
		}),
		prometheus.NewGaugeFunc(prometheus.GaugeOpts{Name: "adserver_catalog_age_seconds", Help: "Seconds since the last successful campaign sync."}, func() float64 {
			return cat.Age().Seconds()
		}),
	)
	return s
}

// Drain makes /readyz fail, so the load balancer stops sending traffic before shutdown.
func (s *Server) Drain() { s.draining.Store(true) }

func (s *Server) Handler(metricsHandler http.Handler) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/pods", s.pods)
	mux.HandleFunc("GET /v1/events", s.beacon)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("ok")) })
	mux.HandleFunc("GET /readyz", s.ready)
	mux.Handle("GET /metrics", metricsHandler)
	return s.observe(mux)
}

func (s *Server) ready(w http.ResponseWriter, _ *http.Request) {
	switch {
	case s.draining.Load():
		http.Error(w, "draining", http.StatusServiceUnavailable)
	case s.catalog.Snapshot() == nil:
		http.Error(w, "campaigns not loaded", http.StatusServiceUnavailable)
	default:
		_, _ = w.Write([]byte("ready"))
	}
}

type statusWriter struct {
	http.ResponseWriter
	code int
}

func (w *statusWriter) WriteHeader(code int) {
	w.code = code
	w.ResponseWriter.WriteHeader(code)
}

func (s *Server) observe(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w, code: http.StatusOK}
		defer func() {
			if p := recover(); p != nil {
				s.log.Error("panic serving request", "path", r.URL.Path, "panic", p)
				sw.code = http.StatusInternalServerError
				http.Error(sw, "internal error", http.StatusInternalServerError)
			}
			route := r.Pattern // set by ServeMux once it matched
			if route == "" {
				route = "unmatched"
			}
			s.m.duration.WithLabelValues(route, strconv.Itoa(sw.code)).Observe(time.Since(start).Seconds())
		}()
		next.ServeHTTP(sw, r)
	})
}

type podParams struct {
	req    decision.Request
	userID string
	format string
}

var (
	genrePattern   = regexp.MustCompile(`^[a-z0-9_-]{0,32}$`)
	countryPattern = regexp.MustCompile(`^([A-Z]{2})?$`)
	devices        = []string{"ctv", "mobile", "web"}
)

func intParam(q url.Values, name string, def, lo, hi int) (int, error) {
	raw := q.Get(name)
	if raw == "" {
		return def, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < lo || n > hi {
		return 0, fmt.Errorf("%s must be a whole number from %d to %d", name, lo, hi)
	}
	return n, nil
}

func parsePod(q url.Values, now time.Time) (podParams, error) {
	pod, err := intParam(q, "pod", 60, 5, 300)
	if err != nil {
		return podParams{}, err
	}
	maxAds, err := intParam(q, "max_ads", 4, 1, 8)
	if err != nil {
		return podParams{}, err
	}
	p := podParams{
		req: decision.Request{
			PodDurationSec: pod,
			MaxAds:         maxAds,
			Genre:          strings.ToLower(q.Get("genre")),
			Device:         strings.ToLower(q.Get("device")),
			Country:        strings.ToUpper(q.Get("country")),
			Now:            now,
			Explain:        q.Get("debug") == "1",
		},
		userID: q.Get("uid"),
		format: q.Get("format"),
	}
	switch {
	case !genrePattern.MatchString(p.req.Genre):
		return p, errors.New("genre must be up to 32 letters, digits, '-' or '_'")
	case p.req.Device != "" && !slices.Contains(devices, p.req.Device):
		return p, errors.New("device must be ctv, mobile or web")
	case !countryPattern.MatchString(p.req.Country):
		return p, errors.New("country must be a two-letter ISO 3166 code")
	case len(p.userID) > 128:
		return p, errors.New("uid must be at most 128 characters")
	case p.format != "" && p.format != "json" && p.format != "vast":
		return p, errors.New("format must be json or vast")
	}
	return p, nil
}

type adJSON struct {
	Sequence      int    `json:"sequence"`
	CampaignID    string `json:"campaignId"`
	CampaignName  string `json:"campaignName"`
	AdvertiserID  string `json:"advertiserId"`
	Category      string `json:"category"`
	CreativeID    string `json:"creativeId"`
	DurationSec   int    `json:"durationSec"`
	MediaURL      string `json:"mediaUrl"`
	MimeType      string `json:"mimeType"`
	ImpressionURL string `json:"impressionUrl"`
}

type podJSON struct {
	DecisionID     string          `json:"decisionId"`
	PodDurationSec int             `json:"podDurationSec"`
	FilledSec      int             `json:"filledSec"`
	Ads            []adJSON        `json:"ads"`
	Skipped        []decision.Skip `json:"skipped,omitempty"`
}

func (s *Server) pods(w http.ResponseWriter, r *http.Request) {
	now := s.cfg.Now()
	p, err := parsePod(r.URL.Query(), now)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	snap := s.catalog.Snapshot()
	if snap == nil {
		writeError(w, http.StatusServiceUnavailable, "not_ready", "campaigns are not loaded yet")
		return
	}

	eligible, skipped := decision.Filter(p.req, snap.Campaigns)
	viewer := ""
	if p.userID != "" {
		viewer = s.viewerHash(p.userID)
	}
	var counts map[string]int
	if viewer != "" {
		capped := make([]string, 0, len(eligible))
		for _, c := range eligible {
			if c.FrequencyCapPerDay > 0 {
				capped = append(capped, c.ID)
			}
		}
		if len(capped) > 0 {
			if counts, err = s.caps.Counts(r.Context(), viewer, decision.Day(now), capped); err != nil {
				// Serving without caps beats serving nothing; the metric alerts on it.
				s.m.capErrors.Inc()
				s.log.Warn("frequency caps unavailable", "error", err)
			}
		}
	}
	res := decision.Build(p.req, eligible, counts, s.catalog.Delivered)

	decisionID := newID()
	s.m.podSeconds.WithLabelValues("requested").Add(float64(p.req.PodDurationSec))
	s.m.podSeconds.WithLabelValues("filled").Add(float64(res.FilledSec))
	s.m.ads.Add(float64(len(res.Placements)))

	out := podJSON{DecisionID: decisionID, PodDurationSec: p.req.PodDurationSec, FilledSec: res.FilledSec, Ads: make([]adJSON, len(res.Placements))}
	if p.req.Explain {
		out.Skipped = append(skipped, res.Skipped...)
	}
	for i, pl := range res.Placements {
		c, cr := pl.Campaign, pl.Creative
		out.Ads[i] = adJSON{
			Sequence: i + 1, CampaignID: c.ID, CampaignName: c.Name, AdvertiserID: c.AdvertiserID, Category: c.Category,
			CreativeID: cr.ID, DurationSec: cr.DurationSec, MediaURL: cr.MediaURL, MimeType: cr.MimeType,
			ImpressionURL: s.beaconURL(decisionID, c.ID, cr.ID, viewer, now),
		}
	}

	w.Header().Set("Cache-Control", "no-store")
	if p.format == "vast" {
		ads := make([]vast.Ad, len(res.Placements))
		for i, pl := range res.Placements {
			ads[i] = vast.Ad{
				Sequence: i + 1, AdServingID: fmt.Sprintf("%s-%d", decisionID, i+1), CampaignID: pl.Campaign.ID,
				Title: pl.Campaign.Name, Advertiser: pl.Campaign.AdvertiserID, CreativeID: pl.Creative.ID,
				DurationSec: pl.Creative.DurationSec, MediaURL: pl.Creative.MediaURL, MimeType: pl.Creative.MimeType,
				Width: pl.Creative.Width, Height: pl.Creative.Height, ImpressionURL: out.Ads[i].ImpressionURL,
			}
		}
		body, err := vast.Pod(ads)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal", "could not render VAST")
			return
		}
		w.Header().Set("Content-Type", "application/xml; charset=utf-8")
		_, _ = w.Write(body)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// The beacon payload is signed, so impressions cannot be forged or pointed at another campaign.
func (s *Server) signature(decisionID, campaignID, creativeID, viewer, ts string) string {
	mac := hmac.New(sha256.New, s.beaconKey)
	mac.Write([]byte("imp\n" + decisionID + "\n" + campaignID + "\n" + creativeID + "\n" + viewer + "\n" + ts))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func (s *Server) beaconURL(decisionID, campaignID, creativeID, viewer string, now time.Time) string {
	ts := strconv.FormatInt(now.Unix(), 10)
	q := url.Values{"t": {"imp"}, "d": {decisionID}, "c": {campaignID}, "cr": {creativeID}, "ts": {ts}}
	if viewer != "" {
		q.Set("v", viewer)
	}
	q.Set("sig", s.signature(decisionID, campaignID, creativeID, viewer, ts))
	return strings.TrimRight(s.cfg.PublicBaseURL, "/") + "/v1/events?" + q.Encode()
}

func (s *Server) beacon(w http.ResponseWriter, r *http.Request) {
	now := s.cfg.Now()
	q := r.URL.Query()
	d, c, cr, v, ts, sig := q.Get("d"), q.Get("c"), q.Get("cr"), q.Get("v"), q.Get("ts"), q.Get("sig")
	reject := func(code int, reason, message string) {
		s.m.rejected.WithLabelValues(reason).Inc()
		writeError(w, code, reason, message)
	}
	if q.Get("t") != "imp" || d == "" || c == "" || cr == "" || ts == "" || sig == "" || len(d)+len(c)+len(cr)+len(v) > 512 {
		reject(http.StatusBadRequest, "malformed", "missing or oversized beacon fields")
		return
	}
	if !hmac.Equal([]byte(sig), []byte(s.signature(d, c, cr, v, ts))) {
		reject(http.StatusForbidden, "bad_signature", "beacon signature does not match")
		return
	}
	sec, err := strconv.ParseInt(ts, 10, 64)
	if err != nil {
		reject(http.StatusBadRequest, "malformed", "bad timestamp")
		return
	}
	if issued := time.Unix(sec, 0); now.Sub(issued) > s.cfg.BeaconMaxAge || issued.Sub(now) > time.Minute {
		reject(http.StatusGone, "expired", "beacon is too old")
		return
	}

	// The same ad in the same break always gets the same event ID, so replays are counted once:
	// here for frequency caps, and by the delivery pipeline for reporting.
	sum := sha256.Sum256([]byte(d + "|" + c + "|" + cr))
	eventID := hex.EncodeToString(sum[:16])
	if v != "" {
		fresh, err := s.caps.Record(r.Context(), v, decision.Day(now), c, eventID)
		switch {
		case err != nil:
			s.m.capErrors.Inc()
			s.log.Warn("could not record frequency", "error", err)
		case !fresh:
			s.m.duplicates.Inc()
			w.WriteHeader(http.StatusNoContent)
			return
		}
	}
	s.catalog.RecordImpression(c)
	s.events.Publish(events.Event{ID: eventID, Type: "impression", DecisionID: d, CampaignID: c, CreativeID: cr, Viewer: v, Time: now.UTC()})
	s.m.impressions.Inc()
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNoContent)
}

// viewerHash keys frequency caps by a keyed hash, so raw device IDs are never stored.
func (s *Server) viewerHash(userID string) string {
	mac := hmac.New(sha256.New, s.viewerKey)
	mac.Write([]byte(userID))
	return hex.EncodeToString(mac.Sum(nil)[:16])
}

func derive(secret []byte, label string) []byte {
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(label))
	return mac.Sum(nil)
}

func newID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, code int, kind, message string) {
	writeJSON(w, code, map[string]any{"error": map[string]string{"code": kind, "message": message}})
}
