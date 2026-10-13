package creds

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/zalando/go-keyring"

	"todos/internal/config"
)

// ring is a keyring in memory. It can be made to fail or to hang.
type ring struct {
	mu    sync.Mutex
	items map[string]string
	err   error
	hang  time.Duration
	calls int
}

func (r *ring) do() error {
	r.mu.Lock()
	r.calls++
	r.mu.Unlock()
	time.Sleep(r.hang)
	return r.err
}
func (r *ring) asked() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.calls
}
func (r *ring) Get(service, account string) (string, error) {
	if err := r.do(); err != nil {
		return "", err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	v, ok := r.items[service+"/"+account]
	if !ok {
		return "", keyring.ErrNotFound
	}
	return v, nil
}
func (r *ring) Set(service, account, secret string) error {
	if err := r.do(); err != nil {
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.items[service+"/"+account] = secret
	return nil
}
func (r *ring) Delete(service, account string) error {
	if err := r.do(); err != nil {
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.items, service+"/"+account)
	return nil
}

func store(t *testing.T, goos string, vars map[string]string, r *ring) *Store {
	return &Store{Dir: filepath.Join(t.TempDir(), "todos"), Getenv: func(k string) string { return vars[k] }, GOOS: goos, Ring: r, Timeout: 200 * time.Millisecond}
}

const token = "tok-0123456789abcdef0123456789abcdef"

func TestKeyringWhereThereIsOne(t *testing.T) {
	r := &ring{items: map[string]string{}}
	s := store(t, "darwin", nil, r)
	where, err := s.Set("home", token, "")
	if err != nil || where != Keyring || r.items["todos-cli/home"] != token {
		t.Fatalf("Set: %s, %v, %v", where, err, r.items)
	}
	if _, err := os.Stat(s.Path()); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("no file should be written when the keyring took the token")
	}
	got, err := s.Get("home", &config.Profile{TokenStore: where})
	if err != nil || got != token {
		t.Errorf("Get: %q, %v", got, err)
	}
	if err := s.Delete("home", &config.Profile{TokenStore: where}); err != nil || len(r.items) != 0 {
		t.Errorf("Delete: %v, %v", err, r.items)
	}
	if _, err := s.Get("home", &config.Profile{TokenStore: where}); !errors.Is(err, ErrNoToken) {
		t.Errorf("after Delete: %v", err)
	}
}

func TestHeadlessLinuxUsesAFile(t *testing.T) {
	// No session bus, so no Secret Service: the keyring is not even asked.
	r := &ring{items: map[string]string{}}
	s := store(t, "linux", nil, r)
	where, err := s.Set("home", token, "")
	if err != nil || where != File || r.asked() != 0 {
		t.Fatalf("Set: %s, %v, keyring asked %d times", where, err, r.asked())
	}
	info, err := os.Stat(s.Path())
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("the token file: %v, %v", err, info.Mode().Perm())
	}
	if dir, _ := os.Stat(s.Dir); dir.Mode().Perm() != 0o700 {
		t.Errorf("the folder is %v", dir.Mode().Perm())
	}
	got, err := s.Get("home", &config.Profile{TokenStore: File})
	if err != nil || got != token {
		t.Errorf("Get: %q, %v", got, err)
	}

	// Two profiles share the file; removing one leaves the other; removing both removes the file.
	if _, err := s.Set("work", "other-token", ""); err != nil {
		t.Fatal(err)
	}
	if err := s.Delete("home", &config.Profile{TokenStore: File}); err != nil {
		t.Fatal(err)
	}
	if got, _ := s.Get("work", &config.Profile{TokenStore: File}); got != "other-token" {
		t.Errorf("the other profile's token: %q", got)
	}
	if err := s.Delete("work", &config.Profile{TokenStore: File}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(s.Path()); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("an empty token file should be removed")
	}
}

func TestLinuxWithASecretService(t *testing.T) {
	r := &ring{items: map[string]string{}}
	s := store(t, "linux", map[string]string{"DBUS_SESSION_BUS_ADDRESS": "unix:path=/run/user/1000/bus"}, r)
	if where, err := s.Set("home", token, ""); err != nil || where != Keyring {
		t.Fatalf("Set: %s, %v", where, err)
	}
}

func TestAKeyringThatFailsOrHangsFallsBackToTheFile(t *testing.T) {
	for name, r := range map[string]*ring{
		"locked":  {items: map[string]string{}, err: errors.New("User interaction is not allowed")},
		"hanging": {items: map[string]string{}, hang: 2 * time.Second},
	} {
		s := store(t, "darwin", nil, r)
		began := time.Now()
		where, err := s.Set("home", token, "")
		if err != nil || where != File {
			t.Errorf("%s: Set: %s, %v", name, where, err)
		}
		if took := time.Since(began); took > time.Second {
			t.Errorf("%s: waited %s for the keyring", name, took)
		}
		// Asked for the keyring by name, there is no falling back: say why not.
		if _, err := s.Set("home", token, Keyring); err == nil || !strings.Contains(err.Error(), "keyring") {
			t.Errorf("%s: forced keyring: %v", name, err)
		}
		// A token that is in the keyring can't be read while it is like this, and the error says so.
		if _, err := s.Get("x", &config.Profile{TokenStore: Keyring}); err == nil || errors.Is(err, ErrNoToken) {
			t.Errorf("%s: Get from a broken keyring: %v", name, err)
		}
	}
}

func TestEnvironmentOverrides(t *testing.T) {
	r := &ring{items: map[string]string{}}
	// TODOS_TOKEN is used as is, and nothing is read from anywhere.
	s := store(t, "darwin", map[string]string{"TODOS_TOKEN": "from-env"}, r)
	if got, err := s.Get("home", &config.Profile{TokenStore: Keyring}); err != nil || got != "from-env" || r.asked() != 0 {
		t.Errorf("TODOS_TOKEN: %q, %v, keyring asked %d times", got, err, r.asked())
	}
	// TODOS_TOKEN_STORE=file keeps the keyring out of it altogether.
	s = store(t, "darwin", map[string]string{"TODOS_TOKEN_STORE": "file"}, r)
	if where, err := s.Set("home", token, ""); err != nil || where != File || r.asked() != 0 {
		t.Errorf("TODOS_TOKEN_STORE=file: %s, %v, keyring asked %d times", where, err, r.asked())
	}
	// Moving a token into the keyring leaves no copy in the file.
	s = store(t, "darwin", nil, r)
	if _, err := s.Set("home", token, File); err != nil {
		t.Fatal(err)
	}
	if where, err := s.Set("home", token, Keyring); err != nil || where != Keyring {
		t.Fatalf("Set keyring: %s, %v", where, err)
	}
	if b, err := os.ReadFile(s.Path()); err == nil && strings.Contains(string(b), token) {
		t.Errorf("the file still holds the token: %s", b)
	}
}

func TestATokenFileOthersCanReadIsRefused(t *testing.T) {
	s := store(t, "linux", nil, &ring{items: map[string]string{}})
	if _, err := s.Set("home", token, ""); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(s.Path(), 0o640); err != nil {
		t.Fatal(err)
	}
	_, err := s.Get("home", &config.Profile{TokenStore: File})
	if err == nil || !strings.Contains(err.Error(), "chmod 600") || strings.Contains(err.Error(), token) {
		t.Errorf("Get: %v", err)
	}
	// Nor is it written to while it is like that.
	if _, err := s.Set("work", "x", ""); err == nil {
		t.Errorf("Set should refuse too")
	}
}
