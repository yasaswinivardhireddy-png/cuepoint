package events

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
	"github.com/aws/aws-sdk-go-v2/service/sqs/types"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"
)

type recorder struct {
	mu       sync.Mutex
	batches  [][]Event
	failures int // fail this many calls first
}

func (r *recorder) Send(_ context.Context, batch []Event) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.failures > 0 {
		r.failures--
		return errors.New("throttled")
	}
	r.batches = append(r.batches, append([]Event(nil), batch...))
	return nil
}

func (r *recorder) count() (events, batches int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, b := range r.batches {
		events += len(b)
	}
	return events, len(r.batches)
}

var quiet = slog.New(slog.NewTextHandler(io.Discard, nil))

func event(i int) Event {
	return Event{ID: "e" + strconv.Itoa(i), Type: "impression", CampaignID: "c", Time: time.Unix(1_780_000_000, 0)}
}

func TestBatchesAndFlushesOnShutdown(t *testing.T) {
	rec := &recorder{failures: 1}
	m := NewMetrics(prometheus.NewRegistry())
	p := NewPublisher(rec, Options{Workers: 1, Linger: time.Hour}, m, quiet)
	ctx, cancel := context.WithCancel(context.Background())
	go p.Run(ctx)
	for i := range 25 {
		if !p.Publish(event(i)) {
			t.Fatal("publish refused with room in the buffer")
		}
	}
	// Two full batches go out at once (the first after one retry); the last 5 wait for the linger
	// timer, which shutdown cuts short.
	deadline := time.Now().Add(5 * time.Second)
	for n, _ := rec.count(); n < 20 && time.Now().Before(deadline); n, _ = rec.count() {
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	<-p.Done()
	if events, batches := rec.count(); events != 25 || batches != 3 {
		t.Fatalf("sent %d events in %d batches", events, batches)
	}
	if got := testutil.ToFloat64(m.Published); got != 25 {
		t.Fatalf("published metric = %v", got)
	}
}

func TestDropsWhenTheBufferIsFull(t *testing.T) {
	m := NewMetrics(prometheus.NewRegistry())
	p := NewPublisher(&recorder{}, Options{Buffer: 2}, m, quiet)
	accepted := 0
	for i := range 5 {
		if p.Publish(event(i)) {
			accepted++
		}
	}
	if accepted != 2 || testutil.ToFloat64(m.Dropped) != 3 {
		t.Fatalf("accepted %d, dropped %v", accepted, testutil.ToFloat64(m.Dropped))
	}
}

func TestGivesUpAfterRetries(t *testing.T) {
	m := NewMetrics(prometheus.NewRegistry())
	p := NewPublisher(&recorder{failures: 99}, Options{Workers: 1, Linger: time.Millisecond, Retries: 2}, m, quiet)
	ctx, cancel := context.WithCancel(context.Background())
	go p.Run(ctx)
	p.Publish(event(1))
	deadline := time.Now().Add(5 * time.Second)
	for testutil.ToFloat64(m.Failed) == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	<-p.Done()
	if got := testutil.ToFloat64(m.Failed); got != 1 {
		t.Fatalf("failed metric = %v", got)
	}
}

type fakeSQS struct {
	in     *sqs.SendMessageBatchInput
	failed int
}

func (f *fakeSQS) SendMessageBatch(_ context.Context, in *sqs.SendMessageBatchInput, _ ...func(*sqs.Options)) (*sqs.SendMessageBatchOutput, error) {
	f.in = in
	out := &sqs.SendMessageBatchOutput{}
	for i := range f.failed {
		out.Failed = append(out.Failed, types.BatchResultErrorEntry{Id: aws.String(strconv.Itoa(i)), Message: aws.String("throttled")})
	}
	return out, nil
}

func TestSQSSenderEncodesOneMessagePerEvent(t *testing.T) {
	api := &fakeSQS{}
	s := SQSSender{Client: api, QueueURL: "http://localhost:5000/123456789012/events"}
	if err := s.Send(context.Background(), []Event{event(1), event(2)}); err != nil {
		t.Fatal(err)
	}
	if aws.ToString(api.in.QueueUrl) != s.QueueURL || len(api.in.Entries) != 2 {
		t.Fatalf("input %+v", api.in)
	}
	var decoded Event
	if err := json.Unmarshal([]byte(aws.ToString(api.in.Entries[1].MessageBody)), &decoded); err != nil || decoded.ID != "e2" || aws.ToString(api.in.Entries[1].Id) != "1" {
		t.Fatalf("entry 1: %+v, %v", decoded, err)
	}

	api.failed = 1
	if err := s.Send(context.Background(), []Event{event(3)}); err == nil {
		t.Fatal("partial failure not reported")
	}
}
