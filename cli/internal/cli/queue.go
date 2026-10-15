package cli

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"todos/internal/api"
	"todos/internal/config"
	"todos/internal/launch"
	"todos/internal/out"
	"todos/internal/queue"
)

// Changes made while the Mac can't be reached.
//
// On a paired profile, a change that only adds (a task from one line; done,
// a comment or subtasks on a task given by its number) is saved when Todos
// can't be reached, and sent when it can: first thing in the next command that
// reaches it, and meanwhile by a sender left running in the background. Each
// keeps the key it was made with, so the app applies it once however often it
// arrives. On this Mac there is nothing to wait for: the app is started.

const (
	// How long the background sender keeps trying. After that, the next
	// command that reaches Todos sends what is left.
	senderLifetime = 24 * time.Hour
	// How long it waits between tries: doubling from the first to the last.
	senderFirstRetry = 2 * time.Second
	senderMaxRetry   = time.Minute
)

// queueMode is TODOS_QUEUE: "on" (the default) saves changes that can't be
// sent and leaves a sender in the background; "manual" saves them for the next
// command to send; "off" saves nothing, and the command fails as it would
// without a queue.
func (a *App) queueMode() string {
	switch m := strings.ToLower(a.Getenv("TODOS_QUEUE")); m {
	case "off", "manual":
		return m
	}
	return "on"
}

func (a *App) queueFor(profile string) *queue.Queue { return queue.For(a.configDir(), profile) }

// canWait says whether err means the change could be made later: Todos
// couldn't be reached, or the connection dropped. Not a refusal, a token or a
// certificate, which waiting won't mend.
func canWait(err error) bool {
	return api.IsConn(err, api.Unreachable, api.TailscaleDown, api.RemoteOff, api.AppDown, api.Interrupted)
}

// tryLater says whether whatever stopped a send may pass by itself: as
// canWait, or the app being busy, or another command sending.
func tryLater(err error) bool {
	var e *api.Error
	return canWait(err) || errors.Is(err, queue.ErrBusy) ||
		(errors.As(err, &e) && (e.Status == 429 || e.Status == 502 || e.Status == 503 || e.Status == 504))
}

// offline is the queue to save a change in, when err says Todos can't be
// reached on a paired profile and saving is on.
func (a *App) offline(err error) (*queue.Queue, *config.Resolved, bool) {
	if a.queueMode() == "off" || !canWait(err) {
		return nil, nil, false
	}
	_, res, rerr := a.resolve()
	if rerr != nil || res.Local {
		return nil, nil, false
	}
	return a.queueFor(res.Name), res, true
}

// change is one change a command makes that can wait for the Mac.
type change struct {
	ref  string                  // the task as typed; "" for a change that names none (an add)
	item func(id int) queue.Item // the change, made to the task with that id
}

// sendOrSave makes changes in order. When Todos can't be reached, at the
// start or partway, the changes not yet made are saved and sent when it can be.
func (a *App) sendOrSave(ctx context.Context, changes []change) error {
	made := time.Now()
	s, err := a.connect(ctx)
	if err != nil {
		return a.saveOrFail(ctx, err, changes, made)
	}
	a.p().Today = a.today(ctx, s)
	for i, ch := range changes {
		id := 0
		if ch.ref != "" {
			if id, err = a.taskID(ctx, s, ch.ref); err != nil {
				if canWait(err) {
					return a.saveOrFail(ctx, err, changes[i:], made)
				}
				return err
			}
		}
		it := ch.item(id)
		it.Made, it.Key = made, api.NewKey()
		// Sent now, a line is read as of now, as it always has been: no "at",
		// which a Mac whose clock is behind this one's could turn down.
		now := it
		now.Made = time.Time{}
		req, err := now.Change()
		if err != nil {
			return err
		}
		res, err := s.Client.Send(ctx, req)
		if err != nil {
			if canWait(err) {
				// It may have arrived. Saved with the same key, it won't be made twice.
				rest := append([]change{{item: func(int) queue.Item { return it }}}, changes[i+1:]...)
				return a.saveOrFail(ctx, err, rest, made)
			}
			return err
		}
		if err := a.result(it.Verb(), res, len(changes) > 1); err != nil {
			return err
		}
	}
	return nil
}

