// Package creds keeps the access token for each remote profile: in the
// system's keyring where there is one (the macOS Keychain, or the Secret
// Service on Linux), otherwise in a file only the user can read.
package creds

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/zalando/go-keyring"

	"todos/internal/config"
)

const (
	Keyring = "keyring"
	File    = "file"

	service  = "todos-cli"
	fileName = "credentials.json"
)

// A place tokens can be kept by name. The system keyring, or a stand-in.
type Ring interface {
	Get(service, account string) (string, error)
	Set(service, account, secret string) error
	Delete(service, account string) error
}

type systemRing struct{}

func (systemRing) Get(s, a string) (string, error) { return keyring.Get(s, a) }
func (systemRing) Set(s, a, secret string) error   { return keyring.Set(s, a, secret) }
func (systemRing) Delete(s, a string) error        { return keyring.Delete(s, a) }

// Store finds, saves and removes tokens.
type Store struct {
	Dir     string              // the config directory, for the file
	Getenv  func(string) string // the environment
	GOOS    string
	Ring    Ring          // nil: the system keyring
	Timeout time.Duration // how long the keyring may take; 3 seconds if zero
}

// ErrNoToken means no token is saved for the profile.
var ErrNoToken = errors.New("no access token is saved for this profile: run `todos pair` again")

// Forced is the store named by TODOS_TOKEN_STORE, if any.
func (s *Store) forced() string {
	switch v := s.Getenv("TODOS_TOKEN_STORE"); v {
	case Keyring, File:
		return v
	}
	return ""
}

// keyringLikely says whether trying the keyring is worth it. On Linux the
// Secret Service is reached over the session bus; a machine with none (a server
// reached over SSH) is not asked, so nothing waits on a bus that isn't there.
func (s *Store) keyringLikely() bool {
	switch s.GOOS {
	case "darwin":
		return true
	case "linux":
		return s.Getenv("DBUS_SESSION_BUS_ADDRESS") != ""
	}
	return false
}

// A keyring that is locked, or whose daemon has stopped answering, can hang.
// What fn returns is handed over on a channel, so a call that comes back after
// the wait is over touches nothing.
func (s *Store) withTimeout(fn func(Ring) (string, error)) (string, error) {
	ring := s.Ring
	if ring == nil {
		ring = systemRing{}
	}
	limit := s.Timeout
	if limit == 0 {
		limit = 3 * time.Second
	}
	type answer struct {
		value string
		err   error
	}
	done := make(chan answer, 1)
	go func() {
		value, err := fn(ring)
		done <- answer{value, err}
	}()
	select {
	case a := <-done:
		return a.value, a.err
	case <-time.After(limit):
		return "", errors.New("the keyring did not answer")
	}
}

// Get returns the token for a profile: TODOS_TOKEN if set (never saved
// anywhere), otherwise from wherever Set put it.
func (s *Store) Get(name string, p *config.Profile) (string, error) {
	if t := s.Getenv("TODOS_TOKEN"); t != "" {
		return t, nil
	}
	where := p.TokenStore
	if f := s.forced(); f != "" {
		where = f
	}
	if where == Keyring {
		token, err := s.withTimeout(func(r Ring) (string, error) { return r.Get(service, name) })
		if err == nil && token != "" {
			return token, nil
		}
		if errors.Is(err, keyring.ErrNotFound) {
			return "", ErrNoToken
		}
		return "", fmt.Errorf("can't read the access token from the keyring (%v): unlock it, or run `todos pair` again", err)
	}
	tokens, err := s.readFile()
	if err != nil {
		return "", err
	}
	if tokens[name] == "" {
		return "", ErrNoToken
	}
	return tokens[name], nil
}

// Set saves a token and returns where it went: Keyring or File. `prefer` forces
// one ("" picks the keyring when there is one, and falls back to the file).
func (s *Store) Set(name, token, prefer string) (string, error) {
	if f := s.forced(); f != "" && prefer == "" {
		prefer = f
	}
	if prefer == Keyring || (prefer == "" && s.keyringLikely()) {
		_, err := s.withTimeout(func(r Ring) (string, error) { return "", r.Set(service, name, token) })
		if err == nil {
			s.dropFromFile(name) // one copy only
			return Keyring, nil
		}
		if prefer == Keyring {
			return "", fmt.Errorf("can't save the access token in the keyring: %v", err)
		}
	}
	tokens, err := s.readFile()
	if err != nil {
		return "", err
	}
	tokens[name] = token
	if err := s.writeFile(tokens); err != nil {
		return "", err
	}
	return File, nil
}

// Delete removes a profile's token from wherever it is.
func (s *Store) Delete(name string, p *config.Profile) error {
	if p != nil && p.TokenStore == Keyring {
		_, err := s.withTimeout(func(r Ring) (string, error) { return "", r.Delete(service, name) })
		if err != nil && !errors.Is(err, keyring.ErrNotFound) {
			return fmt.Errorf("can't remove the access token from the keyring: %v", err)
		}
	}
	return s.dropFromFile(name)
}

// Path is where the token file is.
func (s *Store) Path() string { return filepath.Join(s.Dir, fileName) }

// readFile reads the token file. One that other users can read is refused, as
// ssh refuses a private key: the token in it may already be someone else's.
func (s *Store) readFile() (map[string]string, error) {
	tokens := map[string]string{}
	info, err := os.Stat(s.Path())
	if errors.Is(err, os.ErrNotExist) {
		return tokens, nil
	}
	if err != nil {
		return nil, err
	}
	if info.Mode().Perm()&0o077 != 0 {
		return nil, fmt.Errorf("%s can be read by other users (mode %04o): run `chmod 600 %s`, and consider rotating the token in Todos → Remote Access", s.Path(), info.Mode().Perm(), s.Path())
	}
	b, err := os.ReadFile(s.Path())
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(b, &tokens); err != nil {
		return nil, fmt.Errorf("%s is not valid JSON: %w", s.Path(), err)
	}
	return tokens, nil
}

func (s *Store) writeFile(tokens map[string]string) error {
	if len(tokens) == 0 {
		err := os.Remove(s.Path())
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	b, err := json.MarshalIndent(tokens, "", "  ")
	if err != nil {
		return err
	}
	return config.WritePrivate(s.Dir, fileName, append(b, '\n'))
}

func (s *Store) dropFromFile(name string) error {
	tokens, err := s.readFile()
	if err != nil {
		return err
	}
	if _, ok := tokens[name]; !ok {
		return nil
	}
	delete(tokens, name)
	return s.writeFile(tokens)
}
