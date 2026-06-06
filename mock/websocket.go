package main

// websocket.go — minimal RFC 6455 WebSocket test endpoints (feature 32).
//
// Implemented with the standard library only (no gorilla/websocket) to keep the
// mock module dependency-free, matching graphql.go / auth.go. We hijack the TCP
// connection after the HTTP handshake and hand-roll just enough framing to echo
// messages, answer pings, push server-initiated frames and honor close — which
// is everything the wurl WebSocket client needs to exercise.
//
// Endpoints (registered from server.go):
//
//	/ws, /ws/echo  echo every text/binary frame back; reply pong to ping; echo close
//	/ws/time       push a timestamped JSON frame once per second (also echoes client frames)
//	/ws/reject     refuse the upgrade with 401 (handshake-failure testing)

import (
	"bufio"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// wsGUID is the RFC 6455 magic value concatenated with Sec-WebSocket-Key to
// compute the Sec-WebSocket-Accept handshake response.
const wsGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

// WebSocket frame opcodes (RFC 6455 §5.2).
const (
	opContinuation = 0x0
	opText         = 0x1
	opBinary       = 0x2
	opClose        = 0x8
	opPing         = 0x9
	opPong         = 0xA
)

// wsMaxPayload caps a single inbound frame so a malformed/huge length can't
// exhaust memory; mirrors maxEchoBody on the /echo endpoint.
const wsMaxPayload = 16 << 20 // 16 MiB

// registerWebsocketRoutes wires the WebSocket endpoints onto the default mux.
func registerWebsocketRoutes() {
	http.HandleFunc("/ws", wsEchoHandler)
	http.HandleFunc("/ws/echo", wsEchoHandler)
	http.HandleFunc("/ws/time", wsTimeHandler)
	http.HandleFunc("/ws/reject", wsRejectHandler)
}

// wsRejectHandler deliberately refuses the upgrade so clients can exercise
// handshake-failure handling (the wurl console surfaces this as an error status).
func wsRejectHandler(w http.ResponseWriter, _ *http.Request) {
	http.Error(w, "websocket upgrade rejected", http.StatusUnauthorized)
}

// wsEchoHandler upgrades and then echoes every data frame back to the sender,
// answering pings with pongs and reflecting the peer's close frame.
func wsEchoHandler(w http.ResponseWriter, r *http.Request) {
	conn, brw, err := wsUpgrade(w, r)
	if err != nil {
		return
	}
	defer conn.Close()

	var fragOp byte
	var frag []byte
	for {
		fin, op, payload, err := readFrame(brw.Reader)
		if err != nil {
			return
		}
		switch op {
		case opPing:
			if writeFrame(conn, opPong, payload) != nil {
				return
			}
		case opPong:
			// no-op
		case opClose:
			_ = writeFrame(conn, opClose, payload) // echo the close (code+reason)
			return
		case opText, opBinary:
			if fin {
				if writeFrame(conn, op, payload) != nil {
					return
				}
			} else {
				fragOp = op
				frag = append(frag[:0], payload...)
			}
		case opContinuation:
			frag = append(frag, payload...)
			if fin {
				if writeFrame(conn, fragOp, frag) != nil {
					return
				}
				frag = nil
			}
		}
	}
}

// wsTimeHandler pushes a timestamped JSON text frame once per second so the
// client can observe received-without-send traffic. A reader goroutine still
// echoes client frames and handles ping/close; a mutex serialises the two
// writers so frames never interleave on the wire.
func wsTimeHandler(w http.ResponseWriter, r *http.Request) {
	conn, brw, err := wsUpgrade(w, r)
	if err != nil {
		return
	}
	defer conn.Close()

	var mu sync.Mutex
	write := func(op byte, payload []byte) error {
		mu.Lock()
		defer mu.Unlock()
		return writeFrame(conn, op, payload)
	}

	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			_, op, payload, err := readFrame(brw.Reader)
			if err != nil {
				return
			}
			switch op {
			case opClose:
				_ = write(opClose, payload)
				return
			case opPing:
				_ = write(opPong, payload)
			case opText, opBinary:
				_ = write(op, payload) // echo client frames too
			}
		}
	}()

	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	seq := 0
	for {
		select {
		case <-done:
			return
		case t := <-ticker.C:
			seq++
			msg := fmt.Sprintf(`{"type":"time","seq":%d,"ts":%q}`,
				seq, t.UTC().Format(time.RFC3339))
			if write(opText, []byte(msg)) != nil {
				return
			}
		}
	}
}

