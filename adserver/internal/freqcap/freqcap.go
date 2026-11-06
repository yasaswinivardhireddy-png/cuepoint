// Package freqcap counts how often each viewer saw each campaign today, so an advertiser's
// frequency cap ("at most 3 times per day") holds across ad breaks.
package freqcap

import (
	"context"
	"strconv"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

// Store keeps per-day counts; viewer is a salted hash, never a raw device ID.
type Store interface {
	// Counts returns this viewer's impressions today for each campaign that has any.
	Counts(ctx context.Context, viewer, day string, campaignIDs []string) (map[string]int, error)
	// Record counts one impression, unless eventID was already recorded (a replayed beacon).
	// It reports whether the impression was new.
	Record(ctx context.Context, viewer, day, campaignID, eventID string) (bool, error)
}

// Memory is a single-process Store for local runs and tests. Replicas do not share it.
type Memory struct {
	mu   sync.Mutex
	days map[string]*memoryDay
}

type memoryDay struct {
	counts map[string]int // viewer + "|" + campaign
	events map[string]bool
}

func NewMemory() *Memory {
	return &Memory{days: map[string]*memoryDay{}}
}

func (m *Memory) Counts(_ context.Context, viewer, day string, campaignIDs []string) (map[string]int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := map[string]int{}
	if d := m.days[day]; d != nil {
		for _, id := range campaignIDs {
			if n := d.counts[viewer+"|"+id]; n > 0 {
				out[id] = n
			}
		}
	}
	return out, nil
}

func (m *Memory) Record(_ context.Context, viewer, day, campaignID, eventID string) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	d := m.days[day]
	if d == nil {
		// A new day starts: keep only the previous one, for beacons that arrive after midnight.
		for k := range m.days {
			if k < previousDay(day) {
				delete(m.days, k)
			}
		}
		d = &memoryDay{counts: map[string]int{}, events: map[string]bool{}}
		m.days[day] = d
	}
	if d.events[eventID] {
		return false, nil
	}
	d.events[eventID] = true
	d.counts[viewer+"|"+campaignID]++
	return true, nil
}

func previousDay(day string) string {
	t, err := time.Parse(time.DateOnly, day)
	if err != nil {
		return day
	}
	return t.AddDate(0, 0, -1).Format(time.DateOnly)
}

// Redis shares counts across ad server replicas. Keys expire two days after their last write.
type Redis struct {
	Client redis.UniversalClient
	TTL    time.Duration
}

func NewRedis(client redis.UniversalClient) *Redis {
	return &Redis{Client: client, TTL: 48 * time.Hour}
}

func countKey(day, viewer, campaignID string) string {
	return "fc:" + day + ":" + viewer + ":" + campaignID
}

// Counts reads every candidate campaign's count in one round trip.
func (r *Redis) Counts(ctx context.Context, viewer, day string, campaignIDs []string) (map[string]int, error) {
	if len(campaignIDs) == 0 {
		return map[string]int{}, nil
	}
	keys := make([]string, len(campaignIDs))
	for i, id := range campaignIDs {
		keys[i] = countKey(day, viewer, id)
	}
	values, err := r.Client.MGet(ctx, keys...).Result()
	if err != nil {
		return nil, err
	}
	out := map[string]int{}
	for i, v := range values {
		if s, ok := v.(string); ok {
			if n, err := strconv.Atoi(s); err == nil && n > 0 {
				out[campaignIDs[i]] = n
			}
		}
	}
	return out, nil
}

// Record uses SET NX on the event ID so a replayed beacon is not counted twice.
func (r *Redis) Record(ctx context.Context, viewer, day, campaignID, eventID string) (bool, error) {
	fresh, err := r.Client.SetNX(ctx, "fcev:"+eventID, 1, r.TTL).Result()
	if err != nil || !fresh {
		return false, err
	}
	key := countKey(day, viewer, campaignID)
	pipe := r.Client.TxPipeline()
	pipe.Incr(ctx, key)
	pipe.Expire(ctx, key, r.TTL)
	if _, err := pipe.Exec(ctx); err != nil {
		return false, err
	}
	return true, nil
}
