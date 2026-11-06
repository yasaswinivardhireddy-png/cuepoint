package decision

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

// 12:00 UTC: half the day has passed, so an even line for a 1,000 goal is 500.
var noon = time.Date(2026, 11, 6, 12, 0, 0, 0, time.UTC)

func campaign(id string, mutate ...func(*Campaign)) *Campaign {
	c := &Campaign{
		ID:           id,
		AdvertiserID: "adv-" + id,
		Name:         "Campaign " + id,
		Category:     "category-" + id,
		StartDate:    "2026-11-01",
		EndDate:      "2026-11-30",
		DailyGoal:    1000,
		CPMCents:     1500,
		Creatives:    []Creative{{ID: id + "-30", DurationSec: 30}, {ID: id + "-15", DurationSec: 15}},
	}
	for _, m := range mutate {
		m(c)
	}
	return c
}

func request(mutate ...func(*Request)) Request {
	r := Request{PodDurationSec: 60, MaxAds: 4, Genre: "sports", Device: "ctv", Country: "IN", Now: noon, Explain: true}
	for _, m := range mutate {
		m(&r)
	}
	return r
}

func none(*Campaign) int64 { return 0 }

func decide(req Request, campaigns []*Campaign, freq map[string]int, delivered func(*Campaign) int64) Result {
	eligible, skipped := Filter(req, campaigns)
	res := Build(req, eligible, freq, delivered)
	res.Skipped = append(skipped, res.Skipped...)
	return res
}

func ids(res Result) string {
	out := make([]string, len(res.Placements))
	for i, p := range res.Placements {
		out[i] = p.Creative.ID
	}
	return strings.Join(out, ",")
}

func reason(res Result, id string) string {
	for _, s := range res.Skipped {
		if s.CampaignID == id {
			return s.Reason
		}
	}
	return ""
}

func TestTargetingAndFlightDates(t *testing.T) {
	campaigns := []*Campaign{
		campaign("open"),
		campaign("news-only", func(c *Campaign) { c.Targeting.Genres = []string{"news"} }),
		campaign("mobile-only", func(c *Campaign) { c.Targeting.Devices = []string{"mobile"} }),
		campaign("us-only", func(c *Campaign) { c.Targeting.Countries = []string{"US"} }),
		campaign("ctv-sports-in", func(c *Campaign) {
			c.Targeting = Targeting{Genres: []string{"Sports"}, Devices: []string{"ctv"}, Countries: []string{"in"}}
		}),
		campaign("ended", func(c *Campaign) { c.EndDate = "2026-11-05" }),
		campaign("future", func(c *Campaign) { c.StartDate = "2026-11-07" }),
	}
	res := decide(request(), campaigns, nil, none)

	if got := ids(res); got != "ctv-sports-in-30,open-30" {
		t.Fatalf("placements = %s", got)
	}
	for id, want := range map[string]string{
		"news-only":   `does not target the "sports" genre`,
		"mobile-only": `does not target "ctv" devices`,
		"us-only":     `does not target viewers in "IN"`,
		"ended":       "outside its flight dates (2026-11-01 to 2026-11-05)",
		"future":      "outside its flight dates (2026-11-07 to 2026-11-30)",
	} {
		if got := reason(res, id); got != want {
			t.Errorf("%s: reason %q, want %q", id, got, want)
		}
	}
}

func TestFillsTheBreakHighestPriceFirst(t *testing.T) {
	campaigns := []*Campaign{
		campaign("cheap", func(c *Campaign) { c.CPMCents = 900 }),
		campaign("premium", func(c *Campaign) { c.CPMCents = 4000 }),
		campaign("mid", func(c *Campaign) { c.CPMCents = 2200 }),
	}
	// 60 s: premium takes 30 s, mid takes 30 s, nothing is left for cheap.
	res := decide(request(), campaigns, nil, none)
	if got := ids(res); got != "premium-30,mid-30" || res.FilledSec != 60 {
		t.Fatalf("placements = %s, filled %d", got, res.FilledSec)
	}
	if got := reason(res, "cheap"); got != "the break is already full" {
		t.Errorf("cheap: %q", got)
	}

	// 45 s: after premium's 30 s, mid's 15 s version fills the rest.
	res = decide(request(func(r *Request) { r.PodDurationSec = 45 }), campaigns, nil, none)
	if got := ids(res); got != "premium-30,mid-15" {
		t.Fatalf("45 s break: %s", got)
	}

	// The ad limit applies even when time is left.
	res = decide(request(func(r *Request) { r.PodDurationSec = 120; r.MaxAds = 2 }), campaigns, nil, none)
	if got := ids(res); got != "premium-30,mid-30" {
		t.Fatalf("max 2 ads: %s", got)
	}
}

func TestCompetitiveSeparation(t *testing.T) {
	campaigns := []*Campaign{
		campaign("motors-a", func(c *Campaign) { c.Category = "auto"; c.CPMCents = 3000 }),
		campaign("motors-b", func(c *Campaign) { c.Category = "auto"; c.CPMCents = 2500 }),
		campaign("same-advertiser", func(c *Campaign) { c.AdvertiserID = "adv-motors-a"; c.Category = "finance"; c.CPMCents = 2000 }),
		campaign("cola", func(c *Campaign) { c.Category = "beverage"; c.CPMCents = 1000 }),
	}
	res := decide(request(func(r *Request) { r.PodDurationSec = 90 }), campaigns, nil, none)
	if got := ids(res); got != "motors-a-30,cola-30" {
		t.Fatalf("placements = %s", got)
	}
	if got := reason(res, "motors-b"); got != "competitive separation: another auto ad is in this break" {
		t.Errorf("motors-b: %q", got)
	}
	if got := reason(res, "same-advertiser"); got != "its advertiser already has an ad in this break" {
		t.Errorf("same-advertiser: %q", got)
	}
}

