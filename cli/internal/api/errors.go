package api

import (
	"context"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"strings"
	"syscall"
)

// Error is a refusal from the server: { "error": { "code", "message" } }.
type Error struct {
	Status     int
	Code       string
	Message    string
	Current    *Task // on a conflict, the task as it is now
	RetryAfter int   // seconds, when the server says how long to wait
}

func (e *Error) Error() string {
	if e.Message != "" {
		return e.Message
	}
	return fmt.Sprintf("the server answered %d", e.Status)
}

// IsStatus reports whether err is a server refusal with this HTTP status.
func IsStatus(err error, status int) bool {
	var e *Error
	return errors.As(err, &e) && e.Status == status
}

// Why a request never got an answer from Todos.
type ConnKind int

const (
	// Nothing is listening on the local socket: the app is not running.
	NotRunning ConnKind = iota + 1
	// The other Mac could not be reached at all: asleep, offline, off the tailnet.
	Unreachable
	// The hub's name does not resolve: Tailscale is not running on this machine.
	TailscaleDown
	// The Mac answered, but Todos is not serving there: Remote Access is off.
	RemoteOff
	// The Mac answered, but Todos itself is not running behind `tailscale serve`.
	AppDown
	// The connection dropped partway through. The request may or may not have arrived.
	Interrupted
	// The connection could not be trusted or set up (certificates, permissions).
	Refused
)

// ConnError is a request that got no answer from Todos, and the reason.
type ConnError struct {
	Kind ConnKind
	Msg  string
	Err  error
}

func (e *ConnError) Error() string { return e.Msg }
func (e *ConnError) Unwrap() error { return e.Err }

// IsConn reports whether err is a ConnError of one of these kinds (any kind, if none are given).
func IsConn(err error, kinds ...ConnKind) bool {
	var e *ConnError
	if !errors.As(err, &e) {
		return false
	}
	for _, k := range kinds {
		if e.Kind == k {
			return true
		}
	}
	return len(kinds) == 0
}

// classify turns a transport error into a ConnError that says what is wrong in
// the user's terms. `host` is the hub's hostname; empty for the local socket.
func classify(err error, local bool, host string) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, context.Canceled) {
		return context.Canceled
	}
	var uerr *url.Error
	if errors.As(err, &uerr) {
		err = uerr.Err
	}

	if local {
		switch {
		case errors.Is(err, syscall.ENOENT), errors.Is(err, syscall.ECONNREFUSED), errors.Is(err, syscall.ENOTSOCK):
			return &ConnError{NotRunning, "Todos is not running", err}
		case errors.Is(err, syscall.EACCES), errors.Is(err, syscall.EPERM):
			return &ConnError{Refused, "can't open Todos' local socket: it belongs to another user", err}
		case interrupted(err):
			return &ConnError{Interrupted, "the connection to Todos dropped", err}
		case timedOut(err):
			return &ConnError{Unreachable, "Todos did not answer in time", err}
		}
		return &ConnError{Refused, "can't talk to Todos on its local socket: " + err.Error(), err}
	}

	var dns *net.DNSError
	if errors.As(err, &dns) {
		if strings.HasSuffix(host, ".ts.net") {
			return &ConnError{TailscaleDown, fmt.Sprintf("can't find %s: Tailscale isn't running on this machine (or MagicDNS is off)", host), err}
		}
		return &ConnError{Unreachable, fmt.Sprintf("can't find %s: check the address, and that this machine is on your tailnet", host), err}
	}
	var certInvalid x509.CertificateInvalidError
	var certUnknown x509.UnknownAuthorityError
	var certHost x509.HostnameError
	if errors.As(err, &certInvalid) || errors.As(err, &certUnknown) || errors.As(err, &certHost) {
		return &ConnError{Refused, fmt.Sprintf("can't trust %s: %v", host, err), err}
	}
	switch {
	case errors.Is(err, syscall.ECONNREFUSED):
		return &ConnError{RemoteOff, fmt.Sprintf("%s is on, but nothing is serving Todos there: turn on Remote Access in Todos on the Mac", host), err}
	case interrupted(err):
		return &ConnError{Interrupted, fmt.Sprintf("the connection to %s dropped", host), err}
	case timedOut(err), errors.Is(err, syscall.EHOSTUNREACH), errors.Is(err, syscall.ENETUNREACH), errors.Is(err, syscall.EHOSTDOWN):
		return &ConnError{Unreachable, fmt.Sprintf("can't reach %s: the Mac is asleep, offline or off the tailnet (todos can't wake it)", host), err}
	}
	return &ConnError{Unreachable, fmt.Sprintf("can't reach %s: %v", host, err), err}
}

func timedOut(err error) bool {
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, os.ErrDeadlineExceeded) || errors.Is(err, syscall.ETIMEDOUT) {
		return true
	}
	var ne net.Error
	return errors.As(err, &ne) && ne.Timeout()
}

func interrupted(err error) bool {
	return errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, syscall.ECONNRESET) || errors.Is(err, syscall.EPIPE) ||
		strings.Contains(err.Error(), "server closed idle connection")
}
