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

// migrateEmailToUsername moves databases created before accounts dropped the
// email field. Without it the old unique index on email would reject every new
// account (they all have no email, and a unique index rejects the second
// missing value), and the new unique index on username could not be built.
func (d *DB) migrateEmailToUsername(ctx context.Context) error {
	// Drop the old index before renaming, not after. Renaming clears the email
	// field one document at a time, and a unique index treats a second missing
	// value as a duplicate of the first, so the rename would fail partway
	// through with E11000 on { email: null }.
	// DropOne errors when the index is already gone, which is the normal case
	// on every start after the first.
	_ = d.Users.Indexes().DropOne(ctx, "email_1")
	_, err := d.Users.UpdateMany(ctx,
		bson.M{"email": bson.M{"$exists": true}, "username": bson.M{"$exists": false}},
		bson.M{"$rename": bson.M{"email": "username"}, "$unset": bson.M{"name": ""}},
	)
	return err
}

func (d *DB) ensureIndexes(ctx context.Context) error {
	if err := d.migrateEmailToUsername(ctx); err != nil {
		return err
	}
	uniq := options.Index().SetUnique(true)
	if _, err := d.Users.Indexes().CreateOne(ctx, mongo.IndexModel{
		Keys: bson.D{{Key: "username", Value: 1}}, Options: uniq}); err != nil {
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
