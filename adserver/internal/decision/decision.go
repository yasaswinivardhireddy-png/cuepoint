// Package decision chooses the ads for one ad break (a "pod") in a video stream.
//
// It does no I/O: callers pass the campaign snapshot, the viewer's frequency counts and the
// delivery numbers, so every rule is testable on its own.
package decision

import (
	"cmp"
	"fmt"
	"slices"
	"strings"
	"time"
)

// Campaign mirrors the campaign API's snapshot format.
type Campaign struct {
	ID                 string     `json:"id"`
	AdvertiserID       string     `json:"advertiserId"`
	Name               string     `json:"name"`
	Category           string     `json:"category"`
	StartDate          string     `json:"startDate"` // YYYY-MM-DD in UTC, inclusive
	EndDate            string     `json:"endDate"`
	DailyGoal          int64      `json:"dailyImpressionGoal"`
	CPMCents           int64      `json:"cpmCents"`
	FrequencyCapPerDay int        `json:"frequencyCapPerDay"` // 0 means no cap
	Targeting          Targeting  `json:"targeting"`
	Creatives          []Creative `json:"creatives"`
	DeliveredToday     int64      `json:"deliveredToday"`
}

// Targeting lists the allowed values per dimension; an empty list allows any value.
type Targeting struct {
	Genres    []string `json:"genres"`
	Devices   []string `json:"devices"`
	Countries []string `json:"countries"`
}

type Creative struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	DurationSec int    `json:"durationSec"`
	MediaURL    string `json:"mediaUrl"`
	MimeType    string `json:"mimeType"`
	Width       int    `json:"width"`
	Height      int    `json:"height"`
}

// Request describes one ad break.
type Request struct {
	PodDurationSec int
	MaxAds         int
	Genre          string
	Device         string
	Country        string
	Now            time.Time
	// Explain collects the reason every campaign was skipped. It allocates, so it is off on the hot path.
	Explain bool
}

type Placement struct {
	Campaign *Campaign
	Creative Creative
}

type Skip struct {
	CampaignID   string `json:"campaignId"`
	CampaignName string `json:"campaignName"`
	Reason       string `json:"reason"`
}

type Result struct {
	Placements []Placement
	FilledSec  int
	Skipped    []Skip
}

// Pacing spreads a daily goal evenly over the UTC day. A campaign may run up to 10% ahead of the
// even line, and may always deliver 2% of its goal so it can start right after midnight.
const (
	paceHeadroom = 1.10
	paceFloor    = 0.02
)

// Day returns the UTC day used for daily goals and frequency caps.
func Day(t time.Time) string {
	return t.UTC().Format(time.DateOnly)
}

// Allowance is the most impressions a campaign should have delivered by now to stay on pace.
func Allowance(goal int64, now time.Time) int64 {
	if goal <= 0 {
		return 0
	}
	// Truncation keeps floating-point noise (500 x 1.1 = 550.0000000000001) from allowing an extra impression.
	allowed := int64(float64(goal) * dayFraction(now) * paceHeadroom)
	floor := max(int64(float64(goal)*paceFloor), 1)
	return min(max(allowed, floor), goal)
}

func dayFraction(now time.Time) float64 {
	now = now.UTC()
	y, m, d := now.Date()
	return now.Sub(time.Date(y, m, d, 0, 0, 0, 0, time.UTC)).Seconds() / 86400
}

// Filter keeps the campaigns whose flight dates and targeting match the request.
func Filter(req Request, campaigns []*Campaign) ([]*Campaign, []Skip) {
	today := Day(req.Now)
	eligible := make([]*Campaign, 0, len(campaigns))
	var skipped []Skip
	for _, c := range campaigns {
		if m := mismatch(req, today, c); m == matched {
			eligible = append(eligible, c)
		} else if req.Explain {
			skipped = append(skipped, Skip{c.ID, c.Name, m.describe(req, c)})
		}
	}
	return eligible, skipped
}

// A filterResult names the first rule a campaign fails. Text is built only when explaining, so
// the hot path does not allocate for skipped campaigns.
type filterResult int

const (
	matched filterResult = iota
	outsideFlight
	genreNotTargeted
	deviceNotTargeted
	countryNotTargeted
)

func mismatch(req Request, today string, c *Campaign) filterResult {
	switch {
	case today < c.StartDate || today > c.EndDate:
		return outsideFlight
	case !allows(c.Targeting.Genres, req.Genre):
		return genreNotTargeted
	case !allows(c.Targeting.Devices, req.Device):
		return deviceNotTargeted
	case !allows(c.Targeting.Countries, req.Country):
		return countryNotTargeted
	}
	return matched
}

