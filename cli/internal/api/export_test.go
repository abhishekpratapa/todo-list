package api

import (
	"net/http"
	"time"
)

// WithHTTPClient makes c use hc (which trusts a test server's certificate).
func WithHTTPClient(c *Client, hc *http.Client) *Client {
	c.http, c.stream = hc, hc
	return c
}

// SetStreamIdle changes how long a silent stream is tolerated, and returns a
// function that puts it back.
func SetStreamIdle(d time.Duration) func() {
	old := streamIdle
	streamIdle = d
	return func() { streamIdle = old }
}
