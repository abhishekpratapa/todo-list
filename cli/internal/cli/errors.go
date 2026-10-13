package cli

import (
	"context"
	"errors"
	"fmt"

	"charm.land/huh/v2"

	"todos/internal/api"
	"todos/internal/config"
	"todos/internal/creds"
	"todos/internal/launch"
)

// Exit codes. They are part of the command's interface: scripts test them.
const (
	ExitOK          = 0
	ExitError       = 1  // anything not listed below
	ExitUsage       = 2  // bad arguments, an ambiguous task, or input needed with no terminal to ask on
	ExitNotFound    = 3  // no such task or subtask
	ExitConflict    = 4  // the task changed since it was read
	ExitUnreachable = 5  // the Mac is asleep or offline, Tailscale is down, Remote Access is off
	ExitAuth        = 6  // the access token was rejected
	ExitStart       = 7  // Todos is not running and could not be started
	ExitVersion     = 8  // the command or the app is too old for the other
	ExitProfile     = 9  // not possible with this profile (local-only on a remote one, or no profile yet)
	ExitBusy        = 10 // rate limited or too many connections: try again later
	ExitInterrupted = 130
)

// usageError is a mistake in how the command was called.
type usageError struct{ msg string }

func (e *usageError) Error() string { return e.msg }

func usagef(format string, args ...any) error { return &usageError{fmt.Sprintf(format, args...)} }

// profileError is something this profile can't do.
type profileError struct{ msg string }

func (e *profileError) Error() string { return e.msg }

// notFoundError is a task or subtask that a name did not match.
type notFoundError struct{ msg string }

func (e *notFoundError) Error() string { return e.msg }

// exitError carries an exit code for an error that has already been reported.
type exitError struct {
	code int
	err  error
}

func (e *exitError) Error() string { return e.err.Error() }
func (e *exitError) Unwrap() error { return e.err }

// describe gives an error's exit code, a short machine-readable code, and the
// message to show.
func describe(err error) (exit int, code, message string) {
	message = err.Error()
	var (
		refused  *api.Error
		conn     *api.ConnError
		version  *api.VersionError
		start    *launch.StartError
		usage    *usageError
		profile  *profileError
		noProf   *config.NoProfileError
		notFound *notFoundError
		coded    *exitError
	)
	switch {
	case errors.As(err, &coded):
		exit, code, _ = describe(coded.err)
		return coded.code, code, message
	case errors.Is(err, context.Canceled), errors.Is(err, huh.ErrUserAborted):
		return ExitInterrupted, "cancelled", "cancelled"
	case errors.As(err, &usage):
		return ExitUsage, "usage", message
	case errors.As(err, &notFound):
		return ExitNotFound, "not_found", message
	case errors.As(err, &profile):
		return ExitProfile, "profile", message
	case errors.As(err, &noProf):
		return ExitProfile, "no_profile", message
	case errors.Is(err, creds.ErrNoToken):
		return ExitAuth, "no_token", message
	case errors.As(err, &version):
		return ExitVersion, "version", message
	case errors.As(err, &start):
		return ExitStart, "start_failed", message
	case errors.As(err, &conn):
		switch conn.Kind {
		case api.NotRunning:
			return ExitStart, "not_running", message
		case api.TailscaleDown:
			return ExitUnreachable, "tailscale_down", message
		case api.RemoteOff:
			return ExitUnreachable, "remote_off", message
		case api.AppDown:
			return ExitUnreachable, "app_down", message
		}
		return ExitUnreachable, "unreachable", message
	case errors.As(err, &refused):
		code = refused.Code
		switch {
		case refused.Status == 404:
			return ExitNotFound, code, message
		case refused.Status == 409, refused.Status == 428:
			return ExitConflict, code, "the task changed while this was being done, so nothing was changed: look at it again and retry (" + message + ")"
		case refused.Status == 401:
			return ExitAuth, code, "the access token was rejected: it has been rotated on the Mac. Run `todos pair` again with the new one"
		case refused.Status == 403 && refused.Code == "forbidden_user":
			return ExitAuth, code, "this machine's Tailscale account is not the Mac owner's, and Todos only answers its owner"
		case refused.Status == 403:
			return ExitAuth, code, message
		case refused.Status == 429:
			if refused.RetryAfter > 0 {
				message = fmt.Sprintf("%s (try again in %ds)", message, refused.RetryAfter)
			}
			return ExitBusy, code, message
		case refused.Status == 503:
			return ExitBusy, code, message
		case refused.Status >= 400 && refused.Status < 500:
			return ExitUsage, code, message
		}
		return ExitError, code, message
	}
	return ExitError, "error", message
}
