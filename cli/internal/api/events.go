package api

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync/atomic"
	"time"
)

// Event is one live update. "hello" arrives on connecting and "change" whenever
// anything in the list changes; both carry the list's version and nothing else,
// so what changed is found by fetching again. "habits" says the habits changed:
// Version is still the task list's, unchanged, and Habits is the habits' own.
type Event struct {
	Type    string
	Version int
	Habits  int
}

// How long the stream may be silent before it is taken for dead. The server
// sends a comment line every 25 seconds.
var streamIdle = 70 * time.Second

// Events opens the live-update stream and calls fn for each event until the
// stream ends, fn returns an error, or ctx is done. It returns why it stopped;
// never nil.
func (c *Client) Events(ctx context.Context, fn func(Event) error) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	req, err := c.newRequest(ctx, request{method: "GET", path: v1 + "/events", stream: true})
	if err != nil {
		return err
	}
	res, err := c.stream.Do(req)
	if err != nil {
		return classify(err, c.Local, c.host)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		body := make([]byte, 0, 512)
		buf := make([]byte, 512)
		n, _ := res.Body.Read(buf)
		return c.refusal(res, append(body, buf[:n]...))
	}

	var stalled atomic.Bool
	idle := time.AfterFunc(streamIdle, func() {
		stalled.Store(true)
		cancel()
	})
	defer idle.Stop()

	lines := bufio.NewScanner(res.Body)
	lines.Buffer(make([]byte, 0, 4096), 1<<20)
	var name, data string
	for lines.Scan() {
		idle.Reset(streamIdle)
		line := lines.Text()
		switch {
		case line == "":
			if name != "" {
				var payload struct {
					Version int `json:"version"`
					Habits  int `json:"habits"`
				}
				_ = json.Unmarshal([]byte(data), &payload)
				if err := fn(Event{Type: name, Version: payload.Version, Habits: payload.Habits}); err != nil {
					return err
				}
			}
			name, data = "", ""
		case strings.HasPrefix(line, ":"): // a keep-alive comment
		case strings.HasPrefix(line, "event:"):
			name = strings.TrimSpace(line[len("event:"):])
		case strings.HasPrefix(line, "data:"):
			data += strings.TrimSpace(line[len("data:"):])
		}
	}
	if stalled.Load() {
		return &ConnError{Interrupted, "live updates went quiet", nil}
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := lines.Err(); err != nil {
		return classify(err, c.Local, c.host)
	}
	return &ConnError{Interrupted, "live updates ended", nil}
}

// FollowState is told to Follow's caller as the connection comes and goes.
type FollowState struct {
	Connected bool
	Err       error         // why it is not connected
	Retry     time.Duration // how long until the next try
}

// Follow keeps the live-update stream open, reconnecting when it drops. onEvent
// gets every event; a "hello" after a reconnect means changes may have been
// missed, and carries the version to compare. onState, if not nil, hears about
// each connect and disconnect.
//
// It returns when ctx is done, or with the error once reconnecting can't help:
// the token was rejected, or this is not a server that has live updates.
func (c *Client) Follow(ctx context.Context, onEvent func(Event), onState func(FollowState)) error {
	say := func(s FollowState) {
		if onState != nil {
			onState(s)
		}
	}
	wait := time.Second
	for {
		err := c.Events(ctx, func(e Event) error {
			if e.Type == "hello" {
				wait = time.Second
				say(FollowState{Connected: true})
			}
			onEvent(e)
			return nil
		})
		if ctx.Err() != nil {
			return ctx.Err()
		}
		var refused *Error
		if errors.As(err, &refused) {
			switch refused.Status {
			case http.StatusTooManyRequests, http.StatusServiceUnavailable:
				if d := time.Duration(refused.RetryAfter) * time.Second; d > wait {
					wait = d
				}
			default:
				return err // 401, 403, 404: asking again changes nothing, and wrong tokens are counted
			}
		}
		say(FollowState{Err: err, Retry: wait})
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(wait):
		}
		if wait *= 2; wait > 30*time.Second {
			wait = 30 * time.Second
		}
	}
}
