// Command adserver serves ad breaks for video streams. Configuration comes from the environment;
// see the README for every variable.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/redis/go-redis/v9"

	"github.com/yasaswinivardhireddy-png/cuepoint/adserver/internal/catalog"
	"github.com/yasaswinivardhireddy-png/cuepoint/adserver/internal/events"
	"github.com/yasaswinivardhireddy-png/cuepoint/adserver/internal/freqcap"
	"github.com/yasaswinivardhireddy-png/cuepoint/adserver/internal/server"
)

func env(name, def string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return def
}

func duration(name, def string) time.Duration {
	d, err := time.ParseDuration(env(name, def))
	if err != nil {
		fmt.Fprintf(os.Stderr, "%s: %v\n", name, err)
		os.Exit(2)
	}
	return d
}

func required(name string) string {
	v := os.Getenv(name)
	if v == "" {
		fmt.Fprintf(os.Stderr, "%s must be set\n", name)
		os.Exit(2)
	}
	return v
}

func intEnv(name string, def int) int {
	n, err := strconv.Atoi(env(name, strconv.Itoa(def)))
	if err != nil || n <= 0 {
		fmt.Fprintf(os.Stderr, "%s must be a positive whole number\n", name)
		os.Exit(2)
	}
	return n
}

func main() {
	level := slog.LevelInfo
	_ = level.UnmarshalText([]byte(env("LOG_LEVEL", "info")))
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: level}))
	if err := run(log); err != nil {
		log.Error("ad server stopped", "error", err)
		os.Exit(1)
	}
}

func run(log *slog.Logger) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	reg := prometheus.NewRegistry()
	reg.MustRegister(collectors.NewGoCollector(), collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}))

	cat := catalog.New()
	syncErrors := prometheus.NewCounter(prometheus.CounterOpts{Name: "adserver_catalog_sync_errors_total", Help: "Failed campaign syncs."})
	reg.MustRegister(syncErrors)
	syncer := &catalog.Syncer{
		URL:      env("CAMPAIGNS_URL", "http://localhost:3000/internal/v1/campaigns/active"),
		Token:    required("INTERNAL_API_TOKEN"),
		Interval: duration("SYNC_INTERVAL", "5s"),
		Client:   &http.Client{Timeout: 5 * time.Second},
		Catalog:  cat,
		Log:      log,
		Errors:   syncErrors,
	}

	var caps freqcap.Store
	switch backend := env("FREQCAP_BACKEND", "memory"); backend {
	case "memory":
		caps = freqcap.NewMemory()
	case "redis":
		// Tight timeouts: a slow cap lookup should not hold up the ad break.
		client := redis.NewClient(&redis.Options{Addr: env("REDIS_ADDR", "localhost:6379"), DialTimeout: time.Second, ReadTimeout: 100 * time.Millisecond, WriteTimeout: 100 * time.Millisecond})
		defer client.Close()
		caps = freqcap.NewRedis(client)
	default:
		return fmt.Errorf("FREQCAP_BACKEND must be memory or redis, not %q", backend)
	}

	var sender events.Sender = events.LogSender{Log: log}
	if queueURL := os.Getenv("EVENTS_QUEUE_URL"); queueURL != "" {
		// Credentials and endpoint come from the standard AWS variables, or from IRSA on EKS.
		awsCfg, err := config.LoadDefaultConfig(ctx, config.WithDefaultRegion("ap-south-1"))
		if err != nil {
			return fmt.Errorf("loading AWS config: %w", err)
		}
		sender = events.SQSSender{Client: sqs.NewFromConfig(awsCfg), QueueURL: queueURL}
	} else {
		log.Warn("EVENTS_QUEUE_URL not set; impression events are only logged")
	}
	publisher := events.NewPublisher(sender, events.Options{Workers: intEnv("EVENTS_WORKERS", 8)}, events.NewMetrics(reg), log)

	srv := server.New(server.Config{
		PublicBaseURL: env("PUBLIC_BASE_URL", "http://localhost:8080"),
		Secret:        []byte(required("BEACON_SECRET")),
		BeaconMaxAge:  duration("BEACON_MAX_AGE", "1h"),
	}, cat, caps, publisher, reg, log)

	pubCtx, stopPublisher := context.WithCancel(context.Background())
	go publisher.Run(pubCtx)
	go syncer.Run(ctx)

	httpServer := &http.Server{
		Addr:              ":" + env("PORT", "8080"),
		Handler:           srv.Handler(promhttp.HandlerFor(reg, promhttp.HandlerOpts{})),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	serveErr := make(chan error, 1)
	go func() {
		log.Info("ad server listening", "addr", httpServer.Addr, "freqcap", env("FREQCAP_BACKEND", "memory"))
		serveErr <- httpServer.ListenAndServe()
	}()

	select {
	case err := <-serveErr:
		stopPublisher()
		return err
	case <-ctx.Done():
	}

	// Fail readiness first so Kubernetes stops routing here, then finish in-flight requests,
	// then flush buffered impression events.
	srv.Drain()
	time.Sleep(duration("SHUTDOWN_DELAY", "0s"))
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	err := httpServer.Shutdown(shutdownCtx)
	stopPublisher()
	<-publisher.Done()
	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	log.Info("ad server stopped cleanly", "signal", strings.TrimSpace(fmt.Sprint(ctx.Err())))
	return nil
}
