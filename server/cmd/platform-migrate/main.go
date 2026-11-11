// Command platform-migrate applies the Screenshot Studio product schema.
package main

import (
	"context"
	"flag"
	"log/slog"
	"os"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/founderhubmigrations"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/authstore"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/database"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/platformmigrations"
)

func main() {
	founderHub := flag.String("founder-hub", "", "bootstrap roles before Storage migrations, or apply the Founder Hub domain migrations afterward")
	flag.Parse()
	if *founderHub != "" && *founderHub != "bootstrap" && *founderHub != "apply" {
		slog.Error("invalid Founder Hub migration phase")
		os.Exit(1)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	db, err := database.Open(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		slog.Error("platform database unavailable", "error", err)
		os.Exit(1)
	}
	defer db.Close()
	if err := platformmigrations.Apply(ctx, db.SQL); err != nil {
		slog.Error("platform migration failed", "error", err)
		os.Exit(1)
	}
	if err := authstore.ConfigureFounderHubWeb(ctx, db.SQL, os.Getenv("FOUNDER_HUB_WEB_ORIGIN")); err != nil {
		slog.Error("Founder Hub client configuration failed", "error", err)
		os.Exit(1)
	}
	if *founderHub != "" {
		migrate := founderhubmigrations.Bootstrap
		if *founderHub == "apply" {
			migrate = founderhubmigrations.Apply
		}
		if err := migrate(ctx, db.SQL); err != nil {
			slog.Error("Founder Hub migration failed", "error", err)
			os.Exit(1)
		}
		if err := founderhubmigrations.ConfigureLogins(ctx, db.SQL, os.Getenv("FOUNDER_HUB_DB_REST_PASSWORD"), os.Getenv("FOUNDER_HUB_DB_STORAGE_PASSWORD")); err != nil {
			slog.Error("Founder Hub database login configuration failed", "error", err)
			os.Exit(1)
		}
	}
	slog.Info("platform migrations applied")
}
