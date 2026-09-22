package db

import (
	"context"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"

	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

type DB struct {
	Client   *mongo.Client
	Users    *mongo.Collection
	Sessions *mongo.Collection
	Entries  *mongo.Collection
}

func Open(ctx context.Context, uri, name string) (*DB, error) {
	cl, err := mongo.Connect(options.Client().ApplyURI(uri).
		SetCompressors([]string{"zstd", "snappy"}).
		SetMaxPoolSize(64))
	if err != nil {
		return nil, err
	}
	pctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	if err := cl.Ping(pctx, nil); err != nil {
		return nil, err
	}
	database := cl.Database(name)
	db := &DB{
		Client:   cl,
		Users:    database.Collection("users"),
		Sessions: database.Collection("sessions"),
		Entries:  database.Collection("entries"),
	}
	return db, db.ensureIndexes(ctx)
}

func (d *DB) ensureIndexes(ctx context.Context) error {
	uniq := options.Index().SetUnique(true)
	if _, err := d.Users.Indexes().CreateOne(ctx, mongo.IndexModel{
		Keys: bson.D{{Key: "email", Value: 1}}, Options: uniq}); err != nil {
		return err
	}
	// Sessions self-expire; Mongo reaps them, no sweeper goroutine needed.
	if _, err := d.Sessions.Indexes().CreateOne(ctx, mongo.IndexModel{
		Keys: bson.D{{Key: "expiresAt", Value: 1}}, Options: options.Index().SetExpireAfterSeconds(0)}); err != nil {
		return err
	}
	_, err := d.Entries.Indexes().CreateMany(ctx, []mongo.IndexModel{
		// Timeline + list queries: newest-first window scan per user.
		{Keys: bson.D{{Key: "userId", Value: 1}, {Key: "startsAt", Value: -1}}},
		// Kind-filtered timeline lanes.
		{Keys: bson.D{{Key: "userId", Value: 1}, {Key: "kind", Value: 1}, {Key: "startsAt", Value: -1}}},
		// Range overlap queries need endsAt too.
		{Keys: bson.D{{Key: "userId", Value: 1}, {Key: "endsAt", Value: -1}}},
		// Blob refcounting on delete.
		{Keys: bson.D{{Key: "blob", Value: 1}}},
		{Keys: bson.D{{Key: "thumb", Value: 1}}},
	})
	return err
}