// saveOrFail saves changes Todos wasn't there for, if they can wait. If not,
// the reason it wasn't there is the error.
func (a *App) saveOrFail(ctx context.Context, why error, changes []change, made time.Time) error {
	q, res, ok := a.offline(why)
	if !ok {
		return why
	}
	items := make([]queue.Item, 0, len(changes))
	for _, ch := range changes {
		id := 0
		if ch.ref != "" {
			m := idRE.FindStringSubmatch(strings.TrimSpace(ch.ref))
			if m == nil {
				return fmt.Errorf("%w. A change made while Todos can't be reached is saved for later only for a task named by its number, not %q", why, ch.ref)
			}
			id, _ = strconv.Atoi(m[1])
		}
		it := ch.item(id)
		if it.Key == "" {
			it.Made, it.Key = made, api.NewKey()
		}
		it.URL = res.Profile.URL
		items = append(items, it)
	}
	saved, err := q.Add(ctx, items)
	if err != nil {
		return fmt.Errorf("%w (and saving the change for later failed: %v)", why, err)
	}
	a.startSender(res.Name)

	p := a.p()
	switch {
	case a.json:
		for _, it := range saved {
			v := map[string]any{"queued": it}
			if len(saved) > 1 {
				if err := p.Line(v); err != nil {
					return err
				}
			} else if err := p.Value(v); err != nil {
				return err
			}
		}
	case p.Styled:
		for _, it := range saved {
			p.Saved(it.Describe())
		}
		p.Note("%s. It will be sent when Todos answers: `todos queue` lists what is waiting", why.Error())
	default:
		fmt.Fprintf(a.Err, "todos: %s: saved %s to send when Todos answers (`todos queue` lists what is waiting)\n", why.Error(), count(len(saved), "change"))
	}
	return nil
}

func count(n int, thing string) string {
	if n == 1 {
		return "1 " + thing
	}
	return fmt.Sprintf("%d %ss", n, thing)
}

// startSender leaves a sender running in the background, which sends the
// profile's changes once Todos can be reached. If one is running already, the
// new one sees that and stops.
func (a *App) startSender(profile string) {
	if a.queueMode() != "on" || a.Exe == "" {
		return
	}
	detach := a.Spawn
	if detach == nil {
		detach = launch.Detach
	}
	_ = detach([]string{a.Exe, "queue", "send", "--background", "--profile", profile})
}

// sent is a change from the queue that has been made, and what it made.
type sent struct {
	item queue.Item
	res  *api.TaskResult
}

// sendReport is what a pass through the queue did.
type sendReport struct {
	sent    []sent
	refused []queue.Item // turned down by the app this time
	err     error        // why sending stopped before the end, if it did
}

