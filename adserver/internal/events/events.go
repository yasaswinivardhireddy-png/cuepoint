// Package events ships impression events from the ad server to the delivery pipeline.
//
// Handlers never wait on the network: Publish only enqueues. Background workers send batches of up
// to 10 events (the SQS batch limit), retry failures, and count what they had to drop. Delivery is
// at least once; the consumer deduplicates by event ID.
package events

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strconv"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
	"github.com/aws/aws-sdk-go-v2/service/sqs/types"
	"github.com/prometheus/client_golang/prometheus"
)

type Event struct {
	ID         string    `json:"eventId"`
	Type       string    `json:"type"`
	DecisionID string    `json:"decisionId"`
	CampaignID string    `json:"campaignId"`
	CreativeID string    `json:"creativeId"`
	Viewer     string    `json:"viewer,omitempty"`
	Time       time.Time `json:"timestamp"`
}

// Sender delivers one batch.
type Sender interface {
	Send(ctx context.Context, batch []Event) error
}

// SQSAPI is the part of the SQS client the sender uses.
type SQSAPI interface {
	SendMessageBatch(ctx context.Context, in *sqs.SendMessageBatchInput, opts ...func(*sqs.Options)) (*sqs.SendMessageBatchOutput, error)
}

type SQSSender struct {
	Client   SQSAPI
	QueueURL string
}

func (s SQSSender) Send(ctx context.Context, batch []Event) error {
	entries := make([]types.SendMessageBatchRequestEntry, len(batch))
	for i, e := range batch {
		body, err := json.Marshal(e)
		if err != nil {
			return err
		}
		entries[i] = types.SendMessageBatchRequestEntry{Id: aws.String(strconv.Itoa(i)), MessageBody: aws.String(string(body))}
	}
	out, err := s.Client.SendMessageBatch(ctx, &sqs.SendMessageBatchInput{QueueUrl: aws.String(s.QueueURL), Entries: entries})
	if err != nil {
		return err
	}
	if len(out.Failed) > 0 {
		// Resending the whole batch is safe: the consumer ignores events it already counted.
		return fmt.Errorf("%d of %d messages failed, first: %s", len(out.Failed), len(batch), aws.ToString(out.Failed[0].Message))
	}
	return nil
}

// LogSender writes events to the log, for running without a queue.
type LogSender struct{ Log *slog.Logger }

func (s LogSender) Send(_ context.Context, batch []Event) error {
	for _, e := range batch {
		s.Log.Debug("ad event", "type", e.Type, "campaign", e.CampaignID, "event", e.ID)
	}
	return nil
}

type Metrics struct {
	Published prometheus.Counter
	Dropped   prometheus.Counter // the buffer was full
	Failed    prometheus.Counter // sending failed after retries
}

func NewMetrics(reg prometheus.Registerer) Metrics {
	m := Metrics{
		Published: prometheus.NewCounter(prometheus.CounterOpts{Name: "adserver_events_published_total", Help: "Events sent to the queue."}),
		Dropped:   prometheus.NewCounter(prometheus.CounterOpts{Name: "adserver_events_dropped_total", Help: "Events dropped because the buffer was full."}),
		Failed:    prometheus.NewCounter(prometheus.CounterOpts{Name: "adserver_events_failed_total", Help: "Events not sent after retries."}),
	}
	reg.MustRegister(m.Published, m.Dropped, m.Failed)
	return m
}

type Options struct {
	Buffer   int           // events held before Publish starts dropping
	Workers  int           // concurrent senders
	MaxBatch int           // at most 10 for SQS
	Linger   time.Duration // how long a partial batch waits for more events
	Retries  int
}

type Publisher struct {
	sender  Sender
	opts    Options
	metrics Metrics
	log     *slog.Logger
	queue   chan Event
	done    chan struct{}
}

func NewPublisher(sender Sender, opts Options, metrics Metrics, log *slog.Logger) *Publisher {
	if opts.Buffer <= 0 {
		opts.Buffer = 10000
	}
	if opts.Workers <= 0 {
		opts.Workers = 4
	}
	if opts.MaxBatch <= 0 || opts.MaxBatch > 10 {
		opts.MaxBatch = 10
	}
	if opts.Linger <= 0 {
		opts.Linger = 200 * time.Millisecond
	}
	if opts.Retries <= 0 {
		opts.Retries = 3
	}
	return &Publisher{sender: sender, opts: opts, metrics: metrics, log: log, queue: make(chan Event, opts.Buffer), done: make(chan struct{})}
}

// Publish enqueues without blocking and reports false when the buffer is full.
func (p *Publisher) Publish(e Event) bool {
	select {
	case p.queue <- e:
		return true
	default:
		p.metrics.Dropped.Inc()
		return false
	}
}

// Run sends batches until ctx is canceled, then flushes what is buffered and closes Done.
// Publish must not be called after ctx is canceled.
func (p *Publisher) Run(ctx context.Context) {
	var wg sync.WaitGroup
	for range p.opts.Workers {
		wg.Go(func() { p.worker(ctx) })
	}
	wg.Wait()
	close(p.done)
}

// Done is closed once every buffered event has been sent or given up on.
func (p *Publisher) Done() <-chan struct{} { return p.done }

func (p *Publisher) worker(ctx context.Context) {
	batch := make([]Event, 0, p.opts.MaxBatch)
	timer := time.NewTimer(time.Hour)
	timer.Stop()
	flush := func(ctx context.Context) {
		if len(batch) > 0 {
			p.send(ctx, batch)
			batch = batch[:0]
		}
	}
	for {
		select {
		case e := <-p.queue:
			batch = append(batch, e)
			if len(batch) == 1 {
				timer.Reset(p.opts.Linger)
			}
			if len(batch) == p.opts.MaxBatch {
				timer.Stop()
				flush(ctx)
			}
		case <-timer.C:
			flush(ctx)
		case <-ctx.Done():
			drain, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			for {
				select {
				case e := <-p.queue:
					batch = append(batch, e)
					if len(batch) == p.opts.MaxBatch {
						flush(drain)
					}
				default:
					flush(drain)
					return
				}
			}
		}
	}
}

func (p *Publisher) send(ctx context.Context, batch []Event) {
	var err error
	for attempt := range p.opts.Retries {
		if attempt > 0 {
			select {
			case <-time.After(time.Duration(50<<attempt) * time.Millisecond):
			case <-ctx.Done():
			}
		}
		if err = p.sender.Send(ctx, batch); err == nil {
			p.metrics.Published.Add(float64(len(batch)))
			return
		}
		if ctx.Err() != nil {
			break
		}
	}
	p.metrics.Failed.Add(float64(len(batch)))
	p.log.Error("dropping ad events after retries", "count", len(batch), "error", err)
}
