// Package config is where the todos command keeps its profiles, and how it
// decides which one a command uses.
//
// The config directory is $XDG_CONFIG_HOME/todos, or ~/.config/todos, on macOS
// as well as Linux. It is deliberately not ~/Library/Application Support/todos:
// on a Mac's usual case-insensitive disk that is the Todos app's own folder,
// where the list itself lives, and this command never goes near that.
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
)

// Local is the name of the profile that talks to the app on this Mac through
// its socket. It is built in: it needs no pairing and is never written down.
const Local = "local"

// Profile is another Mac's Todos, reached over the tailnet.
type Profile struct {
	URL string `json:"url"`
	// SSH is a host from the user's own SSH setup. When Todos is not running on
	// the Mac, the command starts it there over SSH. Optional.
	SSH string `json:"ssh,omitempty"`
	// TokenStore is where the access token was put: "keyring" or "file".
	TokenStore string `json:"tokenStore,omitempty"`
}

// File is config.json.
type File struct {
	Default  string              `json:"default,omitempty"`
	Profiles map[string]*Profile `json:"profiles"`
}

// Dir is the config directory.
func Dir(getenv func(string) string, home string) string {
	if x := getenv("XDG_CONFIG_HOME"); x != "" && filepath.IsAbs(x) {
		return filepath.Join(x, "todos")
	}
	return filepath.Join(home, ".config", "todos")
}

var nameRE = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,31}$`)

// CheckName says whether name can be a profile's name.
func CheckName(name string) error {
	if name == Local {
		return fmt.Errorf("%q is the built-in profile for this Mac; choose another name", Local)
	}
	if !nameRE.MatchString(name) {
		return fmt.Errorf("a profile name is 1 to 32 lowercase letters, digits, dots, hyphens or underscores, not %q", name)
	}
	return nil
}

// Load reads config.json from dir. A missing file is an empty config.
func Load(dir string) (*File, error) {
	f := &File{Profiles: map[string]*Profile{}}
	b, err := os.ReadFile(filepath.Join(dir, "config.json"))
	if errors.Is(err, os.ErrNotExist) {
		return f, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(b, f); err != nil {
		return nil, fmt.Errorf("%s is not valid JSON: %w", filepath.Join(dir, "config.json"), err)
	}
	if f.Profiles == nil {
		f.Profiles = map[string]*Profile{}
	}
	return f, nil
}

// Save writes config.json to dir, which only the user can read.
func (f *File) Save(dir string) error {
	b, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return err
	}
	return WritePrivate(dir, "config.json", append(b, '\n'))
}

// WritePrivate writes dir/name so that only the user can read it, replacing
// any earlier copy in one step.
func WritePrivate(dir, name string, data []byte) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, name+".*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), filepath.Join(dir, name))
}

// Names lists the saved profiles in order.
func (f *File) Names() []string {
	names := make([]string, 0, len(f.Profiles))
	for name := range f.Profiles {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// SocketPathMax is the longest a socket's path may be, in bytes. macOS allows
// 104 and Go stops at 103; the app uses the same limit.
const SocketPathMax = 103

// SocketPath is where the app's local socket is, worked out exactly as the app
// does (src/socket.js): TODOS_SOCKET if set; otherwise next to the app's data;
// otherwise, when a long home folder pushes that past the limit,
// ~/.todos/todos.sock. Empty when nothing fits.
func SocketPath(getenv func(string) string, home, goos string) string {
	fits := func(p string) bool { return len(p) <= SocketPathMax }
	if chosen := getenv("TODOS_SOCKET"); chosen != "" {
		if abs, err := filepath.Abs(chosen); err == nil && fits(abs) {
			return abs
		}
		return ""
	}
	var candidates []string
	if goos == "darwin" {
		candidates = append(candidates, filepath.Join(home, "Library", "Application Support", "Todos", "todos.sock"))
	}
	candidates = append(candidates, filepath.Join(home, ".todos", "todos.sock"))
	for _, c := range candidates {
		if fits(c) {
			return c
		}
	}
	return ""
}

// Resolved is the profile a command will use.
type Resolved struct {
	Name    string
	Local   bool
	Socket  string   // for the local profile
	Profile *Profile // for a remote one
}

// Where describes the machine, for choosing a profile.
type Where struct {
	GOOS         string
	Socket       string // from SocketPath; may be empty
	SocketExists bool
	InBundle     bool // this command is the copy inside a Todos.app
}

// NoProfileError means there is nothing to connect to yet.
type NoProfileError struct{ Msg string }

func (e *NoProfileError) Error() string { return e.Msg }

// Resolve picks the profile: the one asked for (--profile, then TODOS_PROFILE);
// otherwise the local one when its socket is there; otherwise the saved default;
// otherwise, on a Mac, the local one (the app will be started).
func Resolve(f *File, asked string, w Where) (*Resolved, error) {
	local := func() (*Resolved, error) {
		if w.Socket == "" {
			return nil, &NoProfileError{"the path to Todos' local socket is too long: set TODOS_SOCKET to a shorter one, in the app's environment and here"}
		}
		return &Resolved{Name: Local, Local: true, Socket: w.Socket}, nil
	}
	remote := func(name string) (*Resolved, error) {
		p := f.Profiles[name]
		if p == nil {
			return nil, &NoProfileError{fmt.Sprintf("there is no profile named %q (see `todos profiles`)", name)}
		}
		return &Resolved{Name: name, Profile: p}, nil
	}

	switch {
	case asked == Local:
		return local()
	case asked != "":
		return remote(asked)
	case w.Socket != "" && w.SocketExists:
		return local()
	case w.GOOS == "darwin" && w.InBundle && w.Socket != "":
		return local()
	case f.Default == Local:
		return local()
	case f.Default != "" && f.Profiles[f.Default] != nil:
		return remote(f.Default)
	case len(f.Profiles) == 1:
		return remote(f.Names()[0])
	case w.GOOS == "darwin":
		return local()
	}
	if len(f.Profiles) > 1 {
		return nil, &NoProfileError{"several profiles are saved and none is the default: pass --profile, or choose one with `todos profiles use <name>`"}
	}
	return nil, &NoProfileError{"not connected to a Mac yet: run `todos pair` with the address from Todos → Remote Access"}
}