// sendWaiting sends the profile's waiting changes, oldest first, waiting up to
// `wait` for another command that is sending them. One the app turns down is
// marked so, and stays in the queue until it is removed; the rest go on.
// Anything that would stop the rest too (the connection, the token, a busy
// app) stops there, and what is left waits for next time. It never sleeps
// holding the lock: a caller that wants to wait for a busy app does so after.
func (a *App) sendWaiting(ctx context.Context, s *Session, q *queue.Queue, wait time.Duration) sendReport {
	var r sendReport
	unlock, err := q.Lock(ctx, "send", wait)
	if err != nil {
		r.err = err
		return r
	}
	defer unlock()
	items, err := q.List()
	if err != nil {
		r.err = err
		return r
	}
	refuse := func(it queue.Item, refusal queue.Refusal) error {
		if err := q.Refuse(ctx, it, refusal); err != nil {
			return err
		}
		it.Refused = &refusal
		r.refused = append(r.refused, it)
		return nil
	}
	for _, listed := range items {
		// Read again: it may have been removed (`todos queue rm`) since.
		it, ok, err := q.Get(listed.ID)
		if err != nil || !ok || it.Key != listed.Key || !it.Waiting() {
			continue
		}
		if it.URL != s.Profile.Profile.URL {
			if r.err = refuse(it, queue.Refusal{Message: fmt.Sprintf("it was saved for %s, and the %q profile now reaches %s", it.URL, s.Profile.Name, s.Profile.Profile.URL), At: time.Now()}); r.err != nil {
				return r
			}
			continue
		}
		req, err := it.Change()
		if err != nil {
			continue // saved by a newer todos command, which can send it
		}
		res, err := s.Client.Send(ctx, req)
		if inTheFuture(err) && req.Body["at"] != nil {
			// This machine's clock is ahead of the Mac's, by more than the app
			// allows. The line was typed moments ago by the Mac's clock, so it
			// is read as of now (the key is the same, so it is still made once).
			delete(req.Body, "at")
			res, err = s.Client.Send(ctx, req)
		}
		var refused *api.Error
		switch {
		case err == nil:
			if err := q.Sent(ctx, it); err != nil {
				r.err = err
				return r
			}
			r.sent = append(r.sent, sent{it, res})
		case errors.As(err, &refused) && turnedDown(refused.Status):
			refusal := queue.Refusal{Status: refused.Status, Code: refused.Code, Message: refused.Error(), At: time.Now()}
			if refused.Status == http.StatusNotFound && it.Task > 0 {
				refusal.Message = fmt.Sprintf("task #%d is no longer there", it.Task)
			}
			if r.err = refuse(it, refusal); r.err != nil {
				return r
			}
		default:
			r.err = err
			return r
		}
	}
	return r
}

// turnedDown says whether a refusal is about the change itself, so sending it
// again would only be refused again.
func turnedDown(status int) bool {
	switch status {
	case 400, 404, 409, 410, 412, 413, 415, 422, 428:
		return true
	}
	return false
}

// inTheFuture says whether the app refused a line's "at" for being ahead of
// its own clock (src/api-v1.js, capturedAt).
func inTheFuture(err error) bool {
	var e *api.Error
	return errors.As(err, &e) && e.Status == http.StatusBadRequest && strings.Contains(e.Message, "in the future")
}

// retryAfter is how long the app asked to be left alone, if it did.
func retryAfter(err error) time.Duration {
	var e *api.Error
	if errors.As(err, &e) && e.Status == http.StatusTooManyRequests {
		return time.Duration(min(max(e.RetryAfter, 1), 60)) * time.Second
	}
	return 0
}

// sendOnConnect sends what is waiting before a command does its own work, so
// what it reads or changes comes after. It says what it sent on a terminal,
// what the app turned down wherever it can, and why it couldn't send the rest.
// Whatever is left goes in the background.
func (a *App) sendOnConnect(ctx context.Context, s *Session) {
	q := a.queueFor(s.Profile.Name)
	waiting, refusedBefore := q.Count()
	if waiting > 0 {
		r := a.sendWaiting(ctx, s, q, 10*time.Second)
		a.reportSent(r)
		if r.err != nil {
			left, _ := q.Count()
			if tryLater(r.err) {
				a.startSender(s.Profile.Name)
			}
			if !a.json && (a.ErrTTY || !tryLater(r.err)) {
				_, _, why := describe(r.err)
				if errors.Is(r.err, queue.ErrBusy) {
					why = "another todos command is sending them"
				}
				fmt.Fprintf(a.Err, "todos: %s saved while Todos couldn't be reached %s still waiting: %s\n", count(left, "change"), either(left, "is", "are"), why)
			}
		}
	}
	if refusedBefore > 0 && a.ErrTTY && !a.json {
		fmt.Fprintf(a.Err, "todos: %s saved while Todos couldn't be reached %s turned down: see `todos queue`\n",
			count(refusedBefore, "change"), either(refusedBefore, "was", "were"))
	}
}

