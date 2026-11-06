// Package vast renders an ad pod as an IAB VAST 4.2 document, the XML that video players use to
// fetch and track ads.
package vast

import (
	"encoding/xml"
	"fmt"
)

const namespace = "http://www.iab.com/VAST"

// Ad is one linear video ad of the pod, in play order.
type Ad struct {
	Sequence      int
	AdServingID   string
	CampaignID    string
	Title         string
	Advertiser    string
	CreativeID    string
	DurationSec   int
	MediaURL      string
	MimeType      string
	Width, Height int
	ImpressionURL string
}

type document struct {
	XMLName xml.Name `xml:"VAST"`
	Version string   `xml:"version,attr"`
	Xmlns   string   `xml:"xmlns,attr"`
	Ads     []ad     `xml:"Ad"`
}

type ad struct {
	ID       string `xml:"id,attr"`
	Sequence int    `xml:"sequence,attr"`
	InLine   inLine `xml:"InLine"`
}

// Element order follows the VAST 4.2 schema.
type inLine struct {
	AdSystem    adSystem   `xml:"AdSystem"`
	Impression  impression `xml:"Impression"`
	AdServingID string     `xml:"AdServingId"`
	AdTitle     string     `xml:"AdTitle"`
	Advertiser  string     `xml:"Advertiser,omitempty"`
	Creatives   []creative `xml:"Creatives>Creative"`
}

type adSystem struct {
	Version string `xml:"version,attr"`
	Name    string `xml:",chardata"`
}

type impression struct {
	ID  string `xml:"id,attr"`
	URL string `xml:",cdata"`
}

type creative struct {
	ID            string        `xml:"id,attr"`
	AdID          string        `xml:"adId,attr"`
	Sequence      int           `xml:"sequence,attr"`
	UniversalAdID universalAdID `xml:"UniversalAdId"`
	Linear        linear        `xml:"Linear"`
}

type universalAdID struct {
	IDRegistry string `xml:"idRegistry,attr"`
	ID         string `xml:",chardata"`
}

type linear struct {
	Duration   string      `xml:"Duration"`
	MediaFiles []mediaFile `xml:"MediaFiles>MediaFile"`
}

type mediaFile struct {
	Delivery string `xml:"delivery,attr"`
	Type     string `xml:"type,attr"`
	Width    int    `xml:"width,attr"`
	Height   int    `xml:"height,attr"`
	URL      string `xml:",cdata"`
}

// Pod renders the ads as one VAST document. No ads gives an empty <VAST>, the standard no-fill answer.
func Pod(ads []Ad) ([]byte, error) {
	doc := document{Version: "4.2", Xmlns: namespace, Ads: make([]ad, 0, len(ads))}
	for _, a := range ads {
		doc.Ads = append(doc.Ads, ad{
			ID:       a.CampaignID,
			Sequence: a.Sequence,
			InLine: inLine{
				AdSystem:    adSystem{Version: "1.0", Name: "Cuepoint"},
				Impression:  impression{ID: a.AdServingID, URL: a.ImpressionURL},
				AdServingID: a.AdServingID,
				AdTitle:     a.Title,
				Advertiser:  a.Advertiser,
				Creatives: []creative{{
					ID:            a.CreativeID,
					AdID:          a.CampaignID,
					Sequence:      1,
					UniversalAdID: universalAdID{IDRegistry: "cuepoint", ID: a.CreativeID},
					Linear: linear{
						Duration: Duration(a.DurationSec),
						MediaFiles: []mediaFile{{
							Delivery: "progressive",
							Type:     a.MimeType,
							Width:    a.Width,
							Height:   a.Height,
							URL:      a.MediaURL,
						}},
					},
				}},
			},
		})
	}
	body, err := xml.MarshalIndent(doc, "", "  ")
	if err != nil {
		return nil, err
	}
	return append([]byte(xml.Header), body...), nil
}

// Duration formats seconds as VAST's HH:MM:SS.
func Duration(sec int) string {
	return fmt.Sprintf("%02d:%02d:%02d", sec/3600, sec/60%60, sec%60)
}
