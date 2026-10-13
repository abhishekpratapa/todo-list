package config

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func env(m map[string]string) func(string) string { return func(k string) string { return m[k] } }

func TestDir(t *testing.T) {
	if got := Dir(env(nil), "/Users/me"); got != "/Users/me/.config/todos" {
		t.Errorf("default: %s", got)
	}
	if got := Dir(env(map[string]string{"XDG_CONFIG_HOME": "/x/cfg"}), "/Users/me"); got != "/x/cfg/todos" {
		t.Errorf("with XDG_CONFIG_HOME: %s", got)
	}
	// A relative XDG_CONFIG_HOME is invalid by the spec and is ignored.
	if got := Dir(env(map[string]string{"XDG_CONFIG_HOME": "relative"}), "/Users/me"); got != "/Users/me/.config/todos" {
		t.Errorf("with a relative XDG_CONFIG_HOME: %s", got)
	}
	// Never the app's own folder, which on a Mac differs from "todos" only by case.
	if strings.Contains(Dir(env(nil), "/Users/me"), "Application Support") {
		t.Error("the config folder must not be inside Application Support")
	}
}

func TestSocketPathMatchesTheApp(t *testing.T) {
	// The same rules as src/socket.js.
	home := "/Users/me"
	if got := SocketPath(env(nil), home, "darwin"); got != "/Users/me/Library/Application Support/Todos/todos.sock" {
		t.Errorf("on a Mac: %s", got)
	}
	if got := SocketPath(env(nil), home, "linux"); got != "/Users/me/.todos/todos.sock" {
		t.Errorf("elsewhere: %s", got)
	}
	if got := SocketPath(env(map[string]string{"TODOS_SOCKET": "/tmp/x/t.sock"}), home, "darwin"); got != "/tmp/x/t.sock" {
		t.Errorf("with TODOS_SOCKET: %s", got)
	}
	// A long home folder pushes the usual place past 103 bytes: fall back to ~/.todos.
	long := "/Users/" + strings.Repeat("a", 60)
	if got := SocketPath(env(nil), long, "darwin"); got != long+"/.todos/todos.sock" {
		t.Errorf("with a long home folder: %s", got)
	}
	// Exactly at the limit still fits; one more byte does not.
	fits := "/" + strings.Repeat("b", SocketPathMax-1)
	if got := SocketPath(env(map[string]string{"TODOS_SOCKET": fits}), home, "darwin"); got != fits {
		t.Errorf("a path of exactly %d bytes should fit", SocketPathMax)
	}
	if got := SocketPath(env(map[string]string{"TODOS_SOCKET": fits + "b"}), home, "darwin"); got != "" {
		t.Errorf("a path one byte too long: %q", got)
	}
	// Nothing fits at all.
	if got := SocketPath(env(nil), "/Users/"+strings.Repeat("c", 120), "darwin"); got != "" {
		t.Errorf("nothing should fit: %q", got)
	}
}