// either picks the word that goes with n.
func either(n int, one, many string) string {
	if n == 1 {
		return one
	}
	return many
}

// reportSent says on standard error what a pass through the queue did, for a
// command whose own output is something else.
func (a *App) reportSent(r sendReport) {
	if a.json {
		return
	}
	if len(r.sent) > 0 && a.ErrTTY {
		p := a.errPrinter()
		fmt.Fprintf(p.W, "Sent %s saved while Todos couldn't be reached:\n", count(len(r.sent), "change"))
		for _, s := range r.sent {
			p.Changed(s.item.Verb(), &s.res.Task)
		}
	}
	for _, it := range r.refused {
		fmt.Fprintf(a.Err, "todos: Todos turned down a change saved while it couldn't be reached: %s: %s. It stays in the queue until removed (`todos queue rm %d`)\n",
			it.Describe(), it.Refused.Message, it.ID)
	}
}

// errPrinter prints to standard error, for lines that aren't the command's result.
func (a *App) errPrinter() *out.Printer {
	return &out.Printer{W: a.colorOut(a.Err, a.ErrTTY), Styled: a.ErrTTY && !a.json, Width: a.Width, Dark: a.dark(), Today: time.Now().Format("2006-01-02")}
}

// queueNote is added to the message of a command that failed because Todos
// couldn't be reached, when changes are waiting for it.
func (a *App) queueNote(err error) string {
	if !canWait(err) {
		return ""
	}
	_, res, rerr := a.resolve()
	if rerr != nil || res.Local {
		return ""
	}
	if waiting, _ := a.queueFor(res.Name).Count(); waiting > 0 {
		return fmt.Sprintf(" (%s saved for later %s waiting to be sent: `todos queue`)", count(waiting, "change"), either(waiting, "is", "are"))
	}
	return ""
}

// ---------- todos queue ----------

