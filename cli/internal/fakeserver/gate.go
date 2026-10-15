package fakeserver

import (
	"io"
	"net"
	"sync"
)

// Gate stands between the command and a server, at an address of its own, and
// can be shut and opened again: a Mac going away and coming back. Shut, nothing
// listens there and a connection is refused; open, connections are passed
// through untouched, TLS and all. The address stays the same throughout.
type Gate struct {
	Addr   string // 127.0.0.1:port, to connect to instead of the server
	target string

	mu    sync.Mutex
	l     net.Listener
	conns map[net.Conn]bool
}

// NewGate opens a gate in front of target (host:port).
func NewGate(target string) (*Gate, error) {
	g := &Gate{target: target, conns: map[net.Conn]bool{}}
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	g.Addr = l.Addr().String()
	g.serve(l)
	return g, nil
}

// Open lets connections through again.
func (g *Gate) Open() error {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.l != nil {
		return nil
	}
	l, err := net.Listen("tcp", g.Addr)
	if err != nil {
		return err
	}
	g.serveLocked(l)
	return nil
}

// Shut stops listening and drops every connection passing through.
func (g *Gate) Shut() {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.l != nil {
		g.l.Close()
		g.l = nil
	}
	for c := range g.conns {
		c.Close()
		delete(g.conns, c)
	}
}

func (g *Gate) serve(l net.Listener) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.serveLocked(l)
}

func (g *Gate) serveLocked(l net.Listener) {
	g.l = l
	go func() {
		for {
			in, err := l.Accept()
			if err != nil {
				return
			}
			out, err := net.Dial("tcp", g.target)
			if err != nil {
				in.Close()
				continue
			}
			g.mu.Lock()
			if g.l != l { // shut in the meantime
				g.mu.Unlock()
				in.Close()
				out.Close()
				return
			}
			g.conns[in], g.conns[out] = true, true
			g.mu.Unlock()
			go g.pipe(in, out)
			go g.pipe(out, in)
		}
	}()
}

func (g *Gate) pipe(dst, src net.Conn) {
	_, _ = io.Copy(dst, src)
	dst.Close()
	src.Close()
	g.mu.Lock()
	delete(g.conns, dst)
	delete(g.conns, src)
	g.mu.Unlock()
}
