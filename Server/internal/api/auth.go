package api

import (
	"net/http"
	"strings"
	"time"

	"memm/internal/auth"
	"memm/internal/models"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

type credentials struct {
	Email    string `json:"email"`
	Password string `json:"password"`
	Name     string `json:"name"`
	TZOffset int    `json:"tzOffset"`
}

func (s *Server) handleSignup(w http.ResponseWriter, r *http.Request) {
	var c credentials
	if err := decode(r, &c); err != nil {
		fail(w, http.StatusBadRequest, "malformed request")
		return
	}
	c.Email = strings.ToLower(strings.TrimSpace(c.Email))
	if !strings.Contains(c.Email, "@") {
		fail(w, http.StatusBadRequest, "enter a valid email")
		return
	}
	if len(c.Password) < 8 {
		fail(w, http.StatusBadRequest, "password must be at least 8 characters")
		return
	}
	hash, err := auth.Hash(c.Password)
	if err != nil {
		fail(w, http.StatusInternalServerError, "could not secure password")
		return
	}
	name := strings.TrimSpace(c.Name)
	if name == "" {
		name, _, _ = strings.Cut(c.Email, "@")
	}
	u := models.User{
		Email: c.Email, Name: name, Hash: hash,
		TZOffset: c.TZOffset, CreatedAt: time.Now().UTC(),
	}
	res, err := s.db.Users.InsertOne(r.Context(), u)
	if err != nil {
		if mongo.IsDuplicateKeyError(err) {
			fail(w, http.StatusConflict, "that email is already registered")
			return
		}
		fail(w, http.StatusInternalServerError, "could not create account")
		return
	}
	u.ID = res.InsertedID.(bson.ObjectID)
	s.startSession(w, r, &u)
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var c credentials
	if err := decode(r, &c); err != nil {
		fail(w, http.StatusBadRequest, "malformed request")
		return
	}
	var u models.User
	err := s.db.Users.FindOne(r.Context(),
		bson.M{"email": strings.ToLower(strings.TrimSpace(c.Email))}).Decode(&u)
	// Same message and comparable timing for both failure modes so the
	// endpoint does not confirm whether an email is registered.
	if err != nil {
		auth.Verify(c.Password, "$argon2id$v=19$m=65536,t=2,p=4$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
		fail(w, http.StatusUnauthorized, "incorrect email or password")
		return
	}
	if !auth.Verify(c.Password, u.Hash) {
		fail(w, http.StatusUnauthorized, "incorrect email or password")
		return
	}
	if c.TZOffset != u.TZOffset {
		s.db.Users.UpdateByID(r.Context(), u.ID, bson.M{"$set": bson.M{"tzOffset": c.TZOffset}})
		u.TZOffset = c.TZOffset
	}
	s.startSession(w, r, &u)
}

func (s *Server) startSession(w http.ResponseWriter, r *http.Request, u *models.User) {
	token, err := auth.NewToken()
	if err != nil {
		fail(w, http.StatusInternalServerError, "could not start session")
		return
	}
	now := time.Now().UTC()
	_, err = s.db.Sessions.InsertOne(r.Context(), models.Session{
		Token: token, UserID: u.ID, CreatedAt: now, ExpiresAt: now.Add(sessionTTL),
	})
	if err != nil {
		fail(w, http.StatusInternalServerError, "could not start session")
		return
	}
	s.setCookie(w, token)
	send(w, http.StatusOK, u)
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(sessionCookie); err == nil {
		s.db.Sessions.DeleteOne(r.Context(), bson.M{"_id": c.Value})
	}
	s.clearCookie(w)
	send(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	send(w, http.StatusOK, user(r))
}