// wsUpgrade validates the handshake, hijacks the connection, and writes the 101
// response (echoing the first requested subprotocol). On any failure it has
// already written an HTTP error and returns a non-nil error.
func wsUpgrade(w http.ResponseWriter, r *http.Request) (net.Conn, *bufio.ReadWriter, error) {
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") ||
		!strings.Contains(strings.ToLower(r.Header.Get("Connection")), "upgrade") {
		http.Error(w, "expected websocket upgrade", http.StatusBadRequest)
		return nil, nil, fmt.Errorf("not a websocket upgrade")
	}
	key := r.Header.Get("Sec-WebSocket-Key")
	if key == "" {
		http.Error(w, "missing Sec-WebSocket-Key", http.StatusBadRequest)
		return nil, nil, fmt.Errorf("missing Sec-WebSocket-Key")
	}
	hj, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "hijack unsupported", http.StatusInternalServerError)
		return nil, nil, fmt.Errorf("hijack unsupported")
	}
	conn, brw, err := hj.Hijack()
	if err != nil {
		return nil, nil, err
	}

	sum := sha1.Sum([]byte(key + wsGUID))
	accept := base64.StdEncoding.EncodeToString(sum[:])

	var b strings.Builder
	b.WriteString("HTTP/1.1 101 Switching Protocols\r\n")
	b.WriteString("Upgrade: websocket\r\n")
	b.WriteString("Connection: Upgrade\r\n")
	b.WriteString("Sec-WebSocket-Accept: " + accept + "\r\n")
	if proto := firstSubprotocol(r.Header.Get("Sec-WebSocket-Protocol")); proto != "" {
		b.WriteString("Sec-WebSocket-Protocol: " + proto + "\r\n")
	}
	b.WriteString("\r\n")

	if _, err := brw.WriteString(b.String()); err != nil {
		conn.Close()
		return nil, nil, err
	}
	if err := brw.Flush(); err != nil {
		conn.Close()
		return nil, nil, err
	}
	return conn, brw, nil
}

// firstSubprotocol returns the first non-empty token from a Sec-WebSocket-Protocol
// header value, or "" when none were requested.
func firstSubprotocol(header string) string {
	for _, p := range strings.Split(header, ",") {
		if p = strings.TrimSpace(p); p != "" {
			return p
		}
	}
	return ""
}

// readFrame reads one WebSocket frame, unmasking the (always-masked) client
// payload. It returns the FIN flag, opcode and payload bytes.
func readFrame(br *bufio.Reader) (fin bool, opcode byte, payload []byte, err error) {
	h := make([]byte, 2)
	if _, err = io.ReadFull(br, h); err != nil {
		return
	}
	fin = h[0]&0x80 != 0
	opcode = h[0] & 0x0F
	masked := h[1]&0x80 != 0
	length := int64(h[1] & 0x7F)

	switch length {
	case 126:
		ext := make([]byte, 2)
		if _, err = io.ReadFull(br, ext); err != nil {
			return
		}
		length = int64(binary.BigEndian.Uint16(ext))
	case 127:
		ext := make([]byte, 8)
		if _, err = io.ReadFull(br, ext); err != nil {
			return
		}
		length = int64(binary.BigEndian.Uint64(ext))
	}
	if length < 0 || length > wsMaxPayload {
		err = fmt.Errorf("frame too large: %d", length)
		return
	}

	var mask []byte
	if masked {
		mask = make([]byte, 4)
		if _, err = io.ReadFull(br, mask); err != nil {
			return
		}
	}
	payload = make([]byte, length)
	if _, err = io.ReadFull(br, payload); err != nil {
		return
	}
	if masked {
		for i := range payload {
			payload[i] ^= mask[i%4]
		}
	}
	return
}

// writeFrame writes a single unmasked server frame (FIN set) with the given
// opcode and payload.
func writeFrame(conn net.Conn, opcode byte, payload []byte) error {
	b0 := byte(0x80) | (opcode & 0x0F)
	n := len(payload)

	var header []byte
	switch {
	case n < 126:
		header = []byte{b0, byte(n)}
	case n < 65536:
		header = []byte{b0, 126, byte(n >> 8), byte(n)}
	default:
		header = make([]byte, 10)
		header[0] = b0
		header[1] = 127
		binary.BigEndian.PutUint64(header[2:], uint64(n))
	}

	if _, err := conn.Write(header); err != nil {
		return err
	}
	if n > 0 {
		if _, err := conn.Write(payload); err != nil {
			return err
		}
	}
	return nil
}
