// Package catalog keeps the ad server's copy of the active campaigns. A Syncer polls the campaign
// API with If-None-Match, so an unchanged catalog costs a 304. Requests read the current snapshot
// without locks; a failed sync keeps serving the last good one.
package catalog

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/yasaswinivardhireddy-png/cuepoint/adserver/internal/decision"
)

type Snapshot struct {
	ETag      string
	Campaigns []*decision.Campaign
}

// Catalog holds the snapshot plus impressions this replica tracked since it was loaded, which the
// delivery pipeline has not counted yet. Together they approximate delivery for pacing.
type Catalog struct {
	current  atomic.Pointer[Snapshot]
	synced   atomic.Int64 // unix nanos of the last successful sync (200 or 304)
	mu       sync.Mutex
	recorded map[string]*atomic.Int64
}

func New() *Catalog {
	return &Catalog{recorded: map[string]*atomic.Int64{}}
}

// Snapshot returns nil until the first successful sync.
func (c *Catalog) Snapshot() *Snapshot { return c.current.Load() }

func (c *Catalog) Store(s *Snapshot) {
	c.mu.Lock()
	c.recorded = map[string]*atomic.Int64{} // the new snapshot's delivery includes them, give or take pipeline lag
	c.mu.Unlock()
	c.current.Store(s)
	c.touch()
}

func (c *Catalog) touch() { c.synced.Store(time.Now().UnixNano()) }

// Age is the time since the last successful sync.
func (c *Catalog) Age() time.Duration {
	if t := c.synced.Load(); t != 0 {
		return time.Since(time.Unix(0, t))
	}
	return 0
}

func (c *Catalog) RecordImpression(campaignID string) {
	c.mu.Lock()
	n := c.recorded[campaignID]
	if n == nil {
		n = &atomic.Int64{}
		c.recorded[campaignID] = n
	}
	c.mu.Unlock()
	n.Add(1)
}

// Delivered estimates a campaign's impressions today.
func (c *Catalog) Delivered(campaign *decision.Campaign) int64 {
	c.mu.Lock()
	n := c.recorded[campaign.ID]
	c.mu.Unlock()
	if n == nil {
		return campaign.DeliveredToday
	}
	return campaign.DeliveredToday + n.Load()
}

type Syncer struct {
	URL      string
	Token    string
	Interval time.Duration
	Client   *http.Client
	Catalog  *Catalog
	Log      *slog.Logger
	Errors   prometheus.Counter
}

const maxSnapshotBytes = 32 << 20

// Sync fetches the snapshot once.
func (s *Syncer) Sync(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.URL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+s.Token)
	req.Header.Set("Accept", "application/json")
	if cur := s.Catalog.Snapshot(); cur != nil && cur.ETag != "" {
		req.Header.Set("If-None-Match", cur.ETag)
	}
	resp, err := s.Client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusNotModified:
		s.Catalog.touch()
		return nil
	case http.StatusOK:
		var body struct {
			Campaigns []*decision.Campaign `json:"campaigns"`
		}
		if err := json.NewDecoder(io.LimitReader(resp.Body, maxSnapshotBytes)).Decode(&body); err != nil {
			return fmt.Errorf("decoding campaigns: %w", err)
		}
		for i, c := range body.Campaigns {
			if c == nil || c.ID == "" {
				return fmt.Errorf("campaign %d has no id", i)
			}
		}
		s.Catalog.Store(&Snapshot{ETag: resp.Header.Get("ETag"), Campaigns: body.Campaigns})
		return nil
	default:
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("campaign API returned %s", resp.Status)
	}
}

// Run syncs immediately, then every Interval (with jitter), until ctx is canceled.
func (s *Syncer) Run(ctx context.Context) {
	for {
		if err := s.Sync(ctx); err != nil && ctx.Err() == nil {
			s.Errors.Inc()
			s.Log.Warn("campaign sync failed; serving the last snapshot", "error", err, "age", s.Catalog.Age().Round(time.Second))
		}
		wait := s.Interval + time.Duration(rand.Int64N(int64(s.Interval)/5+1))
		if s.Catalog.Snapshot() == nil {
			wait = 500 * time.Millisecond // not ready yet: retry quickly
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
	}
}
