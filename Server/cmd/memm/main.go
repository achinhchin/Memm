// Command memm serves the Memm journal API and the client bundle on one port.
package main

import (
	"context"
	"crypto/tls"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"memm/internal/api"
	"memm/internal/config"
	"memm/internal/db"
	"memm/internal/media"
	"memm/internal/store"
)

func main() {
	log.SetFlags(log.Ltime)
	cfg := config.Load()

	// ffmpeg is a hard requirement: every capture is expected to come out with
	// a thumbnail or waveform and a normalized encode.
	if err := media.MustExist(); err != nil {
		log.Fatalf("startup: %v\n  install it with: brew install ffmpeg", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	database, err := db.Open(ctx, cfg.MongoURI, cfg.MongoDB)
	if err != nil {
		log.Fatalf("mongo: %v\n  is mongod running? brew services start mongodb-community", err)
	}
	defer database.Client.Disconnect(context.Background())

	blobs, err := store.New(cfg.DataDir)
	if err != nil {
		log.Fatalf("blob store: %v", err)
	}

	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           api.New(cfg, database, blobs).Handler(),
		ReadHeaderTimeout: 15 * time.Second,
		// No write timeout: long uploads and large range reads must not be
		// cut off mid-stream. ReadHeaderTimeout still bounds slowloris.
		IdleTimeout: 120 * time.Second,
		TLSConfig:   &tls.Config{MinVersion: tls.VersionTLS12},
	}

	go func() {
		scheme := "http"
		if cfg.TLS {
			scheme = "https"
		}
		log.Printf("memm listening on %s://localhost%s (client: %s)", scheme, cfg.Addr, cfg.ClientDir)
		var err error
		if cfg.TLS {
			err = srv.ListenAndServeTLS(cfg.CertFile, cfg.KeyFile)
		} else {
			err = srv.ListenAndServe()
		}
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("listen: %v", err)
		}
	}()

	<-ctx.Done()
	log.Println("shutting down")
	sctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	srv.Shutdown(sctx)
}