func TestResolve(t *testing.T) {
	sock := "/tmp/t.sock"
	two := &File{Default: "home", Profiles: map[string]*Profile{"home": {URL: "https://home"}, "work": {URL: "https://work"}}}
	one := &File{Profiles: map[string]*Profile{"only": {URL: "https://only"}}}
	none := &File{Profiles: map[string]*Profile{}}
	noDefault := &File{Profiles: map[string]*Profile{"a": {}, "b": {}}}
	localDefault := &File{Default: Local, Profiles: map[string]*Profile{"home": {URL: "https://home"}}}

	for _, c := range []struct {
		name  string
		file  *File
		asked string
		where Where
		want  string // a profile name, or "!" plus part of the error
	}{
		{"asked for by name", two, "work", Where{GOOS: "linux"}, "work"},
		{"asked for local", two, "local", Where{GOOS: "darwin", Socket: sock}, "local"},
		{"asked for one that isn't there", two, "nope", Where{GOOS: "linux"}, `!no profile named "nope"`},
		{"on the Mac, the socket is there", two, "", Where{GOOS: "darwin", Socket: sock, SocketExists: true}, "local"},
		{"a dev server's socket on Linux", two, "", Where{GOOS: "linux", Socket: sock, SocketExists: true}, "local"},
		{"no socket: the default", two, "", Where{GOOS: "darwin", Socket: sock}, "home"},
		{"no socket, but this is the app's own copy", two, "", Where{GOOS: "darwin", Socket: sock, InBundle: true}, "local"},
		{"no socket, the default is local", localDefault, "", Where{GOOS: "darwin", Socket: sock}, "local"},
		{"the only profile needs no default", one, "", Where{GOOS: "linux"}, "only"},
		{"a Mac with nothing saved starts the app", none, "", Where{GOOS: "darwin", Socket: sock}, "local"},
		{"Linux with nothing saved", none, "", Where{GOOS: "linux", Socket: "/home/me/.todos/todos.sock"}, "!todos pair"},
		{"several, none the default", noDefault, "", Where{GOOS: "linux"}, "!--profile"},
		{"local, but no path fits", none, "local", Where{GOOS: "darwin"}, "!too long"},
	} {
		got, err := Resolve(c.file, c.asked, c.where)
		switch {
		case strings.HasPrefix(c.want, "!"):
			var np *NoProfileError
			if !errors.As(err, &np) || !strings.Contains(err.Error(), c.want[1:]) {
				t.Errorf("%s: got %v, %v; want an error mentioning %q", c.name, got, err, c.want[1:])
			}
		case err != nil || got.Name != c.want || got.Local != (c.want == Local):
			t.Errorf("%s: got %+v, %v; want %s", c.name, got, err, c.want)
		case got.Local && got.Socket != sock:
			t.Errorf("%s: socket %q", c.name, got.Socket)
		case !got.Local && got.Profile == nil:
			t.Errorf("%s: no profile", c.name)
		}
	}
}

func TestSaveAndLoad(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "nested", "todos")
	if f, err := Load(dir); err != nil || len(f.Profiles) != 0 {
		t.Fatalf("a missing file is an empty config: %+v, %v", f, err)
	}
	f := &File{Default: "home", Profiles: map[string]*Profile{"home": {URL: "https://home.ts.net", SSH: "home", TokenStore: "keyring"}}}
	if err := f.Save(dir); err != nil {
		t.Fatal(err)
	}
	if info, _ := os.Stat(dir); info.Mode().Perm() != 0o700 {
		t.Errorf("the folder is %v", info.Mode().Perm())
	}
	if info, _ := os.Stat(filepath.Join(dir, "config.json")); info.Mode().Perm() != 0o600 {
		t.Errorf("the file is %v", info.Mode().Perm())
	}
	got, err := Load(dir)
	if err != nil || got.Default != "home" || *got.Profiles["home"] != *f.Profiles["home"] {
		t.Errorf("read back %+v, %v", got, err)
	}
	// Saving again leaves no temporary files behind.
	if err := f.Save(dir); err != nil {
		t.Fatal(err)
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 1 {
		t.Errorf("%d files in the folder", len(entries))
	}
	os.WriteFile(filepath.Join(dir, "config.json"), []byte("{nope"), 0o600) //nolint:errcheck
	if _, err := Load(dir); err == nil || !strings.Contains(err.Error(), "not valid JSON") {
		t.Errorf("a broken file: %v", err)
	}
}

func TestCheckName(t *testing.T) {
	for _, good := range []string{"home", "my-mac", "mac.2", "a", "work_laptop"} {
		if err := CheckName(good); err != nil {
			t.Errorf("%q: %v", good, err)
		}
	}
	for _, bad := range []string{"", "local", "Home", "has space", "-dash", "../x", strings.Repeat("a", 33)} {
		if CheckName(bad) == nil {
			t.Errorf("%q should not be a name", bad)
		}
	}
}