func (m filterResult) describe(req Request, c *Campaign) string {
	switch m {
	case outsideFlight:
		return fmt.Sprintf("outside its flight dates (%s to %s)", c.StartDate, c.EndDate)
	case genreNotTargeted:
		return fmt.Sprintf("does not target the %q genre", req.Genre)
	case deviceNotTargeted:
		return fmt.Sprintf("does not target %q devices", req.Device)
	case countryNotTargeted:
		return fmt.Sprintf("does not target viewers in %q", req.Country)
	}
	return ""
}

func allows(allowed []string, value string) bool {
	if len(allowed) == 0 {
		return true
	}
	for _, a := range allowed {
		if strings.EqualFold(a, value) {
			return true
		}
	}
	return false
}

// Build fills the break from eligible campaigns, highest CPM first. frequency holds this viewer's
// impressions per campaign today; delivered returns a campaign's impressions today across viewers.
func Build(req Request, eligible []*Campaign, frequency map[string]int, delivered func(*Campaign) int64) Result {
	now := req.Now.UTC()
	frac := dayFraction(now)

	type candidate struct {
		c         *Campaign
		delivered int64
		behind    float64 // share of the daily goal the campaign is behind the even line
	}
	candidates := make([]candidate, 0, len(eligible))
	for _, c := range eligible {
		d := delivered(c)
		behind := 0.0
		if c.DailyGoal > 0 {
			behind = (float64(c.DailyGoal)*frac - float64(d)) / float64(c.DailyGoal)
		}
		candidates = append(candidates, candidate{c, d, behind})
	}
	// Higher price first; among equal prices, the campaign furthest behind its pace.
	slices.SortFunc(candidates, func(a, b candidate) int {
		if n := cmp.Compare(b.c.CPMCents, a.c.CPMCents); n != 0 {
			return n
		}
		if n := cmp.Compare(b.behind, a.behind); n != 0 {
			return n
		}
		return strings.Compare(a.c.ID, b.c.ID)
	})

	var res Result
	explain := func(c *Campaign, reason string) {
		res.Skipped = append(res.Skipped, Skip{c.ID, c.Name, reason})
	}
	remaining := req.PodDurationSec
	advertisers := make(map[string]bool, req.MaxAds)
	categories := make(map[string]bool, req.MaxAds)
	// Each rule formats its reason only when explaining, keeping the hot path allocation-free.
	for _, k := range candidates {
		c := k.c
		if len(res.Placements) >= req.MaxAds || remaining <= 0 {
			if req.Explain {
				explain(c, "the break is already full")
			}
			continue
		}
		if seen := frequency[c.ID]; c.FrequencyCapPerDay > 0 && seen >= c.FrequencyCapPerDay {
			if req.Explain {
				explain(c, fmt.Sprintf("frequency cap reached: this viewer saw it %d of %d times today", seen, c.FrequencyCapPerDay))
			}
			continue
		}
		if c.DailyGoal > 0 && k.delivered >= c.DailyGoal {
			if req.Explain {
				explain(c, fmt.Sprintf("daily goal of %d impressions reached", c.DailyGoal))
			}
			continue
		}
		if allowed := Allowance(c.DailyGoal, now); c.DailyGoal > 0 && k.delivered >= allowed {
			if req.Explain {
				explain(c, fmt.Sprintf("ahead of its daily pace: %d delivered, %d allowed by now", k.delivered, allowed))
			}
			continue
		}
		if advertisers[c.AdvertiserID] {
			if req.Explain {
				explain(c, "its advertiser already has an ad in this break")
			}
			continue
		}
		if c.Category != "" && categories[c.Category] {
			if req.Explain {
				explain(c, fmt.Sprintf("competitive separation: another %s ad is in this break", c.Category))
			}
			continue
		}
		creative, ok := longestFitting(c.Creatives, remaining)
		if !ok {
			if req.Explain {
				explain(c, fmt.Sprintf("no creative fits the remaining %d s", remaining))
			}
			continue
		}
		res.Placements = append(res.Placements, Placement{Campaign: c, Creative: creative})
		res.FilledSec += creative.DurationSec
		remaining -= creative.DurationSec
		advertisers[c.AdvertiserID] = true
		if c.Category != "" {
			categories[c.Category] = true
		}
	}
	return res
}

func longestFitting(creatives []Creative, remaining int) (Creative, bool) {
	best, found := Creative{}, false
	for _, cr := range creatives {
		if cr.DurationSec > 0 && cr.DurationSec <= remaining && (!found || cr.DurationSec > best.DurationSec) {
			best, found = cr, true
		}
	}
	return best, found
}
