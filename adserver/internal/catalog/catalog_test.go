package catalog

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/yasaswinivardhireddy-png/cuepoint/adserver/internal/decision"
)

func TestSyncUsesETagsAndKeepsTheLastGoodSnapshot(t *testing.T) {
	var calls, notModified atomic.Int32
	failing := atomic.Bool{}
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Header.Get("Authorization") != "Bearer internal-token" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		if failing.Load() {
			http.Error(w, "boom", http.StatusInternalServerError)
			return
		}
		if r.Header.Get("If-None-Match") == `"v1"` {
			notModified.Add(1)
			w.WriteHeader(http.StatusNotModified)
			return
		}
		w.Header().Set("ETag", `"v1"`)
		_, _ = io.WriteString(w, `{"campaigns":[{"id":"c1","name":"Winter Drive","dailyImpressionGoal":100,"deliveredToday":40,
			"creatives":[{"id":"cr1","durationSec":30}],"targeting":{"genres":["sports"]}}]}`)
	}))
	defer api.Close()

	cat := New()
	s := &Syncer{URL: api.URL, Token: "internal-token", Client: api.Client(), Catalog: cat, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), Errors: prometheus.NewCounter(prometheus.CounterOpts{Name: "x"})}
	ctx := context.Background()

	if err := s.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	snap := cat.Snapshot()
	if snap == nil || snap.ETag != `"v1"` || len(snap.Campaigns) != 1 || snap.Campaigns[0].Targeting.Genres[0] != "sports" || snap.Campaigns[0].Creatives[0].DurationSec != 30 {
		t.Fatalf("snapshot %+v", snap)
	}

	if err := s.Sync(ctx); err != nil || notModified.Load() != 1 || cat.Snapshot() != snap {
		t.Fatalf("second sync: err %v, 304s %d", err, notModified.Load())
	}

	failing.Store(true)
	if err := s.Sync(ctx); err == nil {
		t.Fatal("server error not reported")
	}
	if cat.Snapshot() != snap {
		t.Fatal("failed sync replaced the snapshot")
	}
	if age := cat.Age(); age <= 0 || age > time.Minute {
		t.Fatalf("age = %v", age)
	}
}

func TestDeliveredAddsImpressionsSinceTheSnapshot(t *testing.T) {
	cat := New()
	c := &decision.Campaign{ID: "c1", DeliveredToday: 40}
	cat.Store(&Snapshot{Campaigns: []*decision.Campaign{c}})
	cat.RecordImpression("c1")
	cat.RecordImpression("c1")
	if got := cat.Delivered(c); got != 42 {
		t.Fatalf("delivered = %d", got)
	}
	fresh := &decision.Campaign{ID: "c1", DeliveredToday: 42}
	cat.Store(&Snapshot{Campaigns: []*decision.Campaign{fresh}})
	if got := cat.Delivered(fresh); got != 42 {
		t.Fatalf("after a new snapshot = %d", got)
	}
}

func TestRejectsCampaignsWithoutIDs(t *testing.T) {
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"campaigns":[{"name":"no id"}]}`)
	}))
	defer api.Close()
	cat := New()
	s := &Syncer{URL: api.URL, Client: api.Client(), Catalog: cat}
	if err := s.Sync(context.Background()); err == nil || cat.Snapshot() != nil {
		t.Fatalf("err %v, snapshot %v", err, cat.Snapshot())
	}
}
