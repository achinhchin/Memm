package config

import (
	"bufio"
	"os"
	"strconv"
	"strings"
)

type Config struct {
	Addr, MongoURI, MongoDB, ClientDir, CertFile, KeyFile, DataDir string
	TLS, Dev                                                       bool
	MaxChunk                                                       int64
}

// Load reads .env (if present) into the process env, then builds Config.
func Load() Config {
	loadDotEnv(".env")
	return Config{
		Addr:      env("ADDR", ":5050"),
		MongoURI:  env("MONGO_URI", "mongodb://localhost:27017"),
		MongoDB:   env("MONGO_DB", "memm"),
		ClientDir: env("CLIENT_DIR", "../Client"),
		CertFile:  env("CERT_FILE", "./certs/cert.pem"),
		KeyFile:   env("KEY_FILE", "./certs/key.pem"),
		DataDir:   env("DATA_DIR", "./data"),
		TLS:       env("TLS", "1") == "1",
		Dev:       env("DEV", "0") == "1",
		MaxChunk:  envInt("MAX_CHUNK", 16<<20),
	}
}

func env(k, def string) string {
	if v, ok := os.LookupEnv(k); ok && v != "" {
		return v
	}
	return def
}

func envInt(k string, def int64) int64 {
	if n, err := strconv.ParseInt(env(k, ""), 10, 64); err == nil {
		return n
	}
	return def
}

func loadDotEnv(path string) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()
	s := bufio.NewScanner(f)
	for s.Scan() {
		line := strings.TrimSpace(s.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		k, v = strings.TrimSpace(k), strings.Trim(strings.TrimSpace(v), `"'`)
		if _, exists := os.LookupEnv(k); !exists {
			os.Setenv(k, v)
		}
	}
}