func (a *App) queueCmd() *cobra.Command {
	// The queue of the profile in use. It is read without connecting.
	current := func() (*queue.Queue, *config.Resolved, error) {
		_, res, err := a.resolve()
		if err != nil {
			return nil, nil, err
		}
		return a.queueFor(res.Name), res, nil
	}
	list := func(cmd *cobra.Command, _ []string) error {
		q, res, err := current()
		if err != nil {
			return err
		}
		items, err := q.List()
		if err != nil {
			return err
		}
		if res.Local {
			items = nil
		}
		p := a.p()
		if a.json {
			if items == nil {
				items = []queue.Item{}
			}
			return p.Value(map[string]any{"profile": res.Name, "changes": items, "setAside": q.SetAside()})
		}
		if p.Styled && res.Local {
			fmt.Fprintln(p.W, "The local profile reaches Todos on this Mac directly, so nothing is ever saved for later.")
			return nil
		}
		p.Queue(items)
		if n := q.SetAside(); n > 0 {
			fmt.Fprintf(a.Err, "todos: %s in %s couldn't be read as changes and %s set aside (named *.unreadable)\n", count(n, "file"), a.tildify(q.Dir), either(n, "was", "were"))
		}
		return nil
	}
	cmd := &cobra.Command{
		Use:   "queue",
		Short: "Changes saved while Todos couldn't be reached",
		Long: "On a paired profile, when the Mac can't be reached (asleep, offline, off the\n" +
			"tailnet), these changes are saved and sent once it can be:\n\n" +
			"  todos add \"<line>\"         read as of when you typed it, so \"tomorrow\" is the\n" +
			"                             day after you typed it\n" +
			"  todos done <number>        also with -m\n" +
			"  todos comment <number> …\n" +
			"  todos sub add <number> …\n\n" +
			"A task must be named by its number: its title can't be looked up offline.\n" +
			"What is saved goes first thing in the next command that reaches Todos, and\n" +
			"meanwhile a sender in the background tries every so often, for a day after\n" +
			"the newest change was saved\n" +
			"(TODOS_QUEUE=manual leaves it to the next command; TODOS_QUEUE=off saves\n" +
			"nothing and fails instead). A change the app turns down (a task deleted in the\n" +
			"meantime, say) stays here, marked, until you remove it.\n\n" +
			"With --json: {\"profile\": \"\", \"changes\": [...]}.",
		Example: "todos queue\ntodos queue send\ntodos queue rm 2",
		Args:    noArgs,
		RunE:    list,
	}
	cmd.AddCommand(&cobra.Command{Use: "ls", Short: "List the changes waiting to be sent", Args: noArgs, RunE: list})

	var wait, background bool
	send := &cobra.Command{
		Use:   "send",
		Short: "Send the waiting changes now",
		Long: "Send the waiting changes now, oldest first. With --wait, keep trying until\n" +
			"Todos can be reached and everything has gone (for a day at most).\n\n" +
			"With --json, one object a line: {\"sent\": {...}, \"task\": {...}, \"next\": ...} for\n" +
			"a change made, {\"refused\": {...}} for one the app turned down.",
		Example: "todos queue send\ntimeout 600 todos queue send --wait",
		Args:    noArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if background {
				return a.sendInBackground(cmd.Context())
			}
			q, res, err := current()
			if err != nil {
				return err
			}
			if res.Local {
				return a.queueSent(nil, sendReport{})
			}
			deadline := time.Now().Add(senderLifetime)
			delay := senderFirstRetry
			var all sendReport
			for {
				s, err := a.connect(cmd.Context(), connectOptions{noFlush: true})
				if err == nil {
					r := a.sendWaiting(cmd.Context(), s, q, 30*time.Second)
					all.sent, all.refused = append(all.sent, r.sent...), append(all.refused, r.refused...)
					if err = r.err; err == nil {
						return a.queueSent(q, all)
					}
				}
				pause := max(delay, retryAfter(err))
				if !wait || !tryLater(err) || time.Now().Add(pause).After(deadline) {
					if perr := a.queueSent(nil, all); perr != nil {
						return perr
					}
					return err
				}
				select {
				case <-cmd.Context().Done():
					return cmd.Context().Err()
				case <-time.After(pause):
				}
				delay = min(delay*2, senderMaxRetry)
			}
		},
	}
	send.Flags().BoolVar(&wait, "wait", false, "keep trying until Todos can be reached (for a day at most)")
	send.Flags().BoolVar(&background, "background", false, "")
	_ = send.Flags().MarkHidden("background")
	cmd.AddCommand(send)

	var everything bool
	rm := &cobra.Command{
		Use:   "rm <number>... | --all",
		Short: "Remove changes from the queue, unsent",
		Args: func(cmd *cobra.Command, args []string) error {
			if everything != (len(args) == 0) {
				return usagef("which changes? Give their numbers (as `todos queue` shows them), or --all")
			}
			return nil
		},
		RunE: func(cmd *cobra.Command, args []string) error {
			q, _, err := current()
			if err != nil {
				return err
			}
			// Not while they are being sent: what is removed must not go.
			unlock, err := q.Lock(cmd.Context(), "send", 30*time.Second)
			if errors.Is(err, queue.ErrBusy) {
				return errors.New("the queue is being sent right now, so nothing was removed: see what is left with `todos queue`")
			}
			if err != nil {
				return err
			}
			defer unlock()
			var ids []int
			if everything {
				items, err := q.List()
				if err != nil {
					return err
				}
				for _, it := range items {
					ids = append(ids, it.ID)
				}
			}
			for _, arg := range args {
				id, ok := queue.ParseID(arg)
				if !ok {
					return usagef("%q is not a number from `todos queue`", arg)
				}
				ids = append(ids, id)
			}
			for _, id := range ids {
				removed, err := q.Remove(id)
				if err != nil {
					return err
				}
				if !removed && !everything {
					return &notFoundError{fmt.Sprintf("nothing in the queue is number %d (it may have been sent): see `todos queue`", id)}
				}
				if a.styled() {
					fmt.Fprintf(a.Out, "Removed %d\n", id)
				}
			}
			return nil
		},
	}
	rm.Flags().BoolVar(&everything, "all", false, "remove every change in the queue")
	cmd.AddCommand(rm)
	return cmd
}

