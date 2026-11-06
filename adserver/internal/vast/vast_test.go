package vast

import (
	"encoding/xml"
	"strings"
	"testing"
)

func TestPodRendersSequencedLinearAds(t *testing.T) {
	body, err := Pod([]Ad{
		{Sequence: 1, AdServingID: "dec-1-1", CampaignID: "cmp-a", Title: "Winter Drive", Advertiser: "Acme Motors", CreativeID: "cr-a", DurationSec: 30, MediaURL: "https://cdn.example/a.mp4?x=1&y=2", MimeType: "video/mp4", Width: 1920, Height: 1080, ImpressionURL: "https://ads.example/v1/events?d=1&sig=a"},
		{Sequence: 2, AdServingID: "dec-1-2", CampaignID: "cmp-b", Title: "Summer Cola", CreativeID: "cr-b", DurationSec: 15, MediaURL: "https://cdn.example/b.mp4", MimeType: "video/mp4", Width: 1280, Height: 720, ImpressionURL: "https://ads.example/v1/events?d=2"},
	})
	if err != nil {
		t.Fatal(err)
	}
	text := string(body)
	for _, want := range []string{
		`<?xml version="1.0" encoding="UTF-8"?>`,
		`<VAST version="4.2" xmlns="http://www.iab.com/VAST">`,
		`<Ad id="cmp-a" sequence="1">`,
		`<Impression id="dec-1-1"><![CDATA[https://ads.example/v1/events?d=1&sig=a]]></Impression>`,
		`<Duration>00:00:30</Duration>`,
		`<MediaFile delivery="progressive" type="video/mp4" width="1920" height="1080"><![CDATA[https://cdn.example/a.mp4?x=1&y=2]]></MediaFile>`,
		`<UniversalAdId idRegistry="cuepoint">cr-b</UniversalAdId>`,
		`<Duration>00:00:15</Duration>`,
	} {
		if !strings.Contains(text, want) {
			t.Errorf("missing %s in\n%s", want, text)
		}
	}
	if strings.Contains(text, "<Advertiser></Advertiser>") {
		t.Error("empty Advertiser element rendered")
	}

	// A player-side parser reads back the same structure.
	var parsed struct {
		Ads []struct {
			Sequence  int    `xml:"sequence,attr"`
			Duration  string `xml:"InLine>Creatives>Creative>Linear>Duration"`
			MediaFile string `xml:"InLine>Creatives>Creative>Linear>MediaFiles>MediaFile"`
		} `xml:"Ad"`
	}
	if err := xml.Unmarshal(body, &parsed); err != nil {
		t.Fatal(err)
	}
	if len(parsed.Ads) != 2 || parsed.Ads[1].Sequence != 2 || parsed.Ads[0].MediaFile != "https://cdn.example/a.mp4?x=1&y=2" {
		t.Fatalf("parsed %+v", parsed)
	}
}

func TestEmptyPodIsANoFillResponse(t *testing.T) {
	body, err := Pod(nil)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(string(body), `<VAST version="4.2" xmlns="http://www.iab.com/VAST"></VAST>`) {
		t.Fatalf("got %s", body)
	}
}

func TestDuration(t *testing.T) {
	for sec, want := range map[int]string{6: "00:00:06", 30: "00:00:30", 75: "00:01:15", 3725: "01:02:05"} {
		if got := Duration(sec); got != want {
			t.Errorf("Duration(%d) = %s, want %s", sec, got, want)
		}
	}
}
