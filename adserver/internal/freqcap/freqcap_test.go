package freqcap

import (
	"context"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

func stores(t *testing.T) map[string]Store {
	srv := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: srv.Addr()})
	t.Cleanup(func() { _ = client.Close() })
	return map[string]Store{"memory": NewMemory(), "redis": NewRedis(client)}
}

func TestCountsAndReplays(t *testing.T) {
	ctx := context.Background()
	for name, s := range stores(t) {
		t.Run(name, func(t *testing.T) {
			for i, event := range []string{"e1", "e2", "e2", "e3"} {
				fresh, err := s.Record(ctx, "viewer-a", "2026-11-06", "cmp-1", event)
				if err != nil {
					t.Fatal(err)
				}
				if want := i != 2; fresh != want {
					t.Fatalf("event %s: fresh = %v, want %v", event, fresh, want)
				}
			}
			if _, err := s.Record(ctx, "viewer-b", "2026-11-06", "cmp-1", "e4"); err != nil {
				t.Fatal(err)
			}
			if _, err := s.Record(ctx, "viewer-a", "2026-11-07", "cmp-1", "e5"); err != nil {
				t.Fatal(err)
			}

			got, err := s.Counts(ctx, "viewer-a", "2026-11-06", []string{"cmp-1", "cmp-2"})
			if err != nil {
				t.Fatal(err)
			}
			if len(got) != 1 || got["cmp-1"] != 3 {
				t.Fatalf("counts = %v, want cmp-1: 3 (the replayed e2 counted once)", got)
			}
			if got, _ := s.Counts(ctx, "viewer-a", "2026-11-07", []string{"cmp-1"}); got["cmp-1"] != 1 {
				t.Fatalf("next day counts = %v", got)
			}
			if got, _ := s.Counts(ctx, "viewer-a", "2026-11-06", nil); len(got) != 0 {
				t.Fatalf("no campaigns: %v", got)
			}
		})
	}
}

func TestRedisKeysExpire(t *testing.T) {
	srv := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: srv.Addr()})
	defer client.Close()
	s := NewRedis(client)
	if _, err := s.Record(context.Background(), "v", "2026-11-06", "c", "e"); err != nil {
		t.Fatal(err)
	}
	if ttl := srv.TTL(countKey("2026-11-06", "v", "c")); ttl != 48*time.Hour {
		t.Fatalf("ttl = %v", ttl)
	}
	srv.FastForward(49 * time.Hour)
	if got, _ := s.Counts(context.Background(), "v", "2026-11-06", []string{"c"}); len(got) != 0 {
		t.Fatalf("counts after expiry = %v", got)
	}
}

func TestMemoryDropsOldDays(t *testing.T) {
	m := NewMemory()
	ctx := context.Background()
	for _, day := range []string{"2026-11-04", "2026-11-05", "2026-11-06"} {
		if _, err := m.Record(ctx, "v", day, "c", day); err != nil {
			t.Fatal(err)
		}
	}
	if len(m.days) != 2 {
		t.Fatalf("kept %d days, want today and yesterday", len(m.days))
	}
}