// queueSent prints what `todos queue send` did, and what is still waiting.
func (a *App) queueSent(q *queue.Queue, r sendReport) error {
	p := a.p()
	for _, s := range r.sent {
		if a.json {
			if err := p.Line(map[string]any{"sent": s.item, "task": s.res.Task, "next": s.res.Next}); err != nil {
				return err
			}
			continue
		}
		p.Changed(s.item.Verb(), &s.res.Task)
	}
	for _, it := range r.refused {
		switch {
		case a.json:
			if err := p.Line(map[string]any{"refused": it}); err != nil {
				return err
			}
		case p.Styled:
			p.TurnedDown(it.Describe(), it.Refused.Message)
		default:
			fmt.Fprintf(a.Err, "todos: Todos turned down %s: %s (`todos queue rm %d` removes it)\n", it.Describe(), it.Refused.Message, it.ID)
		}
	}
	if q == nil || !p.Styled {
		return nil
	}
	switch waiting, refused := q.Count(); {
	case len(r.sent) == 0 && len(r.refused) == 0 && waiting == 0 && refused == 0:
		fmt.Fprintln(p.W, "Nothing is waiting to be sent.")
	case refused > 0:
		p.Note("%s turned down: `todos queue` shows why, and `todos queue rm` removes them", count(refused, "change"))
	}
	return nil
}

// sendable says whether anything waiting can be sent by this command (not
// changes saved by a newer one, of a kind it doesn't know, which it would
// otherwise try for ever), and when the newest of them was saved.
func sendable(q *queue.Queue) (bool, time.Time) {
	items, _ := q.List()
	var any bool
	var newest time.Time
	for _, it := range items {
		if _, err := it.Change(); it.Waiting() && err == nil {
			any = true
			if it.Made.After(newest) {
				newest = it.Made
			}
		}
	}
	return any, newest
}

// sendInBackground is the sender left running when a change is saved. It tries
// until Todos can be reached and everything has gone, waiting longer between
// tries each time, until a day after the newest change was saved. Only one
// runs per profile. It says nothing (nobody is there to read it): what the app
// turns down stays in the queue, where the next command mentions it.
func (a *App) sendInBackground(ctx context.Context) error {
	_, res, err := a.resolve()
	if err != nil || res.Local {
		return nil
	}
	q := a.queueFor(res.Name)
	// A moment's wait, in case the sender holding it has just found nothing
	// left and is stopping: then this one sends what was saved since.
	unlock, err := q.Lock(ctx, "waiter", 2*time.Second)
	if err != nil {
		return nil // another sender is at it
	}
	defer unlock()
	delay := senderFirstRetry
	for {
		more, newest := sendable(q)
		if !more || q.Gone() {
			return nil
		}
		s, err := a.connect(ctx, connectOptions{noStart: true})
		if err == nil {
			r := a.sendWaiting(ctx, s, q, 30*time.Second)
			s.Client.Close()
			if err = r.err; err == nil && len(r.sent)+len(r.refused) > 0 {
				continue // anything saved during the pass goes now
			}
			if err == nil {
				err = queue.ErrBusy // nothing it could do: wait, rather than go round at once
			}
		}
		if !tryLater(err) || time.Now().After(newest.Add(senderLifetime)) {
			return nil // the token, a version, the profile: the next command says what
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(max(delay, retryAfter(err))):
		}
		delay = min(delay*2, senderMaxRetry)
	}
}