func TestFrequencyCap(t *testing.T) {
	capped := campaign("capped", func(c *Campaign) { c.FrequencyCapPerDay = 3; c.CPMCents = 5000 })
	backup := campaign("backup")
	res := decide(request(), []*Campaign{capped, backup}, map[string]int{"capped": 3}, none)
	if got := ids(res); got != "backup-30" {
		t.Fatalf("placements = %s", got)
	}
	if got := reason(res, "capped"); got != "frequency cap reached: this viewer saw it 3 of 3 times today" {
		t.Errorf("reason %q", got)
	}
	if got := ids(decide(request(), []*Campaign{capped, backup}, map[string]int{"capped": 2}, none)); got != "capped-30,backup-30" {
		t.Errorf("under the cap: %s", got)
	}
}

func TestPacing(t *testing.T) {
	// At noon a 1,000-impression goal allows 550 (500 plus 10% headroom).
	if got := Allowance(1000, noon); got != 550 {
		t.Fatalf("Allowance at noon = %d", got)
	}
	if got := Allowance(1000, time.Date(2026, 11, 6, 0, 1, 0, 0, time.UTC)); got != 20 {
		t.Fatalf("Allowance after midnight = %d, want the 2%% floor", got)
	}
	if got := Allowance(1000, time.Date(2026, 11, 6, 23, 59, 0, 0, time.UTC)); got != 1000 {
		t.Fatalf("Allowance before midnight = %d, want the goal", got)
	}

	ahead := campaign("ahead", func(c *Campaign) { c.CPMCents = 5000 })
	done := campaign("done", func(c *Campaign) { c.CPMCents = 5000; c.DailyGoal = 200 })
	onPace := campaign("on-pace")
	delivered := map[string]int64{"ahead": 550, "done": 200, "on-pace": 400}
	res := decide(request(), []*Campaign{ahead, done, onPace}, nil, func(c *Campaign) int64 { return delivered[c.ID] })
	if got := ids(res); got != "on-pace-30" {
		t.Fatalf("placements = %s", got)
	}
	if got := reason(res, "ahead"); got != "ahead of its daily pace: 550 delivered, 550 allowed by now" {
		t.Errorf("ahead: %q", got)
	}
	if got := reason(res, "done"); got != "daily goal of 200 impressions reached" {
		t.Errorf("done: %q", got)
	}
}

func TestEqualPricesFavorTheCampaignFurthestBehind(t *testing.T) {
	a := campaign("a", func(c *Campaign) { c.Category = "auto" })
	b := campaign("b", func(c *Campaign) { c.Category = "auto" })
	delivered := map[string]int64{"a": 450, "b": 100}
	res := decide(request(), []*Campaign{a, b}, nil, func(c *Campaign) int64 { return delivered[c.ID] })
	if got := ids(res); got != "b-30" {
		t.Fatalf("placements = %s", got)
	}
}

func TestNoCreativeFitsAndExplainOff(t *testing.T) {
	long := campaign("long", func(c *Campaign) { c.Creatives = []Creative{{ID: "long-60", DurationSec: 60}} })
	res := decide(request(func(r *Request) { r.PodDurationSec = 30 }), []*Campaign{long}, nil, none)
	if len(res.Placements) != 0 || reason(res, "long") != "no creative fits the remaining 30 s" {
		t.Fatalf("got %+v", res)
	}
	res = decide(request(func(r *Request) { r.PodDurationSec = 30; r.Explain = false }), []*Campaign{long}, nil, none)
	if res.Skipped != nil {
		t.Fatalf("reasons collected with Explain off: %+v", res.Skipped)
	}
}

func BenchmarkDecide500Campaigns(b *testing.B) {
	genres := []string{"sports", "news", "drama", "kids", "comedy"}
	devices := []string{"ctv", "mobile", "web"}
	campaigns := make([]*Campaign, 500)
	for i := range campaigns {
		campaigns[i] = campaign(fmt.Sprintf("c%03d", i), func(c *Campaign) {
			c.Category = fmt.Sprintf("cat-%d", i%20)
			c.CPMCents = int64(500 + (i*37)%4000)
			c.FrequencyCapPerDay = 3
			c.Targeting.Genres = []string{genres[i%len(genres)], genres[(i+1)%len(genres)]}
			c.Targeting.Devices = []string{devices[i%len(devices)]}
		})
	}
	req := request(func(r *Request) { r.Explain = false; r.PodDurationSec = 120 })
	freq := map[string]int{"c010": 3, "c020": 1}
	b.ReportAllocs()
	for b.Loop() {
		eligible, _ := Filter(req, campaigns)
		res := Build(req, eligible, freq, none)
		if len(res.Placements) == 0 {
			b.Fatal("empty break")
		}
	}
}
